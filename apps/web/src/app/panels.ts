import { useCallback, useEffect, useState } from "react";

/**
 * The workspace's panels, per viewer: whether the chat (left) and the checks
 * and code (right) are open, and how wide each is. They are a viewer's
 * convenience, kept in this browser's localStorage and restored on load;
 * nothing else reads them, and the app works the same when storage is
 * blocked or empty.
 */
export type Panel = { readonly open: boolean; readonly width: number };
export type Panels = { readonly chat: Panel; readonly side: Panel };
export type PanelName = keyof Panels;

/** Each panel's width bounds and first width, in CSS pixels: Todae's Splitter sizes in pixels. */
export const PANEL_SIZES: Readonly<Record<PanelName, { readonly min: number; readonly max: number; readonly initial: number }>> = {
  chat: { min: 280, max: 560, initial: 360 },
  side: { min: 320, max: 720, initial: 400 },
};

export const PANELS_KEY = "design-harness.panels";

export const DEFAULT_PANELS: Panels = {
  chat: { open: true, width: PANEL_SIZES.chat.initial },
  side: { open: true, width: PANEL_SIZES.side.initial },
};

function panelFrom(value: unknown, name: PanelName): Panel {
  const fallback = DEFAULT_PANELS[name];
  if (typeof value !== "object" || value === null) return fallback;
  const { open, width } = value as { open?: unknown; width?: unknown };
  const { min, max } = PANEL_SIZES[name];
  return {
    open: typeof open === "boolean" ? open : fallback.open,
    width: typeof width === "number" && Number.isFinite(width) ? Math.min(max, Math.max(min, Math.round(width))) : fallback.width,
  };
}

/** The panels a stored value describes; anything missing or malformed falls back to the default. */
export function parsePanels(text: string | null): Panels {
  if (!text) return DEFAULT_PANELS;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return DEFAULT_PANELS;
  }
  if (typeof value !== "object" || value === null) return DEFAULT_PANELS;
  const { chat, side } = value as { chat?: unknown; side?: unknown };
  return { chat: panelFrom(chat, "chat"), side: panelFrom(side, "side") };
}

/** localStorage, or null where the browser blocks it (a private window, blocked site data). */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function load(): Panels {
  try {
    return parsePanels(storage()?.getItem(PANELS_KEY) ?? null);
  } catch {
    return DEFAULT_PANELS;
  }
}

function save(panels: Panels): void {
  try {
    storage()?.setItem(PANELS_KEY, JSON.stringify(panels));
  } catch {
    // A full or blocked storage keeps the panels for this visit only.
  }
}

/**
 * The panels' state, restored from storage and saved on every change.
 * `resize` takes a Splitter's value: 0 closes the panel and keeps its last
 * width, so opening it again brings that width back.
 */
export function usePanels() {
  const [panels, setPanels] = useState<Panels>(load);
  useEffect(() => save(panels), [panels]);
  const resize = useCallback((name: PanelName, value: number) => {
    setPanels((current) => ({ ...current, [name]: value > 0 ? { open: true, width: value } : { ...current[name], open: false } }));
  }, []);
  const toggle = useCallback((name: PanelName, open?: boolean) => {
    setPanels((current) => ({ ...current, [name]: { ...current[name], open: open ?? !current[name].open } }));
  }, []);
  return { panels, resize, toggle };
}
