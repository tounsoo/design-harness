import { useEffect, useState } from "react";

/** How long drawing may make no progress before a page says what it still waits for: a minute, as the plan for a stuck review page asked. */
export const STALL_MS = 60_000;

/**
 * True once `active` has held for `ms` with `progress` unchanged: what a
 * page reads to stop saying "checking" and say plainly what is still
 * waiting. Any change of `progress`, or `active` turning false, starts the
 * clock again. Only the page's words read it; no check does.
 */
export function useStalled(progress: string, active: boolean, ms: number = STALL_MS): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    if (!active) return;
    const timer = setTimeout(() => setStalled(true), ms);
    return () => clearTimeout(timer);
  }, [progress, active, ms]);
  return stalled;
}
