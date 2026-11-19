import { Component, createContext, useContext, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { PageType } from "@design-harness/core";
import { slotPlaces, type SlotPlace } from "./slots";

/**
 * The page kit, `@design-harness/page`, as a prototype imports it inside a
 * frame. A page fills its page type's slots with `Slot`; the default shell
 * arranges them. The kit knows nothing about the component library: it lays
 * out slots and renders whatever the page put in them.
 *
 * The shell reads only the page type. Its slots keep their order, and fall
 * in three runs: the lead (every slot before the first body slot), the body,
 * and the trail (every slot after the last body slot, where an action page's
 * primary slot and its alternates sit). At 600 CSS px and wider the trail's
 * slots sit side by side under the body; narrower, every slot is a full-width
 * row. Body slots are those neither chrome nor primary, as core counts them.
 */

/** What a page component receives: the scenario it is rendered for, and that scenario's flow state. */
export type PageProps = { readonly scenario: string; readonly state: string };

type ShellContext = { readonly place: (name: string) => SlotPlace };

const NARROW = 600;
const UNKNOWN: SlotPlace = { order: 10000, trail: false, known: false };
const Shell = createContext<ShellContext>({ place: () => UNKNOWN });

/** Fills the page type's slot `name`. A name the page type lacks still renders, after every known slot, and core's page-structure rule reports it. */
export function Slot({ name, children }: { readonly name: string; readonly children?: ReactNode }) {
  const place = useContext(Shell).place(name);
  return (
    <div className="dh-slot" data-slot={name} data-trail={place.trail ? "" : undefined} data-unknown={place.known ? undefined : ""} style={{ order: place.order }}>
      {children}
    </div>
  );
}

const SHELL_CSS = `
/* A plain system face unless the library's stylesheet sets one on the root: zero specificity, so any rule of its own wins. */
:where(html) { font-family: system-ui, sans-serif; line-height: 1.5; }
.dh-page { box-sizing: border-box; min-height: 100vh; margin: 0; }
.dh-shell { box-sizing: border-box; display: grid; grid-template-columns: repeat(var(--dh-trail, 0), auto) 1fr; align-items: start; column-gap: 12px; row-gap: 16px; max-width: 760px; margin: 0 auto; padding: 40px 24px; }
.dh-slot { grid-column: 1 / -1; min-width: 0; }
.dh-slot[data-trail] { grid-column: auto; }
.dh-slot[data-unknown] { outline: 1px dashed currentColor; outline-offset: 4px; }
@media (max-width: ${NARROW - 0.02}px) {
  .dh-shell { grid-template-columns: 1fr; padding: 24px 16px; row-gap: 12px; }
  .dh-slot[data-trail] { grid-column: 1 / -1; }
}
`;

function DefaultShell({ type, children }: { readonly type: PageType; readonly children: ReactNode }) {
  const places = slotPlaces(type);
  const trail = [...places.values()].filter((place) => place.trail).length;
  return (
    <Shell.Provider value={{ place: (name) => places.get(name) ?? UNKNOWN }}>
      <div className="dh-shell" data-page-type={type.id} style={{ ["--dh-trail" as string]: String(trail) }}>
        {children}
      </div>
    </Shell.Provider>
  );
}

class Boundary extends Component<{ readonly onError: (error: unknown) => void; readonly children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown, _info: ErrorInfo) {
    this.props.onError(error);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Renders a page into `container` inside the default shell, and inside the
 * library's root part when it has one, synchronously.
 * Resolves once React has committed it, or rejects with what the page threw
 * while rendering; `onLateError` hears what it throws afterwards, from an
 * effect or an event. Internal to the frame: a prototype that imports it is
 * flagged by core's imports rule, which allows only Slot and PageProps.
 */
export function mount(
  container: HTMLElement,
  Page: ComponentType<PageProps>,
  props: PageProps,
  type: PageType,
  onLateError: (error: Error) => void,
  root?: { readonly component: ComponentType<Record<string, unknown>>; readonly props: Readonly<Record<string, unknown>> },
): Promise<void> {
  if (!container.ownerDocument.getElementById("dh-shell-css")) {
    const style = container.ownerDocument.createElement("style");
    style.id = "dh-shell-css";
    style.textContent = SHELL_CSS;
    container.ownerDocument.head.append(style);
  }
  container.classList.add("dh-page");
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      const asError = error instanceof Error ? error : new Error(String(error));
      if (settled) onLateError(asError);
      else {
        settled = true;
        reject(asError);
      }
    };
    const reactRoot = createRoot(container, { onUncaughtError: fail, onRecoverableError: () => undefined });
    const shell = (
      <DefaultShell type={type}>
        <Page scenario={props.scenario} state={props.state} />
      </DefaultShell>
    );
    // The library's root, when it needs one, outside the shell: the shell and the page render inside its provider.
    const Root = root?.component;
    try {
      flushSync(() => reactRoot.render(<Boundary onError={fail}>{Root ? <Root {...root.props}>{shell}</Root> : shell}</Boundary>));
    } catch (error) {
      fail(error);
    }
    if (!settled) {
      settled = true;
      resolve();
    }
  });
}
