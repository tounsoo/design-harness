import { checkPrototype, extractPrototype, specModel, type CheckReport, type ComponentLibrary, type PageType, type ProjectConfig, type Prototype, type PrototypeModel, type RenderedSnapshot, type Scenario, type View } from "@design-harness/core";
import { frameDocument } from "./frame-document";
import { resolvePackages, type PackageSource, type RuntimePackages } from "./package-source";
import { PROTOCOL, readFrameMessage, type FrameMessage, type FrameStage, type ModuleSource, type PageRef, type RenderRequest, type RootRef } from "./protocol";
import { SPEC_RENDERER, specParts, specPayload } from "./spec-payload";
import { tagSites } from "./tags";
import { compilePrototype, moduleSpecifier, type CompileProblem } from "./transform";

/**
 * One prototype's check loop. Each change to the config or the prototype is
 * a new revision: the source is compiled, core checks it at once without
 * snapshots (rendered rules report not-run), every frame gets a fresh
 * document for the revision, and once every frame has answered, core checks
 * it again with their snapshots. A message is only ever counted toward the
 * revision it was rendered for, so a slow frame from an earlier revision can
 * never put its snapshot into a later report.
 *
 * Nothing here decides pass or fail: the report is core's, unchanged.
 */

export type FrameKey = string;

/** The library's root part for one view: its props, with the view's scheme in its scheme prop. */
export function rootRef(library: ComponentLibrary, scheme: View["scheme"]): RootRef | undefined {
  const root = library.root;
  if (!root) return undefined;
  return { module: library.package, component: root.component, props: { ...root.props, ...(root.schemeProp ? { [root.schemeProp]: scheme } : {}) } };
}

export function frameKey(scenario: string, view: string): FrameKey {
  return `${scenario}@${view}`;
}

export type FrameSpec = {
  readonly key: FrameKey;
  readonly scenario: Scenario;
  readonly view: View;
  /** Why the frame cannot render, before it tries: its page or page type is missing. */
  readonly blocked?: string;
  readonly pageType?: PageType;
  /** A TSX page's module and export, or a spec page's resolved spec for this frame's scenario. */
  readonly page?: PageRef;
};

export type FrameState =
  | { readonly state: "waiting" }
  | { readonly state: "rendering" }
  /** `tags`: the element tags the frame drew (`tags.ts`), sorted. */
  | { readonly state: "measured"; readonly snapshot: RenderedSnapshot; readonly tags: readonly string[] }
  | { readonly state: "failed"; readonly stage: FrameStage | "setup" | "timeout"; readonly message: string };

export type SessionState = {
  readonly revision: number;
  readonly frames: readonly FrameSpec[];
  readonly frameStates: Readonly<Record<FrameKey, FrameState>>;
  readonly packages: { readonly state: "loading" } | { readonly state: "ready"; readonly source: string } | { readonly state: "failed"; readonly message: string };
  readonly compileProblems: readonly CompileProblem[];
  /** Core's report for `revision`. `measured` is true once it includes every frame's answer. */
  readonly report: CheckReport | null;
  readonly measured: boolean;
};

export type SessionOptions = {
  readonly source: PackageSource;
  /** The page kit module's code. */
  readonly kit: string;
  /** The spec renderer module's code, which a spec prototype's frames import. */
  readonly spec?: string;
  /** The frame boot script's code. */
  readonly boot: string;
  readonly parentOrigin: string;
  readonly window: Pick<Window, "addEventListener" | "removeEventListener">;
  /** How long a frame may take to answer once asked to render. */
  readonly timeoutMs?: number;
  readonly settleMs?: number;
  /** A random channel id; injectable for tests. */
  readonly channel?: () => string;
  /** A random script nonce for each frame document; injectable for tests. */
  readonly nonce?: () => string;
  /**
   * Whether frames tag elements so findings can be outlined (`tags.ts`).
   * Defaults to true, or false when the app's address has `frame-tags=off`,
   * which the end-to-end tests use to show tags change no measurement.
   */
  readonly tags?: boolean;
};

