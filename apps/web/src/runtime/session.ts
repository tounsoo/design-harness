import { type CheckReport, type ComponentLibrary, type PageType, type ProjectConfig, type Prototype, type RenderedSnapshot, type Scenario, type View } from "@design-harness/core";
import { mainThreadEngine, type CheckEngine, type Prepared } from "./check-engine";
import { frameDocument } from "./frame-document";
import { FRAME_BUDGET, type FrameBudget } from "./live-frames";
import { resolvePackages, type PackageSource, type RuntimePackages } from "./package-source";
import { PRIORITY, RENDER_SLOTS, type RenderSlots } from "./render-slots";
import { PROTOCOL, readFrameMessage, type FrameMessage, type FrameStage, type ModuleSource, type PageRef, type RenderRequest, type RootRef, type SpecPart, type SpecPayload } from "./protocol";
import { SPEC_RENDERER, specParts, specPayload } from "./spec-payload";
import { moduleSpecifier, type CompileProblem } from "./transform";

/**
 * One prototype's check loop. Each change to the config or the prototype is
 * a new revision: core checks it at once without snapshots (rendered rules
 * report not-run) in the check engine (`check-engine.ts`, a module worker in
 * the app), which also compiles a TSX prototype or resolves a spec
 * prototype's pages; every frame gets a fresh document for the revision, and
 * once every frame has answered, core checks it again with their snapshots.
 * A message is only ever counted toward the revision it was rendered for,
 * so a slow frame from an earlier revision can never put its snapshot into
 * a later report.
 *
 * Frames are measured lazily but completely. A frame drawn somewhere
 * (`present`) waits for a render slot, the ones near the screen first, then
 * goes live (its viewport mounts an iframe), renders, is measured, and is
 * parked again unless it is near the screen: its snapshot is kept and its
 * document goes. Every frame drawn anywhere is measured, on screen or off,
 * so the report is complete; it is "measured" only once every frame has
 * answered. A measured frame that comes near the screen is drawn again in a
 * fresh document, while the live-frame budget (`live-frames.ts`) has room;
 * that render is a picture, never measured again into the report.
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
  /** How long a frame may take to answer once asked to render, and to load once given its turn. */
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
  /** How many frames render at once (`render-slots.ts`); the app's shared slots unless a test gives its own. */
  readonly slots?: RenderSlots;
  /** How many frames are live at once (`live-frames.ts`); the app's shared budget unless a test gives its own. */
  readonly budget?: FrameBudget;
  /** Where core's engine runs (`check-engine.ts`); the main thread unless the app gives its worker. */
  readonly engine?: CheckEngine;
};

/** Element tags are on unless the app was opened with `frame-tags=off`. */
function tagsByDefault(): boolean {
  const search = (globalThis as { location?: { search?: string } }).location?.search ?? "";
  return new URLSearchParams(search).get("frame-tags") !== "off";
}

/** An iframe in the DOM for one frame. `ready` is set once its boot script says it listens: a message sent before then is lost. */
type Attached = { readonly frame: HTMLIFrameElement; readonly generation: number; readonly channel: string; ready: boolean };

/**
 * A frame's turn at a render slot: to be measured, or to be drawn again
 * near the screen after it was parked. `channel` is the document it was
 * asked on, once it was asked.
 */
type Turn = { readonly token: symbol; readonly purpose: "measure" | "show"; granted: boolean; channel: string | null; timer?: ReturnType<typeof setTimeout> };

/** One place a frame is drawn (`FrameViewport`): whether it is near the screen, and the way to say it has gone. */
export type FramePresence = { readonly visible: (visible: boolean) => void; readonly leave: () => void };

/** How often a frame drawn again near the screen measured what it measured the first time: for the app's own checks of itself. */
export type Reshown = { readonly count: number; readonly same: number };

const PAGE_KIT = "@design-harness/page";
const TOP = { x: 0, y: 0 } as const;
let sessions = 0;

