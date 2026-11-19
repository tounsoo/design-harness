import { validateLibraryRequest, type LibraryRequest } from "../../scripts/library-request-input.mjs";

/**
 * The library requests this browser has sent to GitHub, so the wizard can
 * show them as pending. The app holds no GitHub token and cannot ask
 * GitHub how a request went, so a pending request links to where its issue
 * and pull request will be, and stops showing once the deployment lists the
 * library. A convenience kept in localStorage: blocked or cleared storage
 * only means none are shown, and every stored entry is checked again as it
 * is read, since anything can write there.
 */
export type PendingRequest = LibraryRequest & { readonly at: string };

const KEY = "design-harness.library-requests";
/** The most pending requests kept. */
export const MAX_PENDING = 20;

type Store = Pick<Storage, "getItem" | "setItem">;

function safeStorage(): Store | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

const same = (a: LibraryRequest, b: LibraryRequest) => a.package === b.package && a.version === b.version;

/** The pending requests stored, newest first: each one valid, none the deployment already lists. */
export function readPending(listed: (request: LibraryRequest) => boolean, storage: Store | undefined = safeStorage()): PendingRequest[] {
  let raw: unknown;
  try {
    raw = JSON.parse(storage?.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: PendingRequest[] = [];
  for (const entry of raw.slice(0, MAX_PENDING)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { package: name, version, stylesheets, at } = entry as Record<string, unknown>;
    if (!Array.isArray(stylesheets) || typeof at !== "string" || Number.isNaN(Date.parse(at))) continue;
    const checked = validateLibraryRequest({ package: name, version, stylesheets: stylesheets.filter((path) => typeof path === "string").join("\n") });
    if (!checked.ok || listed(checked.value) || out.some((other) => same(other, checked.value))) continue;
    out.push({ ...checked.value, at });
  }
  return out;
}

/** The list with this request first, as of `at`, replacing an earlier one of the same package and version. */
export function withPending(list: readonly PendingRequest[], request: LibraryRequest, at: string): PendingRequest[] {
  return [{ ...request, at }, ...list.filter((other) => !same(other, request))].slice(0, MAX_PENDING);
}

/** The list without this request. */
export function withoutPending(list: readonly PendingRequest[], request: LibraryRequest): PendingRequest[] {
  return list.filter((other) => !same(other, request));
}

export function writePending(list: readonly PendingRequest[], storage: Store | undefined = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(list));
  } catch {
    // Blocked storage only means the list lasts for the visit.
  }
}