/** Element tags are on unless the app was opened with `frame-tags=off`. */
function tagsByDefault(): boolean {
  const search = (globalThis as { location?: { search?: string } }).location?.search ?? "";
  return new URLSearchParams(search).get("frame-tags") !== "off";
}

/** An iframe in the DOM for one frame. `ready` is set once its boot script says it listens: a message sent before then is lost. */
type Attached = { readonly frame: HTMLIFrameElement; readonly generation: number; readonly channel: string; ready: boolean; timer?: ReturnType<typeof setTimeout> };

const PAGE_KIT = "@design-harness/page";
const TOP = { x: 0, y: 0 } as const;

export class Session {
  private state: SessionState = { revision: 0, frames: [], frameStates: {}, packages: { state: "loading" }, compileProblems: [], report: null, measured: false };
  private readonly listeners = new Set<() => void>();
  private readonly attached = new Map<FrameKey, Attached>();
  private config: ProjectConfig | null = null;
  private prototype: Prototype | null = null;
  /** Core's model of the current revision, extracted once for its checks and its tags. */
  private model: PrototypeModel | null = null;
  private readonly tags: boolean;
  private modules: Readonly<Record<string, ModuleSource>> = {};
  private packages: { key: string; value: Promise<RuntimePackages> } | null = null;
  private resolved: RuntimePackages | null = null;
  private readonly channels = new Map<string, FrameKey>();
  /** Where each measured frame's page is scrolled to, and who is listening. Kept out of the state: a scroll re-renders one overlay, not the board. */
  private readonly scrolls = new Map<FrameKey, { readonly x: number; readonly y: number }>();
  private readonly scrollListeners = new Set<() => void>();
  /** A draft was drawn into the current revision's frames by `redraw`. */
  private redrawn = false;

  constructor(private readonly options: SessionOptions) {
    this.tags = options.tags ?? tagsByDefault();
    options.window.addEventListener("message", this.onMessage);
  }

  dispose(): void {
    this.options.window.removeEventListener("message", this.onMessage);
    for (const attached of this.attached.values()) clearTimeout(attached.timer);
    this.attached.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): SessionState => this.state;

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Where a frame's page is scrolled to, as the frame last said; the top when it has said nothing. */
  scrollOf = (key: FrameKey): { readonly x: number; readonly y: number } => this.scrolls.get(key) ?? TOP;

  subscribeScroll = (listener: () => void): (() => void) => {
    this.scrollListeners.add(listener);
    return () => this.scrollListeners.delete(listener);
  };

  /** The config and prototype of the current revision, or null before the first. */
  current(): { readonly config: ProjectConfig; readonly prototype: Prototype; readonly revision: number } | null {
    return this.config && this.prototype ? { config: this.config, prototype: this.prototype, revision: this.state.revision } : null;
  }