export class Session {
  private state: SessionState = { revision: 0, frames: [], frameStates: {}, packages: { state: "loading" }, compileProblems: [], report: null, measured: false };
  private readonly listeners = new Set<() => void>();
  private readonly attached = new Map<FrameKey, Attached>();
  private config: ProjectConfig | null = null;
  private prototype: Prototype | null = null;
  private readonly tags: boolean;
  private modules: Readonly<Record<string, ModuleSource>> = {};
  /** The current revision's modules (TSX) or pages (spec) have come back from the engine. */
  private prepared = false;
  /** The revision whose last check has been asked for, so it is asked once. */
  private finishing = 0;
  private packages: { key: string; value: Promise<RuntimePackages> } | null = null;
  private resolved: RuntimePackages | null = null;
  private readonly channels = new Map<string, FrameKey>();
  /** Where each measured frame's page is scrolled to, and who is listening. Kept out of the state: a scroll re-renders one overlay, not the board. */
  private readonly scrolls = new Map<FrameKey, { readonly x: number; readonly y: number }>();
  private readonly scrollListeners = new Set<() => void>();
  /** The render slot each frame of the current revision waits for or holds. */
  private readonly slots: RenderSlots;
  private readonly turns = new Map<FrameKey, Turn>();
  /** How many frames are live at once, and each frame's hold on that budget while it is live or waits to be. */
  private readonly budget: FrameBudget;
  private readonly holds = new Map<FrameKey, symbol>();
  /**
   * The frames whose viewport should hold a live iframe, each with the
   * number of its going live: a frame parked and shown again gets a fresh
   * document, on a fresh channel, since a document renders once.
   */
  private readonly lives = new Map<FrameKey, number>();
  private epoch = 0;
  /** The live frames whose document has drawn its page and answered, so what shows is the page. */
  private readonly drawn = new Set<FrameKey>();
  private readonly liveListeners = new Set<() => void>();
  /** Where each frame is drawn: its viewports, and whether each is near the screen. */
  private readonly viewers = new Map<symbol, { readonly key: FrameKey; visible: boolean }>();
  /** What each frame was last asked to outline, so a frame drawn again outlines it too. */
  private readonly marks = new Map<FrameKey, { readonly element: number | null } | { readonly tags: readonly string[] }>();
  /** A draft drawn into the current revision's frames by `redraw`, which a frame drawn again draws too. */
  private draft: { readonly config: ProjectConfig; readonly prototype: Prototype } | null = null;
  private reshown = { count: 0, same: 0 };
  private readonly engine: CheckEngine;
  /** This session's name to the engine, which keeps its last model. */
  private readonly id = `session-${(sessions += 1)}`;

  constructor(private readonly options: SessionOptions) {
    this.tags = options.tags ?? tagsByDefault();
    this.slots = options.slots ?? RENDER_SLOTS;
    this.budget = options.budget ?? FRAME_BUDGET;
    this.engine = options.engine ?? mainThreadEngine();
    options.window.addEventListener("message", this.onMessage);
  }

  dispose(): void {
    this.options.window.removeEventListener("message", this.onMessage);
    this.endAll();
    this.attached.clear();
    this.engine.forget(this.id);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): SessionState => this.state;

  /** Where core's engine runs for this session: the module worker, or the main thread when a worker could not start. */
  engineWhere(): "worker" | "main" {
    return this.engine.where();
  }

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

  private tellScroll(): void {
    for (const listener of this.scrollListeners) listener();
  }

  /**
   * Whether a frame's viewport should hold a live iframe now, as the number
   * of its going live (a new number is a new document), or null while it is
   * parked: not yet given its turn, or measured and away from the screen.
   */
  liveOf = (key: FrameKey): number | null => this.lives.get(key) ?? null;

