import { KEY_STORE, finished, keyHint, openKeyDb, request } from "../agent/key-vault";

/**
 * Docs servers' tokens, kept as the API key is: in this tab's memory, and,
 * when the person asks, also in the key database on this device
 * (`design-harness-key`), under an id of its own per project and server
 * (`mcp:<project>:<server>`). Never in a source, the project store, an
 * export, a chat, a frame or a log. A token goes only into the
 * `authorization_token` of its server in a request to api.anthropic.com,
 * whose MCP connector passes it to that server; errors are redacted of it.
 *
 * A token is bound to the address it was given for. A server whose address
 * has changed since, by an edit or by an imported project that reuses the
 * project's id and the server's name, gets no token until one is given for
 * the new address, so a token never follows its server's name somewhere else.
 */

export type TokenState = { readonly present: boolean; readonly remembered: boolean; readonly hint: string | null };

/** A token held, with the server address it was given for (null for one kept before tokens were bound to an address). */
type Entry = { readonly token: string; readonly url: string | null; readonly remembered: boolean };

const PREFIX = "mcp:";
const idOf = (projectId: string, name: string) => `${PREFIX}${projectId}:${name}`;

/** A token as pasted: one string, no spaces. Returns why not, or null. */
export function tokenProblem(token: string): string | null {
  if (token.length === 0) return "Paste the token, or leave it out for a server that needs none.";
  if (/\s/.test(token)) return "A token has no spaces or line breaks.";
  if (token.length > 8192) return "That is too long to be a token.";
  return null;
}

export class DocTokens {
  private readonly tokens = new Map<string, Entry>();
  private version = 0;
  private readonly listeners = new Set<() => void>();

  private constructor(private readonly factory: IDBFactory | null) {}

  /** Opens the vault with every token remembered on this device. Without IndexedDB, tokens are kept in memory only. */
  static async open(factory: IDBFactory | null = typeof indexedDB === "undefined" ? null : indexedDB): Promise<DocTokens> {
    const vault = new DocTokens(factory);
    if (!factory) return vault;
    try {
      const db = await openKeyDb(factory);
      try {
        const rows = (await request(db.transaction(KEY_STORE).objectStore(KEY_STORE).getAll())) as { id?: unknown; token?: unknown; url?: unknown }[];
        for (const row of rows) {
          // A row kept before tokens were bound to an address has no `url`: it is read for redaction only, and never sent.
          if (typeof row.id === "string" && row.id.startsWith(PREFIX) && typeof row.token === "string") vault.tokens.set(row.id, { token: row.token, url: typeof row.url === "string" ? row.url : null, remembered: true });
        }
      } finally {
        db.close();
      }
    } catch {
      // A vault that cannot be read starts empty.
    }
    return vault;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes whenever a token is set, moved or forgotten, for React to re-read. */
  getVersion = (): number => this.version;

  private publish(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** The entry for a server at this address; one given for another address does not count. */
  private entry(projectId: string, name: string, url: string): Entry | null {
    const entry = this.tokens.get(idOf(projectId, name));
    return entry && entry.url === url ? entry : null;
  }

  /** The token itself, for the request only, and only for the address it was given for. */
  get(projectId: string, name: string, url: string): string | null {
    return this.entry(projectId, name, url)?.token ?? null;
  }

  state(projectId: string, name: string, url: string): TokenState {
    const entry = this.entry(projectId, name, url);
    return { present: entry !== null, remembered: entry?.remembered ?? false, hint: entry ? keyHint(entry.token) : null };
  }

  /** Every token held, for redaction: none is ever shown. */
  all(): string[] {
    return [...this.tokens.values()].map((entry) => entry.token);
  }

  private async write(id: string, kept: { readonly token: string; readonly url: string } | null): Promise<void> {
    if (!this.factory) return;
    const db = await openKeyDb(this.factory);
    try {
      const tx = db.transaction(KEY_STORE, "readwrite");
      if (kept === null) tx.objectStore(KEY_STORE).delete(id);
      else tx.objectStore(KEY_STORE).put({ id, token: kept.token, url: kept.url });
      await finished(tx);
    } finally {
      db.close();
    }
  }

  /** Keeps a server's token for its address, for this session, and on this device too when `remember` is set; one not remembered is deleted from the device. */
  async set(projectId: string, name: string, url: string, token: string, remember: boolean): Promise<void> {
    const problem = tokenProblem(token);
    if (problem) throw new Error(problem);
    const id = idOf(projectId, name);
    this.tokens.set(id, { token, url, remembered: remember });
    this.publish();
    await this.write(id, remember ? { token, url } : null);
  }

  /** Deletes a server's token from memory and this device. */
  async forget(projectId: string, name: string): Promise<void> {
    const id = idOf(projectId, name);
    this.tokens.delete(id);
    this.publish();
    await this.write(id, null);
  }

  /** Moves a token when its server is renamed, kept where it was kept and still bound to the address it was given for. */
  async rename(projectId: string, from: string, to: string): Promise<void> {
    if (from === to) return;
    const entry = this.tokens.get(idOf(projectId, from));
    if (!entry) return;
    await this.forget(projectId, from);
    if (entry.url !== null) await this.set(projectId, to, entry.url, entry.token, entry.remembered);
  }
}