  /** Starts a new revision for this config and prototype. */
  update(config: ProjectConfig, prototype: Prototype): void {
    this.config = config;
    this.prototype = prototype;
    const revision = this.state.revision + 1;
    const spec = prototype.format === "spec";
    const model = spec ? specModel(prototype, config) : extractPrototype(prototype, config.library.package);
    this.model = model;
    // A spec prototype has no code to compile: its frames load the spec renderer and get each page's spec as data.
    // A TSX prototype's elements are tagged where core found them, after core has read the source.
    const compiled = spec ? { modules: {}, problems: [] } : compilePrototype(prototype.files, this.tags ? tagSites(model) : undefined);
    this.modules = spec ? { [SPEC_RENDERER]: { code: this.options.spec ?? "throw new Error('this app has no spec renderer');" } } : Object.fromEntries(Object.entries(compiled.modules).map(([specifier, code]) => [specifier, { code }]));
    const frames = frameSpecs(config, prototype);
    const frameStates: Record<FrameKey, FrameState> = {};
    for (const frame of frames) frameStates[frame.key] = frame.blocked ? { state: "failed", stage: "setup", message: frame.blocked } : { state: "waiting" };
    for (const attached of this.attached.values()) clearTimeout(attached.timer);
    this.redrawn = false;
    this.scrolls.clear();
    this.set({ revision, frames, frameStates, compileProblems: compiled.problems, report: checkPrototype({ config, prototype, model }), measured: false });

    const libraryKey = JSON.stringify([config.library.package, config.library.version, config.library.react, config.library.stylesheets ?? [], spec]);
    if (this.packages?.key !== libraryKey) {
      this.resolved = null;
      const value = resolvePackages(config.library, this.options.source, { spec });
      this.packages = { key: libraryKey, value };
      this.set({ packages: { state: "loading" } });
      value.then(
        (packages) => {
          if (this.packages?.value !== value) return;
          this.resolved = packages;
          this.set({ packages: { state: "ready", source: this.options.source.name } });
          for (const [key, attached] of this.attached) if (attached.generation === this.state.revision) this.sendIfReady(key);
        },
        (error: unknown) => {
          if (this.packages?.value !== value) return;
          const message = `Packages could not load from the ${this.options.source.name} source: ${error instanceof Error ? error.message : String(error)}`;
          this.set({ packages: { state: "failed", message } });
          this.failAll(message);
        },
      );
    } else if (this.state.packages.state === "failed") {
      this.failAll(this.state.packages.message);
    }
    this.finishIfDone();
  }

  /** The `srcdoc` for a frame at the current revision, with a fresh channel. */
  documentFor(key: FrameKey): { generation: number; channel: string; html: string } | null {
    const spec = this.state.frames.find((frame) => frame.key === key);
    if (!spec || !this.config) return null;
    const channel = this.options.channel?.() ?? crypto.randomUUID();
    this.channels.set(channel, key);
    const html = frameDocument({
      channel,
      nonce: this.options.nonce?.() ?? crypto.randomUUID().replace(/-/g, ""),
      parentOrigin: this.options.parentOrigin,
      boot: this.options.boot,
      scheme: spec.view.scheme,
      ...(this.config.library.schemeAttribute ? { schemeAttribute: this.config.library.schemeAttribute } : {}),
      origins: this.options.source.origins,
    });
    return { generation: this.state.revision, channel, html };
  }

  /** Called by the board when a frame's iframe for `generation` is in the DOM, and with null when it leaves. */
  attach(key: FrameKey, frame: HTMLIFrameElement | null, generation: number, channel: string): void {
    const previous = this.attached.get(key);
    if (frame === null) {
      // A late detach of an older iframe must not drop the one that replaced it.
      if (previous?.channel !== channel) return;
      clearTimeout(previous.timer);
      this.attached.delete(key);
      this.channels.delete(channel);
      return;
    }
    if (previous) {
      clearTimeout(previous.timer);
      if (previous.channel !== channel) this.channels.delete(previous.channel);
    }
    this.attached.set(key, { frame, generation, channel, ready: false });
  }

  /**
   * Draws a spec prototype's draft in the frames of the current revision, in
   * place: each frame that rendered a spec page gets the draft's spec for
   * its scenario, with no new document and no measurement, so a streaming
   * patch does not take every frame back to blank. The revision, its report
   * and its snapshots stay those of the prototype it was made for. Returns
   * false, drawing nothing, when the current revision is not a spec
   * prototype whose frames have all rendered: the caller then starts a
   * revision for the draft instead.
   */
  redraw(config: ProjectConfig, draft: Prototype): boolean {
    if (this.prototype?.format !== "spec" || draft.format !== "spec") return false;
    const rendered = this.state.frames.filter((frame) => this.state.frameStates[frame.key]?.state === "measured");
    if (rendered.length === 0 || rendered.length !== this.state.frames.length) return false;
    const parts = specParts(config);
    for (const frame of rendered) {
      const attached = this.attached.get(frame.key);
      const payload = specPayload(config, draft, frame.scenario, parts);
      if (!attached || attached.generation !== this.state.revision || !payload) continue;
      attached.frame.contentWindow?.postMessage({ protocol: PROTOCOL, type: "redraw", channel: attached.channel, generation: attached.generation, spec: payload }, "*");
    }
    this.redrawn = true;
    return true;
  }