  subscribeLive = (listener: () => void): (() => void) => {
    this.liveListeners.add(listener);
    return () => this.liveListeners.delete(listener);
  };

  /** Whether a live frame's document has drawn its page and answered (its snapshot, or its error). */
  drawnOf = (key: FrameKey): boolean => this.drawn.has(key);

  /** How many of this session's frames are live now. */
  liveCount(): number {
    return this.lives.size;
  }

  /** How many frames were drawn again after being parked, and how many of those measured exactly what they measured first. */
  reshownCount(): Reshown {
    return { ...this.reshown };
  }

  private tellLive(): void {
    for (const listener of this.liveListeners) listener();
  }

  /**
   * Says a frame is drawn somewhere (`FrameViewport`), so the session gives
   * it a turn to be measured, near the screen first, and keeps it live while
   * it is near the screen and the budget has room.
   */
  present(key: FrameKey): FramePresence {
    const token = Symbol(key);
    this.viewers.set(token, { key, visible: false });
    this.schedule(key);
    return {
      visible: (visible) => {
        const viewer = this.viewers.get(token);
        if (!viewer || viewer.visible === visible) return;
        viewer.visible = visible;
        this.schedule(key);
      },
      leave: () => {
        if (!this.viewers.delete(token)) return;
        this.schedule(key);
      },
    };
  }

  private isPresent(key: FrameKey): boolean {
    for (const viewer of this.viewers.values()) if (viewer.key === key) return true;
    return false;
  }

  private isVisible(key: FrameKey): boolean {
    for (const viewer of this.viewers.values()) if (viewer.key === key && viewer.visible) return true;
    return false;
  }

  /** The config and prototype of the current revision, or null before the first. */
  current(): { readonly config: ProjectConfig; readonly prototype: Prototype; readonly revision: number } | null {
    return this.config && this.prototype ? { config: this.config, prototype: this.prototype, revision: this.state.revision } : null;
  }

  /**
   * Starts a new revision for this config and prototype. Core checks it at
   * once without snapshots, in the engine, which also gives back what the
   * frames need (a TSX prototype's modules, a spec prototype's pages); the
   * report is null until it answers.
   */
  update(config: ProjectConfig, prototype: Prototype): void {
    this.config = config;
    this.prototype = prototype;
    const revision = this.state.revision + 1;
    const spec = prototype.format === "spec";
    // A spec prototype has no code to compile: its frames load the spec renderer and get each page's spec as data, once the engine has resolved it.
    this.modules = spec ? { [SPEC_RENDERER]: { code: this.options.spec ?? "throw new Error('this app has no spec renderer');" } } : {};
    this.prepared = false;
    const frames = frameSpecs(config, prototype, spec ? null : undefined);
    const frameStates: Record<FrameKey, FrameState> = {};
    for (const frame of frames) frameStates[frame.key] = frame.blocked ? { state: "failed", stage: "setup", message: frame.blocked } : { state: "waiting" };
    // No frame of the last revision renders or stays live any more: its slots and holds go to this one's.
    this.endAll();
    this.marks.clear();
    this.draft = null;
    this.set({ revision, frames, frameStates, compileProblems: [], report: null, measured: false });

    this.engine.run({ kind: "prepare", session: this.id, revision, config, prototype, tags: this.tags }).then(
      (prepared) => this.onPrepared(revision, prepared),
      (error: unknown) => console.error("design-harness: core's check failed", error),
    );

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
          this.scheduleAll();
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
    this.scheduleAll();
    this.finishIfDone();
  }

