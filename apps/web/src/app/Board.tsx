import { Badge, Button, Field, Loader, Stack, Text, Toolbar } from "@tounsoo/todae";
import { ArrowLeft, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Finding } from "@design-harness/core";
import { FRAME_SANDBOX } from "../runtime/frame-document";
import { frameKey, type FrameSpec, type FrameState, type Session, type SessionState } from "../runtime/session";
import { planOutline } from "../runtime/tags";
import { artboardLabel, scenarioLabel, screenTitle, viewLabel } from "./words";

/** Fit, or a fixed scale. The zoom buttons step through the fixed ones. */
const ZOOMS = ["0.25", "0.5", "0.75", "1"] as const;
type Zoom = "fit" | (typeof ZOOMS)[number];

/**
 * The canvas: the prototype's frames as artboards on a calm board, one row
 * per scenario and one artboard per view, each a live render scaled to fit.
 * A frame opens at full size in place, without being moved in the DOM, since
 * moving an iframe reloads it. In canvas-only mode the toolbar floats over
 * the board with what that mode keeps: `floating` holds its parts.
 */
export function Board({
  session,
  state,
  selected,
  floating,
}: {
  readonly session: Session;
  readonly state: SessionState;
  readonly selected: Finding | null;
  /** Canvas only: the floating bar's start (the prototype's name) and end (status and the way back). */
  readonly floating?: { readonly start: ReactNode; readonly end: ReactNode } | undefined;
}) {
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [focused, setFocused] = useState<string | null>(null);
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

  // Fit: every view of a scenario side by side across the board's width.
  const rowWidth = Math.max(1, ...scenarios.map((row) => row.reduce((sum, frame) => sum + frame.view.width, 0)));
  // The board's padding, the gaps between artboards, and a little slack so rounding never wraps a row.
  const gaps = 40 * Math.max(0, (scenarios[0]?.length ?? 1) - 1) + 80 + 8;
  const fit = Math.min(1, Math.max(0.12, (width - gaps) / rowWidth));
  const scale = zoom === "fit" ? fit : Number(zoom);
  const selectedKey = selected?.scenario !== undefined && selected.view !== undefined ? frameKey(selected.scenario, selected.view) : null;
  // A finding about elements is outlined in every frame that drew them.
  const outlined = useMemo(() => new Set(selected ? (planOutline(selected, state.frames, state.frameStates)?.frames.map((frame) => frame.key) ?? []) : []), [selected, state.frames, state.frameStates]);
  const focusedSpec = state.frames.find((frame) => frame.key === focused);
  const views = state.frames.length / Math.max(1, scenarios.length);

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
    <div className="board" data-focused={focused ? "" : undefined} data-floating={floating ? "" : undefined}>
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
        ) : (
          <>
            {!floating && (
              <Text.Root as="span" tone="muted" className="board-summary">
                {scenarios.length} {scenarios.length === 1 ? "scenario" : "scenarios"} · {views} {views === 1 ? "view" : "views"}
              </Text.Root>
            )}
            {zoomControls}
          </>
        )}
        {floating && <div className="board-toolbar-end">{floating.end}</div>}
      </Toolbar.Root>
      <div className="board-area" ref={area}>
        {state.packages.state === "failed" && <p className="board-error">{state.packages.message}</p>}
        {scenarios.map((row) => {
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
              <div className="board-frames">
                {row.map((spec) => (
                  <FrameCard
                    key={spec.key}
                    session={session}
                    spec={spec}
                    revision={state.revision}
                    frameState={state.frameStates[spec.key] ?? { state: "waiting" }}
                    scale={focused === spec.key ? 1 : scale}
                    focused={focused === spec.key}
                    hidden={focused !== null && focused !== spec.key}
                    selected={selectedKey === spec.key || outlined.has(spec.key)}
                    onOpen={() => setFocused(spec.key)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function statusOf(frameState: FrameState): { tone: "neutral" | "success" | "critical" | "info"; text: string } | null {
  switch (frameState.state) {
    case "waiting":
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
};

/**
 * One frame of a session as an artboard: its live iframe, scaled, with its
 * view and size above it, quiet unless it is still measuring or failed. The
 * review page shows examples with it too.
 */
export function FrameCard({ session, spec, revision, frameState, scale, focused, hidden, selected, onOpen, label }: CardProps) {
  const name = `${label ? `${label}: ` : ""}${spec.scenario.id} at ${spec.view.name}`;
  // A fresh document, on a fresh channel, for every revision.
  const doc = useMemo(() => (spec.blocked ? null : session.documentFor(spec.key)), [session, spec.key, spec.blocked, revision]);
  // One stable ref per document: a new callback on each render would detach and re-attach the frame.
  const attach = useCallback(
    (element: HTMLIFrameElement | null) => {
      if (!doc) return;
      session.attach(spec.key, element, doc.generation, doc.channel);
      return () => session.attach(spec.key, null, doc.generation, doc.channel);
    },
    [session, spec.key, doc],
  );
  const status = statusOf(frameState);
  const { width, height } = spec.view;
  return (
    <figure className="frame-card" style={{ width: width * scale }} data-frame-key={spec.key} data-state={frameState.state} data-selected={selected ? "" : undefined} data-focused={focused ? "" : undefined} data-hidden={hidden ? "" : undefined} aria-hidden={hidden || undefined}>
      <figcaption className="frame-head">
        <Text.Root as="span" weight="medium" className="frame-view">
          {label ? `${label} · ` : ""}
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
        {!focused && onOpen && (
          <Button.Root variant="ghost" onClick={onOpen} aria-label={`Open ${artboardLabel(spec.scenario, spec.view.name)} (${scenarioLabel(spec.scenario.id)}) at full size`} className="frame-open">
            <Button.Icon>
              <Maximize2 />
            </Button.Icon>
          </Button.Root>
        )}
      </figcaption>
      <div className="frame-viewport" style={{ width: width * scale, height: height * scale, background: spec.view.scheme === "dark" ? "#121212" : "#ffffff" }}>
        {doc && (
          <iframe
            key={doc.channel}
            ref={attach}
            title={name}
            sandbox={FRAME_SANDBOX}
            referrerPolicy="no-referrer"
            srcDoc={doc.html}
            width={width}
            height={height}
            className="frame-iframe"
            style={{ transform: `scale(${scale})`, colorScheme: spec.view.scheme }}
            tabIndex={hidden ? -1 : undefined}
          />
        )}
        {frameState.state === "failed" && (
          <div className="frame-failure" role="status">
            <Text.Root as="p" weight="medium">
              {frameState.stage === "setup" ? "Not rendered" : frameState.stage === "timeout" ? "No answer" : `The page failed to ${frameState.stage}`}
            </Text.Root>
            <Text.Root as="p" className="pre">
              {frameState.message}
            </Text.Root>
          </div>
        )}
      </div>
    </figure>
  );
}