  /** Puts back what the current revision rendered, after `redraw` drew a draft that was not applied. */
  restore(): void {
    if (!this.redrawn) return;
    this.redrawn = false;
    for (const frame of this.state.frames) {
      const attached = this.attached.get(frame.key);
      if (!attached || attached.generation !== this.state.revision || !frame.page || !("spec" in frame.page)) continue;
      attached.frame.contentWindow?.postMessage({ protocol: PROTOCOL, type: "redraw", channel: attached.channel, generation: attached.generation, spec: frame.page.spec }, "*");
    }
  }

  /** Outlines element `index` of a frame's last snapshot, or clears it with null. */
  highlight(key: FrameKey, index: number | null): void {
    this.post(key, { element: index });
  }

  /** Outlines every element a frame drew under one of `tags` (`tags.ts`): a finding's elements. */
  outline(key: FrameKey, tags: readonly string[]): void {
    if (tags.length > 0) this.post(key, { tags });
  }

  private post(key: FrameKey, what: { readonly element: number | null } | { readonly tags: readonly string[] }): void {
    const attached = this.attached.get(key);
    if (!attached || attached.generation !== this.state.revision) return;
    attached.frame.contentWindow?.postMessage({ protocol: PROTOCOL, type: "highlight", channel: attached.channel, generation: attached.generation, ...what }, "*");
  }

  private readonly onMessage = (event: MessageEvent): void => {
    const data = event.data as { channel?: unknown } | null;
    const channel = typeof data?.channel === "string" ? data.channel : null;
    const key = channel === null ? undefined : this.channels.get(channel);
    if (key === undefined || channel === null) return;
    const attached = this.attached.get(key);
    // Only the iframe this channel was issued to may speak on it.
    if (!attached || attached.channel !== channel || event.source !== attached.frame.contentWindow) return;
    const spec = this.state.frames.find((frame) => frame.key === key);
    if (!spec) return;
    const message = readFrameMessage(event.data, channel, { scenario: spec.scenario.id, view: spec.view.name });
    if (!message) return;
    this.receive(key, attached, message);
  };

  private receive(key: FrameKey, attached: Attached, message: FrameMessage): void {
    if (attached.generation !== this.state.revision) return;
    if (message.type === "ready") {
      attached.ready = true;
      this.sendIfReady(key);
      return;
    }
    if (message.type === "scroll") {
      // Only a measured frame of this revision says where it is scrolled to; it changes no snapshot and no report.
      if (message.generation !== attached.generation || this.state.frameStates[key]?.state !== "measured") return;
      const previous = this.scrolls.get(key) ?? TOP;
      if (previous.x === message.x && previous.y === message.y) return;
      this.scrolls.set(key, { x: message.x, y: message.y });
      for (const listener of this.scrollListeners) listener();
      return;
    }
    // A frame answers once, for the generation it was rendered at; anything else is stale or a second word.
    if (message.generation !== attached.generation || this.state.frameStates[key]?.state !== "rendering") return;
    clearTimeout(attached.timer);
    if (message.type === "snapshot") this.setFrame(key, { state: "measured", snapshot: message.snapshot, tags: message.tags });
    else this.setFrame(key, { state: "failed", stage: message.stage, message: message.message });
    this.finishIfDone();
  }

