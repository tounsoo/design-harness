import { formatIssues, parseProjectConfig, parseVariantState, type ProjectConfig } from "@design-harness/core";
import { parsePinState } from "../pins/model";
import { withoutTsxRules } from "./migrate";
import { readStoredPrototype, type PrototypeRecord } from "./project-file";

/**
 * Projects and their prototypes, kept in the browser's IndexedDB. Nothing
 * leaves the browser. What is read back is validated with core again, since
 * stored data may come from an older version of the app: a record that no
 * longer validates is reported, not loaded. A TSX prototype loads as it was
 * stored, for its files alone, and a config's rules only TSX had are taken
 * out before it is read (`migrate.ts`).
 */

export const DB_NAME = "design-harness";
const DB_VERSION = 2;
const PROJECTS = "projects";
const PROTOTYPES = "prototypes";
/** The agent chat of each prototype: what was said, and the API history. Never the API key, which has its own database. */
const CHATS = "chats";

type ProjectRow = { readonly id: string; readonly config: unknown };
type PrototypeRow = { readonly projectId: string; readonly id: string; readonly name: string; readonly prototype: unknown; readonly variants?: unknown; readonly pins?: unknown };

export type Loaded<T> = { readonly items: readonly T[]; readonly problems: readonly string[] };

/** The stored projects, and for each whose rules only TSX had were taken out on load, by id, what went. */
export type LoadedProjects = Loaded<ProjectConfig> & { readonly removed: Readonly<Record<string, readonly string[]>> };

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class Store {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(factory: IDBFactory = indexedDB, name = DB_NAME): Promise<Store> {
    const req = factory.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(PROTOTYPES)) db.createObjectStore(PROTOTYPES, { keyPath: ["projectId", "id"] }).createIndex("projectId", "projectId");
      if (!db.objectStoreNames.contains(CHATS)) db.createObjectStore(CHATS, { keyPath: ["projectId", "prototypeId"] });
    };
    return new Store(await request(req));
  }

  close(): void {
    this.db.close();
  }

  async projects(): Promise<LoadedProjects> {
    const rows = (await request(this.db.transaction(PROJECTS).objectStore(PROJECTS).getAll())) as ProjectRow[];
    const items: ProjectConfig[] = [];
    const problems: string[] = [];
    const removed: Record<string, readonly string[]> = {};
    for (const row of rows) {
      const migrated = withoutTsxRules(row.config);
      const parsed = parseProjectConfig(migrated.json);
      if (parsed.ok) {
        items.push(parsed.value);
        if (migrated.removed.length > 0) removed[parsed.value.id] = migrated.removed;
      } else problems.push(`Stored project "${row.id}" no longer validates and was not loaded:\n${formatIssues(parsed.error)}`);
    }
    return { items: items.sort(byId), problems, removed };
  }

  async prototypes(projectId: string): Promise<Loaded<PrototypeRecord>> {
    const index = this.db.transaction(PROTOTYPES).objectStore(PROTOTYPES).index("projectId");
    const rows = (await request(index.getAll(IDBKeyRange.only(projectId)))) as PrototypeRow[];
    const items: PrototypeRecord[] = [];
    const problems: string[] = [];
    for (const row of rows) {
      const parsed = readStoredPrototype(row.prototype);
      // Variants are kept apart from the prototype: ones that no longer validate are reported and left out, and the prototype still loads.
      const variants = row.variants === undefined ? null : parseVariantState(row.variants);
      if (variants && !variants.ok) problems.push(`The variants stored with prototype "${row.id}" no longer validate and were not loaded:\n${formatIssues(variants.error)}`);
      // Pins too are kept apart: ones that cannot be read are reported, never dropped without a word.
      const pins = row.pins === undefined ? null : parsePinState(row.pins);
      if (pins && !pins.ok) problems.push(`The pinned notes stored with prototype "${row.id}" could not be read and were not loaded:\n${pins.error.join("\n")}`);
      if (parsed.ok) items.push({ projectId: row.projectId, id: row.id, name: row.name, prototype: parsed.value, ...(variants?.ok ? { variants: variants.value } : {}), ...(pins?.ok ? { pins: pins.value } : {}) });
      else problems.push(`Stored prototype "${row.id}" no longer validates and was not loaded:\n${parsed.error}`);
    }
    return { items: items.sort(byId), problems };
  }

  async putPrototype(record: PrototypeRecord): Promise<void> {
    const tx = this.db.transaction(PROTOTYPES, "readwrite");
    tx.objectStore(PROTOTYPES).put({ projectId: record.projectId, id: record.id, name: record.name, prototype: record.prototype, ...(record.variants ? { variants: record.variants } : {}), ...(record.pins ? { pins: record.pins } : {}) } satisfies PrototypeRow);
    await done(tx);
  }

  async putProject(config: ProjectConfig): Promise<void> {
    const tx = this.db.transaction(PROJECTS, "readwrite");
    tx.objectStore(PROJECTS).put({ id: config.id, config } satisfies ProjectRow);
    await done(tx);
  }

  /** A prototype's saved chat, unvalidated: the chat checks its own shape. */
  async chat(projectId: string, prototypeId: string): Promise<unknown> {
    const row = (await request(this.db.transaction(CHATS).objectStore(CHATS).get([projectId, prototypeId]))) as { record?: unknown } | undefined;
    return row?.record ?? null;
  }

  async putChat(projectId: string, prototypeId: string, record: unknown): Promise<void> {
    const tx = this.db.transaction(CHATS, "readwrite");
    tx.objectStore(CHATS).put({ projectId, prototypeId, record });
    await done(tx);
  }

  /** Writes a project with exactly these prototypes, in one transaction: an import replaces the stored project of the same id whole. */
  async replaceProject(config: ProjectConfig, prototypes: readonly PrototypeRecord[]): Promise<void> {
    const tx = this.db.transaction([PROJECTS, PROTOTYPES], "readwrite");
    tx.objectStore(PROJECTS).put({ id: config.id, config } satisfies ProjectRow);
    const store = tx.objectStore(PROTOTYPES);
    const keys = await request(store.index("projectId").getAllKeys(IDBKeyRange.only(config.id)));
    for (const key of keys) store.delete(key);
    for (const record of prototypes) store.put({ projectId: config.id, id: record.id, name: record.name, prototype: record.prototype, ...(record.variants ? { variants: record.variants } : {}), ...(record.pins ? { pins: record.pins } : {}) } satisfies PrototypeRow);
    await done(tx);
  }
}
