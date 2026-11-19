import { Badge, Button, Field, Loader, Popover, Stack, Text, ToggleGroup, Toolbar, VisuallyHidden, useHotkey, usePopover } from "@tounsoo/todae";
import { ArrowLeft, Grid3x3, ListPlus, Maximize2, MessageSquarePlus, PanelBottomDashed, Pointer, ZoomIn, ZoomOut } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { flowFacts, viewFacts, type Finding, type ProjectConfig, type RenderedSnapshot } from "@design-harness/core";
import { FRAME_SANDBOX } from "../runtime/frame-document";
import { PACKAGES_UNAVAILABLE } from "../runtime/package-source";
import { frameKey, type FramePresence, type FrameSpec, type FrameState, type Session, type SessionState } from "../runtime/session";
import { planOutline } from "../runtime/tags";
import { cameraMove } from "../visual/camera";
import { coverage } from "../visual/coverage";
import { CoverageGrid } from "../visual/CoverageGrid";
import { LENSES, lensDrawing, placeLens, type LensId } from "../visual/lens";
import { LensLayer, LensWords } from "../visual/LensLayer";
import { anchorAt, anchorOn, elementChoices } from "../pins/anchor";
import type { PinState } from "../pins/model";
import { PinContext, PinLayer, useMeasure, type PinActions, type PinBoard, type PinDraft } from "../pins/PinLayer";
import { SHORTCUTS, ariaKeys } from "./shortcuts";
import { artboardLabel, frameName, scenarioLabel, screenTitle, viewLabel } from "./words";

/** Fit, or a fixed scale. The zoom buttons step through the fixed ones. */
const ZOOMS = ["0.25", "0.5", "0.75", "1"] as const;
type Zoom = "fit" | (typeof ZOOMS)[number];

/** What the rest of the app may ask of the board. */
export type BoardHandle = {
  /** Scrolls to an artboard, back on the board if another was open at full size, and moves focus to it. */
  readonly goTo: (key: string) => void;
  /** Moves the camera to a pinned note, as "Show me" does for a finding, and opens its card. */
  readonly showPin: (number: number) => void;
};

/** The open prototype's pinned notes, and "Pin a note" mode, which the workspace owns. */
export type BoardPins = {
  readonly state: PinState;
  readonly pinning: boolean;
  readonly onPinning: (next: boolean) => void;
  readonly actions: PinActions;
  /** The open prototype's revision, and what its element tags are (`pins/anchor.ts`). */
  readonly revision: string;
  readonly kind: "source" | "key";
  /** Says whether Escape is the board's now: pin mode is on, or a note's card is open. */
  readonly onHold?: (held: boolean) => void;
};

/**
 * The canvas: the prototype's frames as artboards on a calm board, one row
 * per scenario and one artboard per view, light views on one line and dark
 * views on the next, each a live render scaled to fit. A frame opens at
 * full size in place, without being moved in the DOM, since moving an
 * iframe reloads it. In canvas-only mode the toolbar floats over the board
 * with what that mode keeps: `floating` holds its parts.
 *
 * Selecting a finding moves the camera (`visual/camera.ts`): the board
 * scrolls to its artboard, and opens it at full size when the element would
 * be too small to see at the board's zoom. A lens (`visual/lens.ts`) draws
 * one family of rules over every artboard at once, from core's facts.
 */
