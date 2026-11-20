import { useEffect, useMemo, useReducer, useRef } from "react";
import type { ProjectConfig, Prototype, RenderedSnapshot } from "@design-harness/core";
import { frameProblems } from "../agent/measure";
import type { FrameProblem } from "../agent/tools";
import type { Session, SessionState } from "../runtime/session";
import { createSession } from "./runtime";

/**
 * Measuring prototypes other than the one on the board, such as a
 * proposal's examples or the project's other prototypes: each gets a check
 * session of its own, with its own frames, keyed by what it renders. A
 * measurement belongs to the exact source and rendering config it was taken
 * of: when either changes the key changes, a new session measures from
 * scratch, and the old one is dropped, so a stale measurement is never
 * reported for new content.
 */

/** `attempt` starts the measurement again from scratch when it changes, as "Check again" does; it is not part of what is measured. */
export type MeasureItem = { readonly id: string; readonly config: ProjectConfig; readonly prototype: Prototype; readonly attempt?: number };

/** What the frames of one prototype have reported so far. */
export type Measurement =
  | { readonly state: "measuring"; readonly answered: number; readonly total: number }
  /** Every frame answered, and some without a snapshot: the measurement is partial and cannot be used. */
  | { readonly state: "failed"; readonly problems: readonly FrameProblem[] }
  | { readonly state: "measured"; readonly snapshots: readonly RenderedSnapshot[] };

export type Measured = MeasureItem & { readonly key: string; readonly session: Session; readonly state: SessionState; readonly measurement: Measurement };

/** FNV-1a over a string, as 8 hex digits, with the length: a short key for content that is compared, not trusted. */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return `${value.toString(16).padStart(8, "0")}-${text.length.toString(36)}`;
}

/** What a frame's paint depends on: the library and its version, the views, the page types the shell lays out, and the prototype. Rules are not in it. */
export function renderKey(config: ProjectConfig, prototype: Prototype): string {
  const { package: name, version, react, stylesheets, schemeAttribute } = config.library;
  return hash(JSON.stringify([name, version, react, stylesheets ?? [], schemeAttribute ?? null, config.views, config.inventories.pageTypes, prototype]));
}

/** A session state as a measurement: complete only when every frame answered with a snapshot. */
export function measurementOf(state: SessionState): Measurement {
  const total = state.frames.length;
  const answered = state.frames.filter((frame) => {
    const value = state.frameStates[frame.key]?.state;
    return value === "measured" || value === "failed";
  }).length;
  if (!state.measured) return { state: "measuring", answered, total };
  const problems = frameProblems(state);
  if (problems.length > 0) return { state: "failed", problems };
  return { state: "measured", snapshots: state.frames.flatMap((frame) => {
    const value = state.frameStates[frame.key];
    return value?.state === "measured" ? [value.snapshot] : [];
  }) };
}

/** One session per item, kept while the item's key stays the same; the caller re-renders whenever any of them changes. */
export function useSessions(items: readonly MeasureItem[]): readonly Measured[] {
  const pool = useRef(new Map<string, Session>());
  const [, bump] = useReducer((count: number) => count + 1, 0);
  const keyed = useMemo(() => items.map((item) => ({ ...item, key: `${item.id}:${item.attempt ?? 0}:${renderKey(item.config, item.prototype)}` })), [items]);
  const signature = keyed.map((item) => item.key).join("|");

  const sessions = useMemo(() => {
    return keyed.map((item) => {
      let session = pool.current.get(item.key);
      if (!session) {
        session = createSession();
        session.update(item.config, item.prototype);
        pool.current.set(item.key, session);
      }
      return { ...item, session };
    });
    // Keyed by content, not by the array: a new item list with the same keys measures the same thing, so it keeps its sessions.
  }, [signature]);

  useEffect(() => {
    const keep = new Set(sessions.map((item) => item.key));
    for (const [key, session] of pool.current) {
      if (!keep.has(key)) {
        session.dispose();
        pool.current.delete(key);
      }
    }
    const unsubscribe = sessions.map((item) => item.session.subscribe(bump));
    return () => unsubscribe.forEach((stop) => stop());
  }, [sessions]);

  useEffect(
    () => () => {
      for (const session of pool.current.values()) session.dispose();
      pool.current.clear();
    },
    [],
  );

  return sessions.map((item) => {
    const state = item.session.getState();
    return { ...item, state, measurement: measurementOf(state) };
  });
}
