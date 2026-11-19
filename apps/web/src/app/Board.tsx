import { Badge, Button, Field, Label, Stack, Text } from "@tounsoo/todae";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Finding } from "@design-harness/core";
import { FRAME_SANDBOX } from "../runtime/frame-document";
import { frameKey, type FrameSpec, type FrameState, type Session, type SessionState } from "../runtime/session";
import { planOutline } from "../runtime/tags";

type Zoom = "fit" | "0.25" | "0.5" | "1";

/**
 * The canvas: one row per scenario, one frame per view in it, each a live
 * render scaled to fit. A frame opens at full size in place, without being
 * moved in the DOM, since moving an iframe reloads it.
 */
export function Board({ session, state, selected }: { readonly session: Session; readonly state: SessionState; readonly selected: Finding | null }) {
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
  // The board's padding, the gaps between frames, and a little slack so rounding never wraps a row.
  const gaps = 24 * Math.max(0, (scenarios[0]?.length ?? 1) - 1) + 48 + 8;
  const fit = Math.min(1, Math.max(0.12, (width - gaps) / rowWidth));
  const scale = zoom === "fit" ? fit : Number(zoom);
  const selectedKey = selected?.scenario !== undefined && selected.view !== undefined ? frameKey(selected.scenario, selected.view) : null;
  // A finding about elements is outlined in every frame that drew them.
  const outlined = useMemo(() => new Set(selected ? (planOutline(selected, state.frames, state.frameStates)?.frames.map((frame) => frame.key) ?? []) : []), [selected, state.frames, state.frameStates]);
  const focusedSpec = state.frames.find((frame) => frame.key === focused);

  return (
    <div className="board" data-focused={focused ? "" : undefined}>
      <div className="board-toolbar">
        {focusedSpec ? (
          <Stack.Root direction="row" align="center" gap="normal">
            <Button.Root variant="secondary" onClick={() => setFocused(null)}>
              Back to board
            </Button.Root>
            <Text.Root as="span">
              {focusedSpec.scenario.id} at {focusedSpec.view.name}, {focusedSpec.view.width} by {focusedSpec.view.height}, full size
            </Text.Root>
          </Stack.Root>
        ) : (
          <Stack.Root direction="row" align="center" gap="normal">
            <Text.Root as="span" tone="muted">
              {scenarios.length} scenarios × {state.frames.length / Math.max(1, scenarios.length)} views · revision {state.revision}
            </Text.Root>
            <Stack.Root direction="row" align="center" gap="condensed">
              <Label.Root htmlFor="board-zoom">Zoom</Label.Root>
              <Field.Root id="board-zoom" className="board-zoom">
                <Field.Select value={zoom} onValueChange={(value) => setZoom(value as Zoom)}>
                  <option value="fit">Fit ({Math.round(fit * 100)}%)</option>
                  <option value="0.25">25%</option>
                  <option value="0.5">50%</option>
                  <option value="1">100%</option>
                </Field.Select>
              </Field.Root>
            </Stack.Root>
          </Stack.Root>
        )}
      </div>
      <div className="board-area" ref={area}>
        {state.packages.state === "failed" && <p className="board-error">{state.packages.message}</p>}
        {scenarios.map((row) => {
          const first = row[0];
          if (!first) return null;
          return (
            <section key={first.scenario.id} className="board-row" aria-label={`Scenario ${first.scenario.id}`}>
              <div className="board-row-head">
                <Text.Root as="h2" className="board-row-title">
                  {first.scenario.id}
                </Text.Root>
                <Text.Root as="span" tone="muted">
                  state {first.scenario.state} · page {first.scenario.page}
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

function statusOf(frameState: FrameState): { tone: "neutral" | "success" | "critical" | "info"; text: string } {
  switch (frameState.state) {
    case "waiting":
    case "rendering":
      return { tone: "info", text: "measuring" };
    case "measured":
      return { tone: "success", text: "measured" };
    case "failed":
      return { tone: "critical", text: frameState.stage === "timeout" ? "no answer" : `${frameState.stage} failed` };
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

/** One frame of a session: its live iframe, scaled, with its view, size and measuring status. The review page shows examples with it too. */
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
    <figure className="frame-card" style={{ width: Math.max(width * scale, 168) }} data-frame-key={spec.key} data-state={frameState.state} data-selected={selected ? "" : undefined} data-focused={focused ? "" : undefined} data-hidden={hidden ? "" : undefined} aria-hidden={hidden || undefined}>
      <figcaption className="frame-head">
        <Text.Root as="span" weight="medium">
          {spec.view.name}
        </Text.Root>
        <Text.Root as="span" tone="muted" className="frame-size">
          {width}×{height}
          {spec.view.scheme === "dark" ? " dark" : ""}
        </Text.Root>
        <Badge.Root tone={status.tone} className="frame-status">
          {status.text}
        </Badge.Root>
        {!focused && onOpen && (
          <Button.Root variant="ghost" onClick={onOpen} aria-label={`Open ${spec.scenario.id} at ${spec.view.name} full size`} className="frame-open">
            Open
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
