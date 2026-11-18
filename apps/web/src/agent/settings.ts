import { DEFAULT_SETTINGS, isEffort, isModel, type AgentSettings } from "./models";

/** The model and effort the person chose, kept in this origin's localStorage. They are not secret; the key is never here. */
const STORAGE = "design-harness:agent-settings";

/** This origin's localStorage, or null where there is none or the browser blocks it: reading `localStorage` itself throws when site data is blocked. */
function pageStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadSettings(storage: Pick<Storage, "getItem"> | null = pageStorage()): AgentSettings {
  try {
    const raw = JSON.parse(storage?.getItem(STORAGE) ?? "null") as Partial<Record<keyof AgentSettings, unknown>> | null;
    return { model: isModel(raw?.model) ? raw.model : DEFAULT_SETTINGS.model, effort: isEffort(raw?.effort) ? raw.effort : DEFAULT_SETTINGS.effort };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AgentSettings, storage: Pick<Storage, "setItem"> | null = pageStorage()): void {
  try {
    storage?.setItem(STORAGE, JSON.stringify({ model: settings.model, effort: settings.effort }));
  } catch {
    // Private windows may refuse storage; the settings then last for the session.
  }
}
