/**
 * The workspace's keyboard shortcuts: Todae's useHotkey listens for them, and
 * each control they stand for names them in `aria-keyshortcuts` and in its
 * visible tooltip. Control on Windows and Linux, Command on a Mac.
 */
export type Shortcut = { readonly keys: readonly string[]; readonly label: string };

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
  return /mac|iphone|ipad/i.test(platform);
}

const MAC = isMac();

function chord(key: string, alt = false): Shortcut {
  const keys = ["Control", "Meta"].map((modifier) => `${modifier}${alt ? "+Alt" : ""}+${key}`);
  const shown = key.length === 1 ? key.toUpperCase() : key;
  return { keys, label: MAC ? `${alt ? "⌥" : ""}⌘${shown}` : `Ctrl+${alt ? "Alt+" : ""}${shown}` };
}

export const SHORTCUTS = {
  /** Show or hide the chat, the left panel. */
  chat: chord("B"),
  /** Show or hide the checks and code, the right panel. */
  side: chord("B", true),
  /** Canvas only: every panel and the header out of the way. */
  canvasOnly: chord("."),
  /** "Pin a note" mode on the canvas, on and off. */
  pin: chord("N", true),
  /** Leaves canvas only, and "Pin a note" mode. */
  leave: { keys: ["Escape"], label: "Esc" },
} as const satisfies Record<string, Shortcut>;

/** The value of `aria-keyshortcuts` for a shortcut: its keys, space-separated. */
export function ariaKeys(shortcut: Shortcut): string {
  return shortcut.keys.join(" ");
}
