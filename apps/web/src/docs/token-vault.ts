import { KEY_STORE, finished, keyHint, openKeyDb, request } from "../agent/key-vault";

/**
 * Docs servers' tokens, kept as the API key is: in this tab's memory, and,
 * when the person asks, also in the key database on this device
 * (`design-harness-key`), under an id of its own per project and server
 * (`mcp:<project>:<server>`). Never in a source, the project store, an
 * export, a chat, a frame or a log. A token goes only into the
 * `authorization_token` of its server in a request to api.anthropic.com,
 * whose MCP connector passes it to that server; errors are redacted of it.
 */

export type TokenState = { readonly present: boolean; readonly remembered: boolean; readonly hint: string | null };

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
  private readonly tokens = new Map<string, { readonly token: string; readonly remembered: boolean }>();
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
        const rows = (await request(db.transaction(KEY_STORE).objectStore(KEY_STORE).getAll())) as { id?: unknown; token?: unknown }[];
        for (const row of rows) {
          if (typeof row.id === "string" && row.id.startsWith(PREFIX) && typeof row.token === "string") vault.tokens.set(row.id, { token: row.token, remembered: true });
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

  /** The token itself, for the request only. */
  get(projectId: string, name: string): string | null {
    return this.tokens.get(idOf(projectId, name))?.token ?? null;
  }

  state(projectId: string, name: string): TokenState {
    const entry = this.tokens.get(idOf(projectId, name));
    return { present: entry !== undefined, remembered: entry?.remembered ?? false, hint: entry ? keyHint(entry.token) : null };
  }

  /** Every token held, for redaction: none is ever shown. */
  all(): string[] {
    return [...this.tokens.values()].map((entry) => entry.token);
  }

  private async write(id: string, token: string | null): Promise<void> {
    if (!this.factory) return;
    const db = await openKeyDb(this.factory);
    try {
      const tx = db.transaction(KEY_STORE, "readwrite");
      if (token === null) tx.objectStore(KEY_STORE).delete(id);
      else tx.objectStore(KEY_STORE).put({ id, token });
      await finished(tx);
    } finally {
      db.close();
    }
  }

  /** Keeps a server's token for this session, and on this device too when `remember` is set; one not remembered is deleted from the device. */
  async set(projectId: string, name: string, token: string, remember: boolean): Promise<void> {
    const problem = tokenProblem(token);
    if (problem) throw new Error(problem);
    const id = idOf(projectId, name);
    this.tokens.set(id, { token, remembered: remember });
    this.publish();
    await this.write(id, remember ? token : null);
  }

  /** Deletes a server's token from memory and this device. */
  async forget(projectId: string, name: string): Promise<void> {
    const id = idOf(projectId, name);
    this.tokens.delete(id);
    this.publish();
    await this.write(id, null);
  }

  /** Moves a token when its server is renamed, kept where it was kept. */
  async rename(projectId: string, from: string, to: string): Promise<void> {
    if (from === to) return;
    const entry = this.tokens.get(idOf(projectId, from));
    if (!entry) return;
    await this.forget(projectId, from);
    await this.set(projectId, to, entry.token, entry.remembered);
  }
}
