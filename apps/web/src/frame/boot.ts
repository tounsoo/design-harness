import { OVERLAY_ATTRIBUTE, collectSnapshot } from "./collect";
import { installDeterminism } from "./determinism";
import { PROTOCOL, clip, readParentMessage, type FrameMessage, type FrameStage, type HighlightRequest, type RedrawRequest, type RenderRequest } from "../runtime/protocol";
import { MAX_FRAME_TAGS } from "../runtime/tags";
import { tagsIn } from "./tags";
import type { PageProps } from "./kit";
import type { SpecPage, specPage } from "./spec";

/**
 * The frame's boot script: a classic script inlined in every frame's
 * document. It listens only to its parent and only on its channel, builds an
 * import map from the modules the app sends (blob URLs for code, URLs as
 * they are), imports the page kit and the page, renders the page in the
 * default shell, waits for the layout to settle, and sends back a snapshot of
 * what was painted. The frame renders once: a new prototype revision gets a
 * new document, so no state, module or import map carries over. A spec page
 * may be redrawn in place with a draft spec, which is shown and never
 * measured. When asked, it also says which element tags it drew
 * (`runtime/tags.ts`), and outlines a finding's elements by their tags.
 */

type Kit = {
  mount: (container: HTMLElement, Page: unknown, props: PageProps, type: RenderRequest["pageType"], onLateError: (error: Error) => void) => Promise<void>;
  Slot: Parameters<typeof specPage>[1];
};

const PAGE_KIT = "@design-harness/page";
/** The spec renderer: json-render's Renderer with a registry built from the library. Only a spec page imports it. */
const SPEC_RENDERER = "@design-harness/spec";
// Real time for the boot script's own waiting, taken before the page's clock is fixed.
const now = performance.now.bind(performance);
installDeterminism(globalThis);
const root = document.documentElement;
const channel = root.dataset.channel ?? "";
const parentOrigin = root.dataset.parentOrigin ?? "";
// The import map is an inline script, so it needs the document's nonce. Read before any prototype code runs.
const nonce = (document.currentScript as HTMLScriptElement | null)?.nonce ?? "";
// The channel lives on only in this closure: prototype code cannot read it from the DOM to speak for the frame.
root.removeAttribute("data-channel");
root.removeAttribute("data-parent-origin");

let started = false;
let generation = -1;
/** A spec page's in-place redraw, once it has rendered; null for a TSX page. */
let redraw: ((payload: RedrawRequest["spec"]) => void) | null = null;
let nodes: readonly Element[] = [];
/** Whether this frame finds element tags: the render request says. */
let tagging = false;
let runtimeError: Error | null = null;

function post(message: FrameMessage): void {
  window.parent.postMessage(message, parentOrigin);
}

