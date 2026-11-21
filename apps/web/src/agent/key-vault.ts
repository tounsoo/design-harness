/**
 * The person's Anthropic API key. It lives in this tab's memory, held by the
 * app's origin, and goes only into the Authorization header of requests to
 * api.anthropic.com. By default it is kept for the session and gone when the
 * tab closes. "Remember on this device" also stores it in this origin's
 * IndexedDB, in its own database, never in the project database, a
 * prototype, an export, a frame or a log; "Forget" deletes it from both.
 * Frames have an opaque origin, so they cannot open this database.
 */

export const KEY_DB = "design-harness-key";
/** The one store in the key database. Docs servers' remembered tokens share it, under ids that start with `mcp:` (`docs/token-vault.ts`). */
export const KEY_STORE = "keys";
const STORE = KEY_STORE;
const ID = "anthropic";

export type KeyState = {
  readonly present: boolean;
  readonly remembered: boolean;
  /** The key's start and last four characters, enough to recognise it. */
  readonly hint: string | null;
};

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export function keyHint(key: string): string {
  return key.length <= 12 ? "…" : `${key.slice(0, 7)}…${key.slice(-4)}`;
}

/** A key as pasted: one token, no spaces. Returns why not, or null. */
export function keyProblem(key: string): string | null {
  if (key.length === 0) return "Paste your API key.";
  if (/\s/.test(key)) return "An API key has no spaces or line breaks.";
  if (key.length < 20) return "That is too short to be an API key.";
  return null;
}

/** Opens the key database, creating its store on first use. */
export function openKeyDb(factory: IDBFactory): Promise<IDBDatabase> {
  const req = factory.open(KEY_DB, 1);
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
  };
  return request(req);
}

/** Waits for a write to the key database to finish. */
export function finished(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

export class KeyVault {
  private key: string | null = null;
  private remembered = false;
  private state: KeyState = { present: false, remembered: false, hint: null };
  private readonly listeners = new Set<() => void>();

  private constructor(private readonly factory: IDBFactory | null) {}

  /** Opens the vault and reads a remembered key, if there is one. Without IndexedDB, the key is kept in memory only. */
  static async open(factory: IDBFactory | null = typeof indexedDB === "undefined" ? null : indexedDB): Promise<KeyVault> {
    const vault = new KeyVault(factory);
    try {
      const stored = await vault.read();
      if (stored) {
        vault.key = stored;
        vault.remembered = true;
      }
    } catch {
      // A vault that cannot be read starts empty.
    }
    vault.publish();
    return vault;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): KeyState => this.state;

  /** The key itself, for the API client only. */
  get(): string | null {
    return this.key;
  }

  private publish(): void {
    this.state = { present: this.key !== null, remembered: this.remembered, hint: this.key ? keyHint(this.key) : null };
    for (const listener of this.listeners) listener();
  }

  private async db(): Promise<IDBDatabase | null> {
    if (!this.factory) return null;
    return openKeyDb(this.factory);
  }

  private async read(): Promise<string | null> {
    const db = await this.db();
    if (!db) return null;
    try {
      const row = (await request(db.transaction(STORE).objectStore(STORE).get(ID))) as { key?: unknown } | undefined;
      return typeof row?.key === "string" ? row.key : null;
    } finally {
      db.close();
    }
  }

  private async write(key: string | null): Promise<void> {
    const db = await this.db();
    if (!db) return;
    try {
      const tx = db.transaction(STORE, "readwrite");
      if (key === null) tx.objectStore(STORE).delete(ID);
      else tx.objectStore(STORE).put({ id: ID, key });
      await finished(tx);
    } finally {
      db.close();
    }
  }

  /** Keeps a key for this session, and on this device too when `remember` is set; a key not remembered is deleted from the device. */
  async set(key: string, remember: boolean): Promise<void> {
    const problem = keyProblem(key);
    if (problem) throw new Error(problem);
    this.key = key;
    this.remembered = remember;
    this.publish();
    await this.write(remember ? key : null);
  }

  /** Deletes the key from memory and from this device. */
  async forget(): Promise<void> {
    this.key = null;
    this.remembered = false;
    this.publish();
    await this.write(null);
  }
}
