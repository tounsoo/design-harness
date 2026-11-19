import { useSyncExternalStore } from "react";

/**
 * How much room the window gives the shell. Each width is a layout:
 *
 * - `phone`: one pane at a time (the canvas, the chat, or the checks and
 *   code), a header of two rows, and every secondary action in the More menu.
 * - `tablet`: the canvas with at most one panel beside it, and the same header.
 * - `laptop`: every pane, a header of one row, secondary actions in the menu.
 * - `desktop`: every pane and every action in the header.
 *
 * The least width of each is a harness token (`harness.shell.*` in
 * tokens/harness.json), read here from the page's style, so the layout's
 * sizes stay in the token layer.
 */
export type ShellWidth = "phone" | "tablet" | "laptop" | "desktop";

const WIDER = ["tablet", "laptop", "desktop"] as const satisfies readonly ShellWidth[];

/** The width a list of "at least this wide" answers describes, narrowest first: the last one that holds. */
export function widthOf(atLeast: readonly boolean[]): ShellWidth {
  let width: ShellWidth = "phone";
  WIDER.forEach((name, index) => {
    if (atLeast[index]) width = name;
  });
  return width;
}

/** How many panes sit side by side at a width. */
export function panesAt(width: ShellWidth): 1 | 2 | 3 {
  return width === "phone" ? 1 : width === "tablet" ? 2 : 3;
}

let queries: readonly MediaQueryList[] | null = null;

/** One media query per token, once the token layer's stylesheet is in; null before that, or where there is no window. */
function lists(): readonly MediaQueryList[] | null {
  if (queries) return queries;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  const style = getComputedStyle(document.documentElement);
  const least = WIDER.map((name) => style.getPropertyValue(`--todae-harness-shell-${name}`).trim());
  if (least.some((value) => value === "")) return null;
  queries = least.map((value) => window.matchMedia(`(min-width: ${value})`));
  return queries;
}

function subscribe(onChange: () => void): () => void {
  const all = lists() ?? [];
  for (const query of all) query.addEventListener("change", onChange);
  return () => {
    for (const query of all) query.removeEventListener("change", onChange);
  };
}

/** The window's width as a layout. Without the tokens it is `desktop`, the layout the app had before it had any other. */
function current(): ShellWidth {
  const all = lists();
  return all ? widthOf(all.map((query) => query.matches)) : "desktop";
}

export function useShellWidth(): ShellWidth {
  return useSyncExternalStore(subscribe, current, () => "desktop");
}
