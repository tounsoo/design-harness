import { parseSnapshots, type PageType, type RenderedSnapshot, type View } from "@design-harness/core";

/**
 * The messages between the app and a frame. A frame is a sandboxed iframe
 * with an opaque origin, so postMessage is the only way in or out, and each
 * side checks every message it receives: who sent it (the app checks
 * `event.source`, the frame checks it is its parent), the protocol tag, the
 * frame's channel, and the shape, field by field. Anything else is dropped.
 */

export const PROTOCOL = "design-harness/frame@1";

/** A module the frame imports: a URL it may load cross-origin, or the code itself. */
export type ModuleSource = { readonly url: string } | { readonly code: string };
/** A stylesheet the frame applies: a URL, or the CSS itself. */
export type StyleSource = { readonly url: string } | { readonly css: string };

export type ScenarioRef = { readonly id: string; readonly state: string; readonly page: string };

/** App → frame: render one page for one scenario at one view, then measure it. */
export type RenderRequest = {
  readonly protocol: typeof PROTOCOL;
  readonly type: "render";
  readonly channel: string;
  readonly generation: number;
  /** Every module the page can import, by bare specifier: React, the library, the page kit and the prototype's files. */
  readonly modules: Readonly<Record<string, ModuleSource>>;
  readonly styles: readonly StyleSource[];
  /** The page component: a module specifier from `modules` and an export name. */
  readonly page: { readonly module: string; readonly export: string };
  readonly scenario: ScenarioRef;
  readonly pageType: PageType;
  readonly view: View;
  /** The longest the frame waits for the page to stop changing before it measures. */
  readonly settleMs: number;
};

/** App → frame: outline one element of the last snapshot, by its index, or clear the outline. */
export type HighlightRequest = { readonly protocol: typeof PROTOCOL; readonly type: "highlight"; readonly channel: string; readonly generation: number; readonly element: number | null };

export type ParentMessage = RenderRequest | HighlightRequest;

/** Frame → app: the boot script is listening. */
export type ReadyMessage = { readonly protocol: typeof PROTOCOL; readonly type: "ready"; readonly channel: string };
/** Frame → app: the page as it was painted. */
export type SnapshotMessage = { readonly protocol: typeof PROTOCOL; readonly type: "snapshot"; readonly channel: string; readonly generation: number; readonly snapshot: RenderedSnapshot };
export type FrameStage = "load" | "render" | "measure";
/** Frame → app: the page could not be loaded, rendered or measured. */
export type ErrorMessage = { readonly protocol: typeof PROTOCOL; readonly type: "error"; readonly channel: string; readonly generation: number; readonly stage: FrameStage; readonly message: string };

export type FrameMessage = ReadyMessage | SnapshotMessage | ErrorMessage;

/** Error text longer than this is cut, so a frame cannot flood the app. */
export const MAX_ERROR_LENGTH = 2000;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` has exactly these keys: an unknown key is a malformed message, not an extension. */
function hasOnly(value: Json, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

const isString = (value: unknown): value is string => typeof value === "string";
const isGeneration = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function isModuleSource(value: unknown): value is ModuleSource {
  if (!isObject(value)) return false;
  if ("url" in value) return hasOnly(value, ["url"]) && isString(value.url);
  return hasOnly(value, ["code"]) && isString(value.code);
}

function isStyleSource(value: unknown): value is StyleSource {
  if (!isObject(value)) return false;
  if ("url" in value) return hasOnly(value, ["url"]) && isString(value.url);
  return hasOnly(value, ["css"]) && isString(value.css);
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

function isPageType(value: unknown): value is PageType {
  if (!isObject(value) || !isString(value.id) || !isStringList(value.slots) || !isStringList(value.chrome)) return false;
  if (value.kind === "action") return hasOnly(value, ["id", "kind", "slots", "chrome", "primarySlot"]) && isString(value.primarySlot);
  return (value.kind === "collection" || value.kind === "content") && hasOnly(value, ["id", "kind", "slots", "chrome"]);
}

function isView(value: unknown): value is View {
  if (!isObject(value) || !hasOnly(value, ["name", "width", "height", "scheme"])) return false;
  const size = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 10000;
  return isString(value.name) && size(value.width) && size(value.height) && (value.scheme === "light" || value.scheme === "dark");
}

function isScenario(value: unknown): value is ScenarioRef {
  return isObject(value) && hasOnly(value, ["id", "state", "page"]) && isString(value.id) && isString(value.state) && isString(value.page);
}

/** The frame's reader: a message from its parent for this channel, or null. */
export function readParentMessage(data: unknown, channel: string): ParentMessage | null {
  if (!isObject(data) || data.protocol !== PROTOCOL || data.channel !== channel || !isGeneration(data.generation)) return null;
  if (data.type === "highlight") {
    const element = data.element;
    const valid = element === null || (typeof element === "number" && Number.isSafeInteger(element) && element >= 0);
    return valid && hasOnly(data, ["protocol", "type", "channel", "generation", "element"]) ? (data as HighlightRequest) : null;
  }
  if (data.type !== "render") return null;
  if (!hasOnly(data, ["protocol", "type", "channel", "generation", "modules", "styles", "page", "scenario", "pageType", "view", "settleMs"])) return null;
  const { modules, styles, page, settleMs } = data;
  if (!isObject(modules) || !Object.values(modules).every(isModuleSource)) return null;
  if (!Array.isArray(styles) || !styles.every(isStyleSource)) return null;
  if (!isObject(page) || !hasOnly(page, ["module", "export"]) || !isString(page.module) || !isString(page.export) || !(page.module in modules)) return null;
  if (!isScenario(data.scenario) || !isPageType(data.pageType) || !isView(data.view)) return null;
  if (typeof settleMs !== "number" || !Number.isFinite(settleMs) || settleMs < 0 || settleMs > 60000) return null;
  return data as RenderRequest;
}

/**
 * The app's reader: a message from a frame on this channel, or null. A
 * snapshot is validated with core's snapshot schema, and must be of the
 * scenario and view the frame was asked to render.
 */
export function readFrameMessage(data: unknown, channel: string, expect: { readonly scenario: string; readonly view: string }): FrameMessage | null {
  if (!isObject(data) || data.protocol !== PROTOCOL || data.channel !== channel) return null;
  switch (data.type) {
    case "ready":
      return hasOnly(data, ["protocol", "type", "channel"]) ? (data as ReadyMessage) : null;
    case "error": {
      if (!hasOnly(data, ["protocol", "type", "channel", "generation", "stage", "message"]) || !isGeneration(data.generation)) return null;
      if (data.stage !== "load" && data.stage !== "render" && data.stage !== "measure") return null;
      if (!isString(data.message) || data.message.length > MAX_ERROR_LENGTH) return null;
      return data as ErrorMessage;
    }
    case "snapshot": {
      if (!hasOnly(data, ["protocol", "type", "channel", "generation", "snapshot"]) || !isGeneration(data.generation)) return null;
      const parsed = parseSnapshots([data.snapshot]);
      const snapshot = parsed.ok ? parsed.value[0] : undefined;
      if (!snapshot || snapshot.scenario !== expect.scenario || snapshot.view !== expect.view) return null;
      return { protocol: PROTOCOL, type: "snapshot", channel, generation: data.generation, snapshot };
    }
    default:
      return null;
  }
}

/** Cuts an error message to the protocol's limit. */
export function clip(message: string): string {
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message;
}