  private onPrepared(revision: number, prepared: Prepared): void {
    if (revision !== this.state.revision || !this.config || !this.prototype) return;
    this.prepared = true;
    const patch: { -readonly [K in keyof SessionState]?: SessionState[K] } = { compileProblems: prepared.problems };
    // The last check may already be in: it is the revision's report from then on.
    if (!this.state.measured) patch.report = prepared.report;
    if (this.prototype.format === "spec") {
      const frames = frameSpecs(this.config, this.prototype, prepared.payloads ?? {});
      const frameStates: Record<FrameKey, FrameState> = { ...this.state.frameStates };
      for (const frame of frames) if (frame.blocked && frameStates[frame.key]?.state === "waiting") frameStates[frame.key] = { state: "failed", stage: "setup", message: frame.blocked };
      patch.frames = frames;
      patch.frameStates = frameStates;
    } else {
      this.modules = Object.fromEntries(Object.entries(prepared.modules).map(([specifier, code]) => [specifier, { code }]));
    }
    this.set(patch);
    this.scheduleAll();
    this.finishIfDone();
  }

  /** The `srcdoc` for a frame at the current revision, with a fresh channel. */
  documentFor(key: FrameKey): { generation: number; channel: string; html: string } | null {
    const spec = this.frameOf(key);
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
      this.lost(key, channel);
      this.attached.delete(key);
      this.channels.delete(channel);
      this.schedule(key);
      return;
    }
    if (previous && previous.channel !== channel) {
      this.lost(key, previous.channel);
      this.channels.delete(previous.channel);
    }
    this.attached.set(key, { frame, generation, channel, ready: false });
  }

  /** A frame's document left while it was asked to render: a measurement starts again from waiting, a redraw just ends. */
  private lost(key: FrameKey, channel: string): void {
    this.drawn.delete(key);
    const turn = this.turns.get(key);
    if (!turn || turn.channel !== channel) return;
    this.endTurn(key);
    if (turn.purpose === "measure" && this.state.frameStates[key]?.state === "rendering") this.setFrame(key, { state: "waiting" });
  }

  /**
   * Draws a spec prototype's draft in the frames of the current revision, in
   * place: each frame that rendered a spec page gets the draft's spec for
   * its scenario, with no new document and no measurement, so a streaming
   * patch does not take every frame back to blank. A frame parked away from
   * the screen draws the draft when it is drawn again. The revision, its
   * report and its snapshots stay those of the prototype it was made for.
   * Returns false, drawing nothing, when the current revision is not a spec
   * prototype whose frames have all rendered: the caller then starts a
   * revision for the draft instead.
   */
  redraw(config: ProjectConfig, draft: Prototype): boolean {
    if (this.prototype?.format !== "spec" || draft.format !== "spec") return false;
    const rendered = this.state.frames.filter((frame) => this.state.frameStates[frame.key]?.state === "measured");
    if (rendered.length === 0 || rendered.length !== this.state.frames.length) return false;
    this.draft = { config, prototype: draft };
    const parts = specParts(config);
    for (const frame of rendered) this.drawDraft(frame, parts);
    return true;
  }

  private drawDraft(frame: FrameSpec, parts: Readonly<Record<string, SpecPart>>): void {
    const attached = this.attached.get(frame.key);
    if (!this.draft || !attached || attached.generation !== this.state.revision) return;
    const payload = specPayload(this.draft.config, this.draft.prototype, frame.scenario, parts);
    if (!payload) return;
    attached.frame.contentWindow?.postMessage({ protocol: PROTOCOL, type: "redraw", channel: attached.channel, generation: attached.generation, spec: payload }, "*");
  }

  /** Puts back what the current revision rendered, after `redraw` drew a draft that was not applied. */
  restore(): void {
    if (!this.draft) return;
    this.draft = null;
    for (const frame of this.state.frames) {
      const attached = this.attached.get(frame.key);
      if (!attached || attached.generation !== this.state.revision || !frame.page || !("spec" in frame.page)) continue;
      attached.frame.contentWindow?.postMessage({ protocol: PROTOCOL, type: "redraw", channel: attached.channel, generation: attached.generation, spec: frame.page.spec }, "*");
    }
  }

  /** Outlines element `index` of a frame's last snapshot, or clears it with null. A parked frame outlines it when it is drawn again. */
  highlight(key: FrameKey, index: number | null): void {
    if (index === null) this.marks.delete(key);
    else this.marks.set(key, { element: index });
    this.post(key, { element: index });
  }

  /** Outlines every element a frame drew under one of `tags` (`tags.ts`): a finding's elements. */
  outline(key: FrameKey, tags: readonly string[]): void {
    if (tags.length === 0) return;
    this.marks.set(key, { tags });
    this.post(key, { tags });
  }

  private post(key: FrameKey, what: { readonly element: number | null } | { readonly tags: readonly string[] }): void {
    const attached = this.attached.get(key);
    if (!attached || attached.generation !== this.state.revision) return;
    attached.frame.contentWindow?.postMessage({ protocol: PROTOCOL, type: "highlight", channel: attached.channel, generation: attached.generation, ...what }, "*");
  }

  /** What a frame drawn again shows on top of its page: the draft being streamed, or else its outline. */
  private replay(key: FrameKey): void {
    const frame = this.frameOf(key);
    if (this.draft && frame) {
      this.drawDraft(frame, specParts(this.draft.config));
      return;
    }
    const mark = this.marks.get(key);
    if (mark) this.post(key, mark);
  }

  private readonly onMessage = (event: MessageEvent): void => {
    const data = event.data as { channel?: unknown } | null;
    const channel = typeof data?.channel === "string" ? data.channel : null;
    const key = channel === null ? undefined : this.channels.get(channel);
    if (key === undefined || channel === null) return;
    const attached = this.attached.get(key);
    // Only the iframe this channel was issued to may speak on it.
    if (!attached || attached.channel !== channel || event.source !== attached.frame.contentWindow) return;
    const spec = this.frameOf(key);
    if (!spec) return;
    const message = readFrameMessage(event.data, channel, { scenario: spec.scenario.id, view: spec.view.name });
    if (!message) return;
    this.receive(key, attached, message);
  };

  private receive(key: FrameKey, attached: Attached, message: FrameMessage): void {
    if (attached.generation !== this.state.revision) return;
    if (message.type === "ready") {
      attached.ready = true;
      this.schedule(key);
      return;
    }
    if (message.type === "scroll") {
      // Only a measured frame of this revision says where it is scrolled to; it changes no snapshot and no report.
      if (message.generation !== attached.generation || this.state.frameStates[key]?.state !== "measured") return;
      const previous = this.scrolls.get(key) ?? TOP;
      if (previous.x === message.x && previous.y === message.y) return;
      this.scrolls.set(key, { x: message.x, y: message.y });
      this.tellScroll();
      return;
    }
    // A frame answers once, for the generation and document it was asked on; anything else is stale or a second word.
    const turn = this.turns.get(key);
    if (message.generation !== attached.generation || !turn || turn.channel !== attached.channel) return;
    if (turn.purpose === "show") {
      // A picture of a frame already measured: its snapshot is never used, only compared with the one measured first.
      this.endTurn(key);
      this.markDrawn(key);
      const first = this.state.frameStates[key];
      if (message.type === "snapshot" && first?.state === "measured") {
        this.reshown = { count: this.reshown.count + 1, same: this.reshown.same + (sameSnapshot(first.snapshot, message.snapshot) ? 1 : 0) };
      }
      this.replay(key);
      return;
    }
    if (this.state.frameStates[key]?.state !== "rendering") return;
    this.endTurn(key);
    if (message.type === "snapshot") this.setFrame(key, { state: "measured", snapshot: message.snapshot, tags: message.tags });
    else this.setFrame(key, { state: "failed", stage: message.stage, message: message.message });
    this.afterMeasure(key);
    this.finishIfDone();
  }

  /** A frame has answered for its measurement: it stays live while it is near the screen, and is parked otherwise. */
  private afterMeasure(key: FrameKey): void {
    const hold = this.holds.get(key);
    if (hold && this.isVisible(key) && this.lives.has(key)) {
      this.budget.keep(hold, () => this.parkedBy(key, hold));
      this.markDrawn(key);
      this.replay(key);
      return;
    }
    this.park(key);
  }

  /** The frames to look at again after something that frees a slot or a hold. */
  private scheduleAll(): void {
    // Near the screen first: a slot that is free now goes to a frame someone is looking at.
    const keys = this.state.frames.map((frame) => frame.key);
    for (const key of [...keys.filter((key) => this.isVisible(key)), ...keys.filter((key) => !this.isVisible(key))]) this.schedule(key);
  }

  /**
   * Decides what one frame of the current revision needs now. A frame
   * waiting to be measured asks for a render slot, on screen first, once
   * it is drawn somewhere (or its iframe is already in the DOM and
   * listening) and what it renders is ready. A measured frame near the
   * screen asks to be live again; one away from it is parked.
   */
  private schedule(key: FrameKey): void {
    const frame = this.frameOf(key);
    const state = this.state.frameStates[key];
    if (!frame || !state) return;
    const visible = this.isVisible(key);
    const present = this.isPresent(key);
    const turn = this.turns.get(key);
    if (state.state === "waiting") {
      const attached = this.attached.get(key);
      const listening = attached?.ready === true && attached.generation === this.state.revision;
      if (!(present || listening) || !this.canRender(frame)) {
        if (turn && turn.channel === null) {
          this.endTurn(key);
          this.park(key);
        }
        return;
      }
      if (!turn) this.askTurn(key, "measure", visible ? PRIORITY.onScreen : PRIORITY.offScreen);
      else if (!turn.granted) this.slots.reprioritize(turn.token, visible ? PRIORITY.onScreen : PRIORITY.offScreen);
      else this.sendIfReady(key);
      return;
    }
    if (state.state === "rendering") return;
    if (state.state === "measured" && present && visible) {
      if (!this.lives.has(key) && !this.holds.has(key)) this.askShow(key);
      else if (turn?.granted) this.sendIfReady(key);
      return;
    }
    if (this.lives.has(key) || this.holds.has(key)) this.park(key);
  }

  private canRender(frame: FrameSpec): boolean {
    return this.resolved !== null && this.prepared && frame.page !== undefined && frame.pageType !== undefined;
  }

  private askTurn(key: FrameKey, purpose: Turn["purpose"], priority: number): void {
    const turn: Turn = { token: Symbol(key), purpose, granted: false, channel: null };
    const revision = this.state.revision;
    this.turns.set(key, turn);
    this.slots.request(
      turn.token,
      () => {
        // By the time a slot is free, the frame may be gone, answered, or a newer revision may have started.
        const now = this.state.frameStates[key]?.state;
        if (this.turns.get(key) !== turn || revision !== this.state.revision || now !== (purpose === "measure" ? "waiting" : "measured")) {
          if (this.turns.get(key) === turn) this.turns.delete(key);
          return false;
        }
        turn.granted = true;
        if (purpose === "measure") this.budget.measure(this.holdOf(key));
        this.goLive(key);
        // A frame given its turn must load and say it listens in time, or it fails rather than holding its slot for ever.
        turn.timer = setTimeout(() => this.timedOut(key, turn), this.options.timeoutMs ?? 20000);
        this.sendIfReady(key);
        return true;
      },
      priority,
    );
  }

  private askShow(key: FrameKey): void {
    const hold = this.holdOf(key);
    const revision = this.state.revision;
    this.budget.show(
      hold,
      () => {
        if (this.holds.get(key) !== hold || revision !== this.state.revision || this.state.frameStates[key]?.state !== "measured" || !this.isVisible(key)) {
          this.budget.release(hold);
          if (this.holds.get(key) === hold) this.holds.delete(key);
          return;
        }
        this.askTurn(key, "show", PRIORITY.onScreen);
      },
      () => this.parkedBy(key, hold),
    );
  }

  /** The budget took a shown frame's hold back for a frame that must be measured: it is parked, and asks again while it is near the screen. */
  private parkedBy(key: FrameKey, hold: symbol): void {
    if (this.holds.get(key) !== hold) return;
    this.holds.delete(key);
    this.park(key);
    queueMicrotask(() => this.schedule(key));
  }

  private holdOf(key: FrameKey): symbol {
    let hold = this.holds.get(key);
    if (!hold) {
      hold = Symbol(key);
      this.holds.set(key, hold);
    }
    return hold;
  }

  private markDrawn(key: FrameKey): void {
    if (!this.lives.has(key) || this.drawn.has(key)) return;
    this.drawn.add(key);
    this.tellLive();
  }

  private goLive(key: FrameKey): void {
    if (this.lives.has(key)) return;
    this.lives.set(key, (this.epoch += 1));
    this.tellLive();
  }

  /** Takes a frame out of the DOM, keeping its snapshot: its show turn and its hold end, and it is at the top when it is drawn again. */
  private park(key: FrameKey): void {
    const turn = this.turns.get(key);
    if (turn?.purpose === "show") this.endTurn(key);
    const hold = this.holds.get(key);
    if (hold) {
      this.holds.delete(key);
      this.budget.release(hold);
    }
    this.drawn.delete(key);
    if (this.lives.delete(key)) this.tellLive();
    if (this.scrolls.delete(key)) this.tellScroll();
  }

  /** Asks a frame to render once it listens, packages and pages are ready, and its turn at a slot has come. */
  private sendIfReady(key: FrameKey): void {
    const turn = this.turns.get(key);
    const attached = this.attached.get(key);
    const frame = this.frameOf(key);
    if (!turn?.granted || turn.channel !== null || !attached?.ready || attached.generation !== this.state.revision || !frame || !this.canRender(frame)) return;
    if (turn.purpose === "measure" && this.state.frameStates[key]?.state !== "waiting") return;
    turn.channel = attached.channel;
    clearTimeout(turn.timer);
    turn.timer = setTimeout(() => this.timedOut(key, turn), this.options.timeoutMs ?? 20000);
    this.send(key, attached, frame, turn.purpose === "measure");
  }

  private timedOut(key: FrameKey, turn: Turn): void {
    if (this.turns.get(key) !== turn) return;
    this.endTurn(key);
    if (turn.purpose === "show") return;
    const seconds = Math.round((this.options.timeoutMs ?? 20000) / 1000);
    const state = this.state.frameStates[key]?.state;
    if (turn.channel === null && state === "waiting") this.setFrame(key, { state: "failed", stage: "timeout", message: `The frame did not load within ${seconds} s.` });
    else if (state === "rendering") this.setFrame(key, { state: "failed", stage: "timeout", message: `The frame did not answer within ${seconds} s.` });
    else return;
    this.park(key);
    this.scheduleAll();
    this.finishIfDone();
  }

  /** Ends a frame's turn: its timer stops and its slot, held or asked for, is given back. */
  private endTurn(key: FrameKey): void {
    const turn = this.turns.get(key);
    if (!turn) return;
    clearTimeout(turn.timer);
    this.turns.delete(key);
    this.slots.release(turn.token);
  }

  /** Ends every turn and hold, and parks every frame: a new revision or the session's end. */
  private endAll(): void {
    // Each map is emptied before anything is given back, so a slot or hold freed here cannot start one of these frames again.
    const turns = [...this.turns.values()];
    this.turns.clear();
    for (const turn of turns) {
      clearTimeout(turn.timer);
      this.slots.release(turn.token);
    }
    const holds = [...this.holds.values()];
    this.holds.clear();
    for (const hold of holds) this.budget.release(hold);
    this.drawn.clear();
    if (this.lives.size > 0) {
      this.lives.clear();
      this.tellLive();
    }
    if (this.scrolls.size > 0) {
      this.scrolls.clear();
      this.tellScroll();
    }
  }

  private send(key: FrameKey, attached: Attached, spec: FrameSpec, measure: boolean): void {
    const packages = this.resolved;
    if (!packages || !spec.page || !spec.pageType) return;
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
    if (measure) this.setFrame(key, { state: "rendering" });
    attached.frame.contentWindow?.postMessage(request, "*");
  }

  private frameOf(key: FrameKey): FrameSpec | undefined {
    return this.state.frames.find((frame) => frame.key === key);
  }

  private setFrame(key: FrameKey, value: FrameState): void {
    this.set({ frameStates: { ...this.state.frameStates, [key]: value } });
  }

  private failAll(message: string): void {
    const frameStates: Record<FrameKey, FrameState> = { ...this.state.frameStates };
    for (const frame of this.state.frames) if (frameStates[frame.key]?.state !== "failed") frameStates[frame.key] = { state: "failed", stage: "setup", message };
    this.endAll();
    this.set({ frameStates });
    this.finishIfDone();
  }

  /** Once every frame of the revision has answered, core checks the prototype with the snapshots it has. */
  private finishIfDone(): void {
    const { frames, frameStates, measured, revision } = this.state;
    if (measured || this.finishing === revision || !this.config || !this.prototype) return;
    const states = frames.map((frame) => frameStates[frame.key]);
    if (states.some((state) => state === undefined || state.state === "waiting" || state.state === "rendering")) return;
    const snapshots = states.flatMap((state) => (state?.state === "measured" ? [state.snapshot] : []));
    this.finishing = revision;
    this.engine.run({ kind: "measure", session: this.id, revision, config: this.config, prototype: this.prototype, snapshots }).then(
      (report) => {
        if (revision === this.state.revision) this.set({ report, measured: true });
      },
      (error: unknown) => console.error("design-harness: core's check failed", error),
    );
  }
}