export function Board({
  session,
  state,
  selected,
  floating,
  config,
  pins,
  ref,
}: {
  readonly session: Session;
  readonly state: SessionState;
  readonly selected: Finding | null;
  /** The project's config, which the lenses and the coverage grid read core's facts with. */
  readonly config?: ProjectConfig | undefined;
  readonly ref?: Ref<BoardHandle>;
  /** The prototype's pinned notes; absent, the board draws none and offers no pin mode. */
  readonly pins?: BoardPins | undefined;
  /** Canvas only: the floating bar's start (the prototype's name) and end (status and the way back). */
  readonly floating?: { readonly start: ReactNode; readonly end: ReactNode } | undefined;
}) {
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [focused, setFocused] = useState<string | null>(null);
  const [lens, setLens] = useState<LensId | null>(null);
  /** What the camera last did, for a screen reader. */
  const [said, setSaid] = useState("");
  /** The artboard the camera opened by itself, so it can close it again when the finding is put down. */
  const opened = useRef<string | null>(null);
  const [pointed, setPointed] = useState<string | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const scenarios = useMemo(() => {
    const rows = new Map<string, FrameSpec[]>();
    for (const frame of state.frames) rows.set(frame.scenario.id, [...(rows.get(frame.scenario.id) ?? []), frame]);
    return [...rows.values()];
  }, [state.frames]);
  // A scenario's views in lines by colour scheme, so its light and dark renders sit one above the other.
  const lines = useMemo(() => scenarios.map(linesOf), [scenarios]);

  // Fit: every view of one line side by side across the board's width.
  const rowWidth = Math.max(1, ...lines.flat().map((line) => line.reduce((sum, frame) => sum + frame.view.width, 0)));
  // The board's padding, the gaps between artboards, and a little slack so rounding never wraps a line.
  const gaps = 40 * Math.max(0, Math.max(1, ...lines.flat().map((line) => line.length)) - 1) + 80 + 8;
  const fit = Math.min(1, Math.max(0.12, (width - gaps) / rowWidth));
  const scale = zoom === "fit" ? fit : Number(zoom);
  const selectedKey = selected?.scenario !== undefined && selected.view !== undefined ? frameKey(selected.scenario, selected.view) : null;
  // A finding about elements is outlined in every frame that drew them.
  const outlined = useMemo(() => new Set(selected ? (planOutline(selected, state.frames, state.frameStates)?.frames.map((frame) => frame.key) ?? []) : []), [selected, state.frames, state.frameStates]);
  const focusedSpec = state.frames.find((frame) => frame.key === focused);
  const views = state.frames.length / Math.max(1, scenarios.length);

  const cardOf = (key: string) => [...(area.current?.querySelectorAll<HTMLElement>(".frame-card") ?? [])].find((card) => card.dataset.frameKey === key);
  const bringIntoView = (key: string, focus: boolean) => {
    // After the board has laid out again, when an artboard was opened or closed on the way.
    requestAnimationFrame(() => {
      const card = cardOf(key);
      if (!card) return;
      card.scrollIntoView({ block: "center", inline: "center" });
      if (focus) card.focus({ preventScroll: true });
    });
  };
  const goTo = (key: string) => {
    const spec = state.frames.find((frame) => frame.key === key);
    if (!spec) return;
    opened.current = null;
    setFocused(null);
    setPointed(key);
    setSaid(`Showing ${frameName(spec.scenario, spec.view.name)}.`);
    bringIntoView(key, true);
  };
  // Pinned notes: which card is open, and the note being written. A pin is the app's own drawing over an artboard, and moves nothing.
  const [openPin, setOpenPin] = useState<number | null>(null);
  const [draft, setDraftState] = useState<PinDraft | null>(null);
  const [focusPin, setFocusPin] = useState<number | null>(null);
  const pinning = pins?.pinning ?? false;
  const setDraft = useCallback((next: PinDraft | null) => {
    setDraftState((before) => {
      // A note started from a frame's list and put down gives focus back to that list's button, without a scroll.
      if (next === null && before?.list) requestAnimationFrame(() => cardOf(before.frame)?.querySelector<HTMLElement>(".frame-pin")?.focus({ preventScroll: true }));
      return next;
    });
  }, []);
  const pinActions = pins?.actions;
  const actions = useMemo(
    (): PinActions | null =>
      pinActions
        ? {
            ...pinActions,
            create: (anchor, note) => {
              const number = pinActions.create(anchor, note);
              if (number !== null) setFocusPin(number);
              return number;
            },
          }
        : null,
    [pinActions],
  );
  const focusedPin = useCallback(() => setFocusPin(null), []);
  const pinBoard = useMemo(
    (): PinBoard | null => (pins && actions ? { state: pins.state, pinning: pins.pinning, actions, revision: pins.revision, kind: pins.kind, open: openPin, setOpen: setOpenPin, draft, setDraft, focus: focusPin, focused: focusedPin } : null),
    [pins, actions, openPin, draft, setDraft, focusPin, focusedPin],
  );
  // Leaving pin mode puts down a note not yet pinned.
  useEffect(() => {
    if (!pinning) setDraftState(null);
  }, [pinning]);
  const hold = pinning || openPin !== null || draft !== null;
  const onHold = pins?.onHold;
  useEffect(() => {
    onHold?.(hold);
    return () => onHold?.(false);
  }, [hold, onHold]);
  // Escape leaves pin mode, once no card is open: a card takes its own Escape first.
  useHotkey(SHORTCUTS.leave.keys, () => pins?.onPinning(false), { enabled: pinning && openPin === null && draft === null });

  const showPin = (number: number) => {
    const pin = pins?.state.pins.find((item) => item.number === number);
    if (!pin) return;
    const key = frameKey(pin.anchor.scenario, pin.anchor.view);
    const spec = state.frames.find((frame) => frame.key === key);
    if (!spec) {
      setSaid(`Note ${number}'s frame is no longer in the prototype.`);
      return;
    }
    const name = frameName(spec.scenario, spec.view.name);
    const rect = pin.anchor.element?.label?.rect ?? pin.anchor.element?.source?.rect;
    opened.current = null;
    setDraftState(null);
    if (cameraMove(rect, scale) === "open") {
      setFocused(key);
      setSaid(`Opened ${name} at full size to show note ${number}.`);
      const point = pin.anchor.point;
      const within = session.scrollOf(key);
      requestAnimationFrame(() => {
        const board = area.current;
        const viewport = cardOf(key)?.querySelector(".frame-viewport");
        if (board && viewport) {
          const from = board.getBoundingClientRect();
          const at = viewport.getBoundingClientRect();
          board.scrollTo({ left: board.scrollLeft + at.left - from.left + point.x - within.x - board.clientWidth / 2, top: board.scrollTop + at.top - from.top + point.y - within.y - board.clientHeight / 2 });
        }
        setOpenPin(number);
      });
    } else {
      if (focused !== null && focused !== key) setFocused(null);
      setPointed(key);
      setSaid(`Showing note ${number} on ${name}.`);
      bringIntoView(key, false);
      // After the camera has moved, so the card opens beside a pin that is on screen.
      requestAnimationFrame(() => requestAnimationFrame(() => setOpenPin(number)));
    }
  };
  useImperativeHandle(ref, () => ({ goTo, showPin }));
  useEffect(() => {
    if (pointed === null) return;
    const timer = setTimeout(() => setPointed(null), 2400);
    return () => clearTimeout(timer);
  }, [pointed]);

  // "Show me" moves the camera: to the finding's artboard, opened at full size when its element would be too small to see.
  const selectedId = selected ? JSON.stringify(selected) : null;
  const target = selectedKey ?? [...outlined][0] ?? null;
  const targetState = target ? state.frameStates[target] : undefined;
  const targetRect = selected?.element !== undefined && targetState?.state === "measured" ? targetState.snapshot.elements[selected.element]?.rect : undefined;
  const rectId = targetRect ? `${targetRect.width}x${targetRect.height}` : "";
  useEffect(() => {
    if (selectedId === null || target === null) {
      // The finding was put down: an artboard the camera opened goes back to the board.
      if (opened.current !== null) {
        const key = opened.current;
        opened.current = null;
        setFocused((now) => (now === key ? null : now));
        bringIntoView(key, false);
      }
      return;
    }
    const spec = state.frames.find((frame) => frame.key === target);
    if (!spec) return;
    const name = frameName(spec.scenario, spec.view.name);
    if (cameraMove(targetRect, scale) === "open") {
      opened.current = target;
      setFocused(target);
      setSaid(`Opened ${name} at full size: what the finding points at is too small to see at ${Math.round(scale * 100)}%.`);
      // Once it is laid out at full size, the board scrolls so the element itself is in the middle of what shows.
      const rect = targetRect;
      const within = session.scrollOf(target);
      requestAnimationFrame(() => {
        const board = area.current;
        const viewport = cardOf(target)?.querySelector(".frame-viewport");
        if (!board || !viewport || !rect) return;
        const from = board.getBoundingClientRect();
        const at = viewport.getBoundingClientRect();
        board.scrollTo({ left: board.scrollLeft + at.left - from.left + rect.x + rect.width / 2 - within.x - board.clientWidth / 2, top: board.scrollTop + at.top - from.top + rect.y + rect.height / 2 - within.y - board.clientHeight / 2 });
      });
    } else {
      if (focused !== null && focused !== target) {
        opened.current = null;
        setFocused(null);
      }
      setSaid(`Showing ${name}.`);
      bringIntoView(target, false);
    }
    // Only a new finding, or its frame being measured, moves the camera: zooming or scrolling afterwards is the person's own.
  }, [selectedId, target, rectId]);

  const grid = useMemo(() => {
    const current = session.current();
    return config && current ? coverage(flowFacts(config, current.prototype), state.frames, state.frameStates, state.report, state.measured) : null;
    // The session's prototype changes only with its revision.
  }, [config, session, state.revision, state.frames, state.frameStates, state.report, state.measured]);
  const [gridOpen, setGridOpen] = useState(false);
  const popover = usePopover({ open: gridOpen, onOpenChange: (next) => setGridOpen(next) });

  const summary = `${scenarios.length} ${scenarios.length === 1 ? "scenario" : "scenarios"} · ${views} ${views === 1 ? "view" : "views"}`;
  const lensControl = (
    <ToggleGroup.Root aria-label="Lens" value={lens} onValueChange={(value) => setLens((value as LensId | null) ?? null)} className="board-lens" data-testid="lens-control">
      {LENSES.map((item) => (
        <ToggleGroup.Item key={item.id} value={item.id} variant="ghost" data-lens={item.id} {...(floating ? { "aria-label": item.label } : {})} title={item.hint}>
          <Button.Icon>{item.id === "targets" ? <Pointer /> : <PanelBottomDashed />}</Button.Icon>
          {!floating && item.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );

  const pinControl = pins ? (
    <Button.Root
      variant="ghost"
      className="board-pin"
      pressed={pinning}
      onPressedChange={(next) => pins.onPinning(next)}
      aria-label={`Pin a note (${SHORTCUTS.pin.label})`}
      aria-keyshortcuts={ariaKeys(SHORTCUTS.pin)}
      data-testid="pin-mode"
    >
      <Button.Icon>
        <MessageSquarePlus />
      </Button.Icon>
      {!floating && "Pin a note"}
    </Button.Root>
  ) : null;

  const step = (direction: 1 | -1) => {
    const next = direction > 0 ? ZOOMS.find((value) => Number(value) > scale + 0.001) : [...ZOOMS].reverse().find((value) => Number(value) < scale - 0.001);
    if (next) setZoom(next);
  };

  const zoomControls = (
    <Stack.Root direction="row" align="center" gap="condensed" className="board-zoom">
      <Button.Root variant="ghost" aria-label="Zoom out" onClick={() => step(-1)} disabled={scale <= Number(ZOOMS[0]) + 0.001}>
        <Button.Icon>
          <ZoomOut />
        </Button.Icon>
      </Button.Root>
      <Field.Root aria-label="Zoom" className="board-zoom-field">
        <Field.Select value={zoom} onValueChange={(value) => setZoom(value as Zoom)}>
          <option value="fit">Fit ({Math.round(fit * 100)}%)</option>
          {ZOOMS.map((value) => (
            <option key={value} value={value}>
              {Number(value) * 100}%
            </option>
          ))}
        </Field.Select>
      </Field.Root>
      <Button.Root variant="ghost" aria-label="Zoom in" onClick={() => step(1)} disabled={scale >= 1 - 0.001}>
        <Button.Icon>
          <ZoomIn />
        </Button.Icon>
      </Button.Root>
    </Stack.Root>
  );

  return (
    <PinContext value={pinBoard}>
    <div className="board" data-focused={focused ? "" : undefined} data-floating={floating ? "" : undefined} data-engine={session.engineWhere()} data-pinning={pinning ? "" : undefined}>
      <Toolbar.Root aria-label="Canvas" className="board-toolbar">
        {floating && <div className="board-toolbar-start">{floating.start}</div>}
        {focusedSpec ? (
          <Stack.Root direction="row" align="center" gap="condensed">
            <Button.Root variant="ghost" onClick={() => setFocused(null)}>
              <Button.Icon>
                <ArrowLeft />
              </Button.Icon>
              Back to board
            </Button.Root>
            <Text.Root as="span" className="board-focus-label">
              {artboardLabel(focusedSpec.scenario, focusedSpec.view.name)}, full size
            </Text.Root>
          </Stack.Root>
        ) : null}
        {focusedSpec ? (
          <span className="board-lens-end">
            {lensControl}
            {pinControl}
          </span>
        ) : (
          <>
            {!floating &&
              (grid ? (
                <>
                  <Button.Root variant="ghost" className="board-summary" data-testid="board-summary" tooltip={false} {...popover.getTriggerProps()}>
                    <Button.Icon>
                      <Grid3x3 />
                    </Button.Icon>
                    {summary}
                  </Button.Root>
                  <Popover.Root {...popover.getPopoverProps()} role="dialog" aria-label="Coverage: every state, every view" className="board-coverage">
                    {gridOpen && (
                      <CoverageGrid
                        coverage={grid}
                        onGo={(key) => {
                          setGridOpen(false);
                          goTo(key);
                        }}
                      />
                    )}
                  </Popover.Root>
                </>
              ) : (
                <Text.Root as="span" tone="muted" className="board-summary">
                  {summary}
                </Text.Root>
              ))}
            <span className="board-lens-end">
              {lensControl}
              {pinControl}
            </span>
            {zoomControls}
          </>
        )}
        {floating && <div className="board-toolbar-end">{floating.end}</div>}
      </Toolbar.Root>
      <VisuallyHidden.Root role="status" aria-live="polite" data-testid="board-said">
        {said}
      </VisuallyHidden.Root>
      {pinning && (
        <Text.Root as="p" className="board-pinning" data-testid="pin-hint">
          Click a spot on any frame to pin a note there, or pick an element from a frame's list. <kbd>Esc</kbd> leaves.
        </Text.Root>
      )}
      <div className="board-area" ref={area}>
        {state.packages.state === "failed" && <p className="board-error">{state.packages.message}</p>}
        {scenarios.map((row, rowIndex) => {
          const first = row[0];
          if (!first) return null;
          const title = screenTitle(first.scenario);
          const example = scenarioLabel(first.scenario.id);
          return (
            <section key={first.scenario.id} className="board-row" aria-label={`${title}: ${example}`}>
              <div className="board-row-head">
                <Text.Root as="h2" className="board-row-title">
                  {title}
                </Text.Root>
                <Text.Root as="span" variant="label" className="board-row-meta">
                  {example}
                </Text.Root>
              </div>
              {(lines[rowIndex] ?? [row]).map((line) => (
                <div key={line[0]?.view.scheme ?? "light"} className="board-frames" data-scheme={line[0]?.view.scheme}>
                  {line.map((spec) => (
                    <FrameCard
                      key={spec.key}
                      session={session}
                      spec={spec}
                      packagesHint="What you can do is above the canvas."
                      revision={state.revision}
                      frameState={state.frameStates[spec.key] ?? { state: "waiting" }}
                      scale={focused === spec.key ? 1 : scale}
                      focused={focused === spec.key}
                      hidden={focused !== null && focused !== spec.key}
                      selected={selectedKey === spec.key || outlined.has(spec.key)}
                      pointed={pointed === spec.key}
                      lens={lens}
                      config={config}
                      onOpen={() => {
                        opened.current = null;
                        setFocused(spec.key);
                      }}
                    />
                  ))}
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </div>
    </PinContext>
  );
}

/** A scenario's frames in lines, one per colour scheme, in the order the schemes first appear. */
function linesOf(row: readonly FrameSpec[]): FrameSpec[][] {
  const lines = new Map<string, FrameSpec[]>();
  for (const frame of row) lines.set(frame.view.scheme, [...(lines.get(frame.view.scheme) ?? []), frame]);
  return [...lines.values()];
}

function statusOf(frameState: FrameState): { tone: "neutral" | "success" | "critical" | "info"; text: string } | null {
  switch (frameState.state) {
    case "waiting":
      return { tone: "neutral", text: "Waiting to measure" };
    case "rendering":
      return { tone: "info", text: "Measuring" };
    case "measured":
      return null;
    case "failed":
      return { tone: "critical", text: frameState.stage === "timeout" ? "No answer" : `Failed to ${frameState.stage}` };
  }
}

export type CardProps = {
  readonly session: Session;
  readonly spec: FrameSpec;
  readonly revision: number;
  readonly frameState: FrameState;
  readonly scale: number;
  readonly focused: boolean;
  readonly hidden: boolean;
  readonly selected: boolean;
  /** Opens the frame at full size; without it the card has no Open button. */
  readonly onOpen?: () => void;
  /** Names the frame when the same scenario is shown more than once, as a proposal's examples are: "two-toasts: lantern-open at desktop". */
  readonly label?: string;
  /** The label as the artboard's head shows it, when the label is an id ("Two toasts" for "two-toasts"); empty where what holds the artboard already names it. */
  readonly caption?: string;
  /** The coverage grid or the flow map just went to this artboard. */
  readonly pointed?: boolean;
  /** The lens drawn over the artboard once it is measured, and the config its facts are read with. */
  readonly lens?: LensId | null;
  readonly config?: ProjectConfig | undefined;
  /** Shown under a failure to load packages: where the person finds what to do about it. */
  readonly packagesHint?: string;
};

/**
 * One frame of a session as an artboard: its live iframe, scaled, with its
 * view and size above it, quiet unless it is still measuring or failed. The
 * review page shows examples with it too.
 */
export function FrameCard({ session, spec, revision, frameState, scale, focused, hidden, selected, onOpen, label, caption, pointed, lens, config, packagesHint }: CardProps) {
  const name = `${label ? `${label}: ` : ""}${spec.scenario.id} at ${spec.view.name}`;
  const status = statusOf(frameState);
  const { width, height } = spec.view;
  // The lens is drawn only over a measured frame, from core's facts for its snapshot: while a revision measures there is nothing true to draw.
  const snapshot = frameState.state === "measured" ? frameState.snapshot : null;
  const drawing = useMemo(() => (lens && config && snapshot ? lensDrawing(lens, viewFacts(config, spec.view, snapshot), snapshot, spec.view) : null), [lens, config, snapshot, spec.view]);
  const placed = useMemo(() => (drawing ? placeLens(drawing, spec.view, scale) : null), [drawing, spec.view, scale]);
  // Pinned notes, where the board carries them: drawn over the artboard from what the frame measured, live or parked.
  const pinBoard = useContext(PinContext);
  const measure = useMeasure(spec, frameState);
  const words = frameName(spec.scenario, spec.view.name);
  const pinFromList = () => {
    if (!pinBoard || !measure) return;
    const frame = { scenario: spec.scenario.id, view: spec.view.name };
    const first = elementChoices(measure)[0];
    const anchor = (first ? anchorOn(measure, frame, first.index, pinBoard.revision, pinBoard.kind) : null) ?? anchorAt(measure, frame, { x: width / 2, y: height / 2 }, pinBoard.revision, pinBoard.kind);
    pinBoard.setOpen(null);
    pinBoard.setDraft({ frame: spec.key, anchor, list: true });
  };
  return (
    <figure
      className="frame-card"
      style={{ width: width * scale }}
      tabIndex={-1}
      data-frame-key={spec.key}
      data-state={frameState.state}
      data-selected={selected ? "" : undefined}
      data-pointed={pointed ? "" : undefined}
      data-focused={focused ? "" : undefined}
      data-hidden={hidden ? "" : undefined}
      data-lens={drawing ? lens : undefined}
      aria-hidden={hidden || undefined}
    >
      <figcaption className="frame-head">
        <Text.Root as="span" weight="medium" className="frame-view">
          {(caption ?? label) ? `${caption ?? label} · ` : ""}
          {viewLabel(spec.view.name)}
        </Text.Root>
        <Text.Root as="span" tone="muted" className="frame-size">
          {width} × {height}
          {spec.view.scheme === "dark" ? " · dark" : ""}
        </Text.Root>
        {status && (
          <Badge.Root tone={status.tone} className="frame-status">
            {status.tone === "info" && <Loader.Root variant="dots" aria-hidden="true" />}
            {status.text}
          </Badge.Root>
        )}
        {pinBoard?.pinning && !hidden && (
          <Button.Root variant="ghost" onClick={pinFromList} disabled={!measure} aria-label={`Pin a note on ${words}: pick an element from a list`} className="frame-pin" data-testid="pin-from-list">
            <Button.Icon>
              <ListPlus />
            </Button.Icon>
          </Button.Root>
        )}
        {!focused && onOpen && (
          <Button.Root variant="ghost" onClick={onOpen} aria-label={`Open ${frameName(spec.scenario, spec.view.name)} at full size`} className="frame-open">
            <Button.Icon>
              <Maximize2 />
            </Button.Icon>
          </Button.Root>
        )}
      </figcaption>
      <div className="frame-stage" style={{ paddingBlockEnd: placed ? placed.below : 0 }}>
        <FrameViewport session={session} spec={spec} revision={revision} frameState={frameState} scale={scale} hidden={hidden} name={name} {...(packagesHint ? { packagesHint } : {})} />
        {placed && !hidden && <LensLayer session={session} frame={spec.key} placed={placed} scale={scale} scheme={spec.view.scheme} />}
        {pinBoard && !hidden && <PinLayer session={session} spec={spec} scale={scale} measure={measure} name={words} />}
      </div>
      {drawing && !hidden && <LensWords drawing={drawing} />}
    </figure>
  );
}

/**
 * Whether the frames under it are on a view the person can see: false for
 * the board while another view is open over it, where it stays laid out
 * (and measuring) but out of sight, so its frames are parked.
 */
export const FramesShown = createContext(true);

/** The nearest ancestor that scrolls, which is what "near the screen" is measured against; null for the page itself. */
function scroller(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (/(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflowX}`)) return parent;
  }
  return null;
}

/**
 * Calls `near` with whether an element is on screen or within half a screen
 * of it, in the area that scrolls it, and again whenever that changes.
 * Without IntersectionObserver every frame counts as near, as before.
 */
function watchNear(element: HTMLElement, near: (value: boolean) => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    near(true);
    return () => undefined;
  }
  const observer = new IntersectionObserver((entries) => {
    const last = entries.at(-1);
    if (last) near(last.isIntersecting);
  }, { root: scroller(element), rootMargin: "50% 25%" });
  observer.observe(element);
  return () => observer.disconnect();
}

/**
 * One frame's iframe, scaled, with its failure over it when it has one:
 * the artboard without its label, for where the frame is a picture inside
 * something else, as a role's preview is.
 *
 * The iframe is in the DOM only while the session keeps the frame live
 * (`Session.liveOf`): while it renders to be measured, and afterwards while
 * it is near the screen and the live-frame budget has room. Otherwise the
 * frame is parked, and the viewport keeps its size and draws what the
 * snapshot measured, as outlines, until it is drawn again.
 */
export function FrameViewport({ session, spec, revision, frameState, scale, hidden, name, fit, packagesHint }: Pick<CardProps, "session" | "spec" | "revision" | "frameState" | "scale" | "hidden" | "packagesHint"> & { readonly name: string; /** Show only as much of the view as the page fills, once it is measured. */ readonly fit?: boolean }) {
  const shown = useContext(FramesShown);
  const box = useRef<HTMLDivElement>(null);
  const presence = useRef<FramePresence | null>(null);
  const [near, setNear] = useState(false);
  // Drawn here: the session measures the frame, near the screen first.
  useEffect(() => {
    if (spec.blocked) return;
    const present = session.present(spec.key);
    presence.current = present;
    return () => {
      present.leave();
      if (presence.current === present) presence.current = null;
    };
  }, [session, spec.key, spec.blocked]);
  useEffect(() => {
    const element = box.current;
    return element ? watchNear(element, setNear) : undefined;
  }, []);
  const visible = near && !hidden && shown;
  useEffect(() => {
    presence.current?.visible(visible);
  }, [visible, session, spec.key, spec.blocked]);
  const live = useSyncExternalStore(session.subscribeLive, () => session.liveOf(spec.key));
  const drawn = useSyncExternalStore(session.subscribeLive, () => session.drawnOf(spec.key));
  // A fresh document, on a fresh channel, for every revision and every time the frame goes live.
  const doc = useMemo(() => (spec.blocked || live === null ? null : session.documentFor(spec.key)), [session, spec.key, spec.blocked, revision, live]);
  // One stable ref per document: a new callback on each render would detach and re-attach the frame.
  const attach = useCallback(
    (element: HTMLIFrameElement | null) => {
      if (!doc) return;
      session.attach(spec.key, element, doc.generation, doc.channel);
      return () => session.attach(spec.key, null, doc.generation, doc.channel);
    },
    [session, spec.key, doc],
  );
  const { width } = spec.view;
  // The lowest thing the page painted, with the room the shell leaves above the first.
  const filled = fit && frameState.state === "measured" ? frameState.snapshot.elements.filter((element) => element.visible).reduce((bottom, element) => Math.max(bottom, element.rect.y + element.rect.height), 0) : 0;
  const top = fit && frameState.state === "measured" ? frameState.snapshot.elements.filter((element) => element.visible).reduce((least, element) => Math.min(least, element.rect.y), Number.POSITIVE_INFINITY) : 0;
  const height = filled > 0 && Number.isFinite(top) ? Math.min(spec.view.height, Math.ceil(filled + Math.max(top, 0))) : spec.view.height;
  return (
    <div ref={box} className="frame-viewport" data-frame-name={name} data-live={doc ? "" : undefined} data-drawn={doc && drawn ? "" : undefined} style={{ width: width * scale, height: height * scale, background: spec.view.scheme === "dark" ? "#121212" : "#ffffff" }}>
      {doc ? (
        <iframe
          key={doc.channel}
          ref={attach}
          title={name}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={doc.html}
          width={width}
          height={spec.view.height}
          className="frame-iframe"
          style={{ transform: `scale(${scale})`, colorScheme: spec.view.scheme }}
          tabIndex={hidden ? -1 : undefined}
        />
      ) : (
        frameState.state === "measured" && <ParkedFrame snapshot={frameState.snapshot} width={width} height={spec.view.height} scale={scale} />
      )}
      {frameState.state === "failed" && (
        <div className="frame-failure" role="status">
          <Text.Root as="p" weight="medium">
            {frameState.stage === "setup" ? "Not rendered" : frameState.stage === "timeout" ? "No answer" : `The page failed to ${frameState.stage}`}
          </Text.Root>
          <Text.Root as="p" className="pre">
            {frameState.message}
          </Text.Root>
          {packagesHint && frameState.stage === "setup" && frameState.message.startsWith(PACKAGES_UNAVAILABLE) && (
            <Text.Root as="p" weight="medium" data-testid="frame-packages-hint">
              {packagesHint}
            </Text.Root>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A parked frame: what its snapshot measured, drawn as outlines on the
 * page's canvas colour, controls as boxes and text as bars in the colour it
 * was painted. A picture of the data the checks read, never of pixels.
 */
function ParkedFrame({ snapshot, width, height, scale }: { readonly snapshot: RenderedSnapshot; readonly width: number; readonly height: number; readonly scale: number }) {
  const rgba = (color: readonly [number, number, number, number]) => `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3]})`;
  return (
    <svg className="frame-parked" data-testid="frame-parked" width={width * scale} height={height * scale} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
      <rect width={width} height={height} fill={rgba(snapshot.canvas)} />
      {snapshot.elements.map((element, index) =>
        !element.visible || element.rect.y > height ? null : element.interactive ? (
          <rect key={index} x={element.rect.x} y={element.rect.y} width={element.rect.width} height={element.rect.height} rx={4} fill="none" stroke={element.text ? rgba(element.text.color) : "currentColor"} strokeOpacity={0.5} strokeWidth={1.5} />
        ) : element.text ? (
          <rect key={index} x={element.rect.x} y={element.rect.y + element.rect.height * 0.2} width={element.rect.width} height={element.rect.height * 0.6} rx={2} fill={rgba(element.text.color)} fillOpacity={0.22} />
        ) : null,
      )}
    </svg>
  );
}
