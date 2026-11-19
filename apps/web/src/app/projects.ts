/**
 * Which project this browser had open last, so a reload comes back to it.
 * A convenience kept in localStorage: the projects themselves are in
 * IndexedDB, and when this cannot be read the app opens the first one.
 */

/** A stored project as the switcher lists it. */
export type ProjectEntry = { readonly id: string; readonly name: string };

const KEY = "design-harness.project";

export function recallProject(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): string | null {
  try {
    return storage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export function rememberProject(id: string, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(KEY, id);
  } catch {
    // Blocked storage only means the choice lasts for the visit.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