  private sendIfReady(key: FrameKey): void {
    const attached = this.attached.get(key);
    const spec = this.state.frames.find((frame) => frame.key === key);
    const packages = this.resolved;
    if (!attached?.ready || !spec || !packages || !spec.page || !spec.pageType || this.state.frameStates[key]?.state !== "waiting") return;
    const request: RenderRequest = {
      protocol: PROTOCOL,
      type: "render",
      channel: attached.channel,
      generation: attached.generation,
      modules: { ...packages.modules, [PAGE_KIT]: { code: this.options.kit }, ...this.modules },
      styles: packages.styles,
      page: spec.page,
      scenario: { id: spec.scenario.id, state: spec.scenario.state, page: spec.scenario.page },
      pageType: spec.pageType,
      view: spec.view,
      settleMs: this.options.settleMs ?? 3000,
      tags: this.tags,
      ...(this.config?.library.root ? { root: rootRef(this.config.library, spec.view.scheme) as RootRef } : {}),
    };
    this.setFrame(key, { state: "rendering" });
    attached.timer = setTimeout(() => {
      if (attached.generation !== this.state.revision || this.state.frameStates[key]?.state !== "rendering") return;
      this.setFrame(key, { state: "failed", stage: "timeout", message: `The frame did not answer within ${Math.round((this.options.timeoutMs ?? 20000) / 1000)} s.` });
      this.finishIfDone();
    }, this.options.timeoutMs ?? 20000);
    attached.frame.contentWindow?.postMessage(request, "*");
  }

  private setFrame(key: FrameKey, value: FrameState): void {
    this.set({ frameStates: { ...this.state.frameStates, [key]: value } });
  }

  private failAll(message: string): void {
    const frameStates: Record<FrameKey, FrameState> = { ...this.state.frameStates };
    for (const frame of this.state.frames) if (frameStates[frame.key]?.state !== "failed") frameStates[frame.key] = { state: "failed", stage: "setup", message };
    this.set({ frameStates });
    this.finishIfDone();
  }

  /** Once every frame of the revision has answered, core checks the prototype with the snapshots it has. */
  private finishIfDone(): void {
    const { frames, frameStates, measured } = this.state;
    if (measured || !this.config || !this.prototype) return;
    const states = frames.map((frame) => frameStates[frame.key]);
    if (states.some((state) => state === undefined || state.state === "waiting" || state.state === "rendering")) return;
    const snapshots = states.flatMap((state) => (state?.state === "measured" ? [state.snapshot] : []));
    this.set({ report: checkPrototype({ config: this.config, prototype: this.prototype, snapshots, ...(this.model ? { model: this.model } : {}) }), measured: true });
  }
}

/** One frame per scenario and view, in the prototype's scenario order and the config's view order. */
export function frameSpecs(config: ProjectConfig, prototype: Prototype): FrameSpec[] {
  const pageTypes = new Map(config.inventories.pageTypes.map((type) => [type.id, type]));
  const parts = prototype.format === "spec" ? specParts(config) : {};
  return prototype.scenarios.flatMap((scenario) => {
    const page = prototype.pages.find((item) => item.id === scenario.page);
    const pageType = page ? pageTypes.get(page.pageType) : undefined;
    const payload = page && prototype.format === "spec" ? specPayload(config, prototype, scenario, parts) : null;
    const ref: PageRef | undefined = !page ? undefined : prototype.format === "spec" ? (payload ? { spec: payload } : undefined) : { module: moduleSpecifier(page.component.file), export: page.component.export };
    const blocked = !page
      ? `Scenario "${scenario.id}" names page "${scenario.page}", which is not in the prototype's manifest.`
      : !pageType
        ? `Page "${page.id}" is a "${page.pageType}" page, which is not a page type in the project's inventory, so the shell has no slots to lay out.`
        : prototype.files[page.component.file] === undefined
          ? `Page "${page.id}" names ${page.component.file}, which is not a file in the prototype.`
          : !ref
            ? `Page "${page.id}"'s spec, ${page.component.file}, could not be read; the checks say why.`
            : undefined;
    return config.views.map((view): FrameSpec => ({
      key: frameKey(scenario.id, view.name),
      scenario,
      view,
      ...(blocked ? { blocked } : {}),
      ...(pageType ? { pageType } : {}),
      ...(ref ? { page: ref } : {}),
    }));
  });
}
