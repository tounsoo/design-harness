import type { CheckReport, ProjectConfig, Prototype } from "@design-harness/core";
import type { Session, SessionState } from "../runtime/session";
import type { FrameProblem, Measured } from "./tools";

/**
 * Core's report for the app's current source, once every frame has measured
 * it. If the session is behind the app (an edit still waiting out its
 * debounce), it starts the revision at once; if the source changes again
 * while frames measure, it waits for the newer revision. It never resolves
 * with a report of older source, and it rejects when `signal` aborts.
 */
export function waitForMeasured(session: Session, latest: () => { readonly config: ProjectConfig; readonly prototype: Prototype }, signal: AbortSignal): Promise<Measured> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (fn: () => void) => {
      if (finished) return;
      finished = true;
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const check = () => {
      if (finished) return;
      const want = latest();
      const current = session.current();
      if (!current || current.prototype !== want.prototype || current.config !== want.config) {
        session.update(want.config, want.prototype);
        return;
      }
      const state = session.getState();
      if (state.revision !== current.revision || !state.measured || !state.report) return;
      const report = state.report;
      finish(() => resolve({ revision: state.revision, report, frames: frameProblems(state) }));
    };
    // Checked after the session's own update finishes notifying, never inside it.
    const unsubscribe = session.subscribe(() => queueMicrotask(check));
    const onAbort = () => finish(() => reject(new DOMException("Stopped while waiting for the checks", "AbortError")));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort);
    check();
  });
}

export function frameProblems(state: SessionState): FrameProblem[] {
  return state.frames.flatMap((frame) => {
    const value = state.frameStates[frame.key];
    return value?.state === "failed" ? [{ frame: frame.key, stage: value.stage, message: value.message }] : [];
  });
}

/** Core's report for the app's current source if every frame has measured it already, or null: what the checks said when a turn starts, without waiting. */
export function latestMeasured(session: Session, latest: () => { readonly config: ProjectConfig; readonly prototype: Prototype }): CheckReport | null {
  const want = latest();
  const current = session.current();
  const state = session.getState();
  if (!current || current.prototype !== want.prototype || current.config !== want.config || state.revision !== current.revision || !state.measured) return null;
  return state.report;
}