/** Whether a frame drawn again measured exactly what it measured first. */
function sameSnapshot(a: RenderedSnapshot, b: RenderedSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * One frame per scenario and view, in the prototype's scenario order and the
 * config's view order. A spec prototype's pages are core's resolved specs:
 * given in `payloads` by scenario id (as the engine returns them), worked
 * out here when it is undefined, or not known yet when it is null, which
 * leaves such a frame without its page and not blocked until they are.
 */
export function frameSpecs(config: ProjectConfig, prototype: Prototype, payloads?: Readonly<Record<string, SpecPayload | null>> | null): FrameSpec[] {
  const pageTypes = new Map(config.inventories.pageTypes.map((type) => [type.id, type]));
  const parts = prototype.format === "spec" && payloads === undefined ? specParts(config) : {};
  return prototype.scenarios.flatMap((scenario) => {
    const page = prototype.pages.find((item) => item.id === scenario.page);
    const pageType = page ? pageTypes.get(page.pageType) : undefined;
    const pending = prototype.format === "spec" && payloads === null;
    const payload = page && prototype.format === "spec" && !pending ? (payloads ? (payloads[scenario.id] ?? null) : specPayload(config, prototype, scenario, parts)) : null;
    const ref: PageRef | undefined = !page ? undefined : prototype.format === "spec" ? (payload ? { spec: payload } : undefined) : { module: moduleSpecifier(page.component.file), export: page.component.export };
    const blocked = !page
      ? `Scenario "${scenario.id}" names page "${scenario.page}", which is not in the prototype's manifest.`
      : !pageType
        ? `Page "${page.id}" is a "${page.pageType}" page, which is not a page type in the project's inventory, so the shell has no slots to lay out.`
        : prototype.files[page.component.file] === undefined
          ? `Page "${page.id}" names ${page.component.file}, which is not a file in the prototype.`
          : !ref && !pending
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