function fail(stage: FrameStage, error: unknown): void {
  const text = error instanceof Error ? `${error.name === "Error" ? "" : `${error.name}: `}${error.message}` : String(error);
  post({ protocol: PROTOCOL, type: "error", channel, generation, stage, message: clip(text || "unknown error") });
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function addStyles(request: RenderRequest): Promise<unknown> {
  return Promise.all(
    request.styles.map((style) => {
      if ("css" in style) {
        const element = document.createElement("style");
        element.textContent = style.css;
        document.head.append(element);
        return Promise.resolve();
      }
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = style.url;
      const loaded = new Promise<void>((resolve, reject) => {
        link.onload = () => resolve();
        link.onerror = () => reject(new Error(`the stylesheet ${style.url} did not load`));
      });
      document.head.append(link);
      return loaded;
    }),
  );
}

function addImportMap(request: RenderRequest): void {
  const imports: Record<string, string> = {};
  for (const [specifier, source] of Object.entries(request.modules)) {
    imports[specifier] = "url" in source ? source.url : URL.createObjectURL(new Blob([source.code], { type: "text/javascript" }));
  }
  const map = document.createElement("script");
  map.type = "importmap";
  map.nonce = nonce;
  map.textContent = JSON.stringify({ imports });
  document.head.append(map);
}

/**
 * Waits until the page stops changing: web fonts loaded, images decoded, and
 * no DOM mutation for three checks in a row 50 ms apart. Timers, not
 * animation frames, since a browser may throttle frames in an iframe that is
 * off screen. Returns false when the page was still changing at `maxMs`.
 */
async function settle(maxMs: number): Promise<boolean> {
  const deadline = now() + maxMs;
  const left = () => Math.max(0, deadline - now());
  await Promise.race([document.fonts.ready, wait(left())]);
  const images = [...document.images].map((image) => (image.complete ? Promise.resolve() : image.decode().catch(() => undefined)));
  await Promise.race([Promise.all(images), wait(left())]);
  let changed = false;
  const observer = new MutationObserver(() => {
    changed = true;
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  let quiet = 0;
  while (quiet < 3 && now() < deadline) {
    changed = false;
    await wait(50);
    quiet = changed ? 0 : quiet + 1;
  }
  observer.disconnect();
  return quiet >= 3;
}

async function render(request: RenderRequest): Promise<void> {
  generation = request.generation;
  tagging = request.tags;
  const view = request.view;
  let kit: Kit;
  let Page: unknown;
  let pendingRedraw: typeof redraw = null;
  try {
    await addStyles(request);
    addImportMap(request);
    kit = (await import(/* @vite-ignore */ PAGE_KIT)) as Kit;
    if ("spec" in request.page) {
      // A spec page: the library and the spec renderer, and the spec as data. No prototype module exists to load.
      const payload = request.page.spec;
      const [renderer, library] = await Promise.all([import(/* @vite-ignore */ SPEC_RENDERER) as Promise<{ specPage: typeof specPage }>, import(/* @vite-ignore */ payload.library) as Promise<Record<string, unknown>>]);
      const page: SpecPage = renderer.specPage(library, kit.Slot, payload, request.pageType.slots, { tags: request.tags });
      Page = page;
      pendingRedraw = page.redraw;
    } else {
      const module = (await import(/* @vite-ignore */ request.page.module)) as Record<string, unknown>;
      Page = module[request.page.export];
      if (typeof Page !== "function") throw new Error(`${request.page.module.replace(/^@prototype\//, "")} has no function export "${request.page.export}"`);
    }
  } catch (error) {
    fail("load", error);
    return;
  }
  const container = document.getElementById("root");
  if (!container) return fail("render", new Error("the frame has no #root"));
  try {
    await kit.mount(container, Page, { scenario: request.scenario.id, state: request.scenario.state }, request.pageType, (error) => {
      runtimeError ??= error;
    });
  } catch (error) {
    fail("render", error);
    return;
  }
  redraw = pendingRedraw;
  const settled = await settle(request.settleMs);
  if (runtimeError) return fail("render", runtimeError);
  if (!settled) return fail("measure", new Error(`the page was still changing after ${request.settleMs} ms, so it cannot be measured the same way twice`));
  try {
    window.scrollTo(0, 0);
    const collected = collectSnapshot(document, request.scenario.id, view.name);
    nodes = collected.nodes;
    // Read after measuring, and from React's tree, not the DOM: finding them changes nothing that was measured.
    const tags = tagging ? [...tagsIn(container).keys()].sort().slice(0, MAX_FRAME_TAGS) : [];
    post({ protocol: PROTOCOL, type: "snapshot", channel, generation, snapshot: collected.snapshot, tags });
  } catch (error) {
    fail("measure", error);
  }
}

/**
 * Clears the outline, then outlines what was asked: one measured element by
 * its index in the last snapshot, or every element drawn under a finding's
 * tags, as they are in the page now. Each gets the same overlay.
 */
function highlight(request: { readonly element: number | null } | { readonly tags: readonly string[] }): void {
  document.querySelectorAll(`[${OVERLAY_ATTRIBUTE}]`).forEach((element) => element.remove());
  let targets: Element[];
  if ("tags" in request) {
    const container = document.getElementById("root");
    const drawn = tagging && container ? tagsIn(container) : new Map<string, Element[]>();
    targets = [...new Set(request.tags.flatMap((tag) => drawn.get(tag) ?? []))];
  } else {
    const one = request.element === null ? undefined : nodes[request.element];
    targets = one ? [one] : [];
  }
  targets = targets.filter((target) => target.isConnected);
  targets[0]?.scrollIntoView({ block: "center", inline: "nearest" });
  // An element that is not drawn, such as one in a closed disclosure, is outlined where it would show: its nearest drawn ancestor.
  for (const target of targets) outline(target);
}

/** The element itself when it is drawn, or else its nearest drawn ancestor, such as the closed `<details>` it is in. */
function drawnBox(target: Element): DOMRect {
  for (let element: Element | null = target; element; element = element.parentElement) {
    const box = element.getBoundingClientRect();
    if (box.width > 0 || box.height > 0) return box;
  }
  return target.getBoundingClientRect();
}

function outline(target: Element): void {
  const box = drawnBox(target);
  const overlay = document.createElement("div");
  overlay.setAttribute(OVERLAY_ATTRIBUTE, "");
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position: "absolute",
    left: `${box.left + window.scrollX - 3}px`,
    top: `${box.top + window.scrollY - 3}px`,
    width: `${box.width + 6}px`,
    height: `${box.height + 6}px`,
    // The app's critical tone, Todae's red 500, written out: a frame holds the project's library, not the app's tokens.
    outline: "3px solid oklch(0.55 0.18 25)",
    background: "oklch(0.55 0.18 25 / 0.1)",
    borderRadius: "6px",
    pointerEvents: "none",
    zIndex: "2147483647",
    boxSizing: "border-box",
  });
  document.body.append(overlay);
}

window.addEventListener("error", (event) => {
  runtimeError ??= event.error instanceof Error ? event.error : new Error(event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  runtimeError ??= event.reason instanceof Error ? event.reason : new Error(String(event.reason));
});

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const message = readParentMessage(event.data, channel);
  if (!message) return;
  if (message.type === "render") {
    if (started) return;
    started = true;
    void render(message);
  } else if (message.generation !== generation) {
    return;
  } else if (message.type === "redraw") {
    // A draft drawn in place: the outline belongs to what was measured, so it goes.
    highlight({ element: null });
    redraw?.(message.spec);
  } else {
    highlight(message satisfies HighlightRequest);
  }
});

post({ protocol: PROTOCOL, type: "ready", channel });
