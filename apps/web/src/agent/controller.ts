import { APIError, AnthropicError } from "@anthropic-ai/sdk/core/error";
import type { BetaMessage, BetaMessageParam, BetaRawMessageStreamEvent, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { CheckStatus, Prototype } from "@design-harness/core";
import { docSignature, sourceTitle, type DocSource } from "../docs/sources";
import { docsNote } from "./doc-request";
import { describeError, isAbort, redact, redactContent } from "./errors";
import { fetchProblem, mcpExcerpt, pageExcerpt } from "./source-words";
import { History, toolCalls } from "./history";
import { NO_USAGE, addUsage, requestCost, type AgentSettings, type Usage } from "./models";
import { createClient, requestBody, type MessagesApi } from "./request";
import { specCatalogPrompt } from "./spec-prompt";
import { reportRules, type LoopEvent } from "./patterns";
import { describePins } from "../pins/describe";
import { openPins, unaddressPin } from "../pins/model";
import type { SpecStreamPreview } from "./spec-stream";
import { TSX_READ_ONLY, checksTitle, describeMeasured, runTool, type AddressedNote, type AgentHost, type ToolOutcome } from "./tools";

/**
 * One prototype's conversation with the agent. A turn is one message from
 * the person and everything the agent does about it: streamed requests,
 * tool calls run against the app, and after every round that changed the
 * prototype, the checks for the revision every frame has measured, sent back
 * to the agent with the tool results. A turn ends when the agent stops
 * calling tools, when the person stops it, after `maxRounds` rounds of tool
 * calls, on a refusal, on a reply cut off at max_tokens with a tool call in
 * it, or on an error. The API history is append-only (history.ts); what the
 * chat shows is kept beside it, per turn, and both are saved per prototype.
 */

export type TurnItem =
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly id: string; readonly name: string; readonly status: "streaming" | "running" | "done" | "error"; readonly title: string; readonly input: string; readonly result?: string }
  /** Core's report after a change; `failing` and `notRun` (rule ids) are absent on chats saved before the loop read them. */
  | { readonly kind: "checks"; readonly revision: number; readonly status: CheckStatus; readonly title: string; readonly text: string; readonly failing?: readonly string[]; readonly notRun?: readonly string[] }
  /** A proposal the agent drafted or revised; `action` is absent on chats saved before revisions existed, which only drafted. `request`: it asks for a new rule type. */
  | { readonly kind: "proposal"; readonly id: string; readonly title: string; readonly adoptable: boolean; readonly verdict: string; readonly action?: "drafted" | "revised"; readonly needsMeasurement?: true; readonly request?: true }
  /** `about: "docs"` marks the line that says which docs a message went with, so the chat can put the way to the docs beside it. */
  | { readonly kind: "notice"; readonly text: string; readonly about?: "docs" }
  /** Variants the agent offered or revised, beside the prototype: a card that opens the comparison. */
  | { readonly kind: "variants"; readonly page: string; readonly ids: readonly string[]; readonly action: "offered" | "revised" }
  /**
   * The agent read the project's documentation: a page it fetched (`web`,
   * Anthropic's web fetch tool) or a docs server's tool it called (`mcp`,
   * through the MCP connector). Both run at Anthropic; the app only shows
   * them. `result` is a short excerpt, never the whole page; `problem` is
   * what went wrong, in plain words.
   */
  | { readonly kind: "source"; readonly id: string; readonly via: "web" | "mcp"; readonly name: string; readonly server?: string; readonly status: "running" | "done" | "error"; readonly input: string; readonly url?: string; readonly pageTitle?: string; readonly result?: string; readonly problem?: string };

export type TurnEnd =
  | { readonly status: "running" }
  | { readonly status: "done" }
  | { readonly status: "stopped" }
  | { readonly status: "limit"; readonly rounds: number }
  | { readonly status: "refused"; readonly category: string | null; readonly explanation: string | null }
  | { readonly status: "cut-off" }
  | { readonly status: "error"; readonly title: string; readonly detail: string; readonly retry: boolean };

export type Turn = {
  readonly id: string;
  readonly text: string;
  readonly at: string;
  readonly settings: AgentSettings;
  readonly items: readonly TurnItem[];
  readonly end: TurnEnd;
  readonly usage: Usage;
  readonly cost: number;
  readonly rounds: number;
  /** The prototype as it was before the turn's first change; null when the turn changed nothing. */
  readonly before: Prototype | null;
  readonly undone: boolean;
  /** The person's notes the turn marked addressed (`address_note`), which undoing the turn opens again; absent when it addressed none. */
  readonly addressed?: readonly AddressedNote[];
  /** The rules failing when the turn started, when every frame had measured the prototype then; absent otherwise. */
  readonly failingAtStart?: readonly string[];
};

/**
 * What is saved per prototype. It never holds the API key or a docs
 * server's token. `log` is what the person did that the loop reads
 * (patterns.ts); absent on older chats. `docs` is the doc sources the agent
 * was last told about (`docSignature`), absent when it was told of none;
 * `rebound` is set once they changed after the conversation began
 * (`RequestDocs.rebound`).
 */
export type ChatRecord = { readonly version: 1; readonly history: readonly BetaMessageParam[]; readonly turns: readonly Turn[]; readonly pending: readonly string[]; readonly log?: readonly LoopEvent[]; readonly docs?: string; readonly rebound?: true };

/** The project's doc sources as the agent reads them, and each docs server's token at request time. */
export type DocContext = { readonly sources: readonly DocSource[]; readonly token: (name: string, url: string) => string | null; readonly tokens: () => readonly string[] };

const NO_DOC_CONTEXT: DocContext = { sources: [], token: () => null, tokens: () => [] };
const NO_SOURCES = docSignature([]);

export type ChatStore = { load(): Promise<ChatRecord | null>; save(record: ChatRecord): Promise<void> };

export type AgentState = { readonly turns: readonly Turn[]; readonly running: boolean; readonly loaded: boolean; readonly problem: string | null; readonly log: readonly LoopEvent[] };

export type AgentOptions = {
  readonly host: AgentHost;
  readonly store: ChatStore;
  readonly key: () => string | null;
  readonly settings: () => AgentSettings;
  /** Builds the API client for a key; tests pass one with a scripted fetch. */
  readonly client?: (key: string) => MessagesApi;
  readonly maxRounds?: number;
  readonly newId?: () => string;
  /** Follows a spec prototype's patch_spec input as it streams, to draw the draft on the canvas. */
  readonly preview?: SpecStreamPreview;
  /** The project's doc sources and their tokens; absent where the app has none. */
  readonly docs?: () => DocContext;
};

/** Tool rounds per message from the person, after which the agent stops and says so. */
export const MAX_ROUNDS = 16;
/** Times a turn is re-requested when a tool call's input cannot be parsed at all. */
const PARSE_RETRIES = 2;

export function isChatRecord(value: unknown): value is ChatRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    Array.isArray(record.history) &&
    record.history.every((message) => typeof message === "object" && message !== null && ((message as { role?: unknown }).role === "user" || (message as { role?: unknown }).role === "assistant")) &&
    Array.isArray(record.turns) &&
    record.turns.every((turn) => typeof turn === "object" && turn !== null && typeof (turn as { id?: unknown }).id === "string" && Array.isArray((turn as { items?: unknown }).items)) &&
    Array.isArray(record.pending) &&
    (record.docs === undefined || typeof record.docs === "string") &&
    (record.rebound === undefined || record.rebound === true) &&
    (record.log === undefined || (Array.isArray(record.log) && record.log.every((event) => typeof event === "object" && event !== null && typeof (event as { kind?: unknown }).kind === "string" && typeof (event as { at?: unknown }).at === "string")))
  );
}

function usageOf(message: BetaMessage): Usage {
  const usage = message.usage;
  return { input: usage.input_tokens, output: usage.output_tokens, cacheWrite: usage.cache_creation_input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, requests: 1 };
}

const short = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}...` : text);

export class AgentController {
  private state: AgentState = { turns: [], running: false, loaded: false, problem: null, log: [] };
  private readonly listeners = new Set<() => void>();
  private history = new History();
  private pending: string[] = [];
  private abort: AbortController | null = null;
  private saving: Promise<void> = Promise.resolve();
  private loading: Promise<void> | null = null;
  /** The doc sources the agent was last told about, as `docSignature` writes them. */
  private docsTold = NO_SOURCES;
  /** Set for good once the doc sources changed after the conversation began. */
  private rebound = false;
  /** The doc sources of the running turn: a turn keeps the sources it started with, even if the person edits them while it runs. */
  private turnSources: readonly DocSource[] | null = null;

  constructor(private readonly options: AgentOptions) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): AgentState => this.state;

  /** The API history, for tests and inspection. */
  messages(): readonly BetaMessageParam[] {
    return this.history.messages;
  }

  private set(patch: Partial<AgentState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private turn(id: string): Turn | undefined {
    return this.state.turns.find((item) => item.id === id);
  }

  private patchTurn(id: string, patch: (turn: Turn) => Partial<Turn>): void {
    this.set({ turns: this.state.turns.map((turn) => (turn.id === id ? { ...turn, ...patch(turn) } : turn)) });
  }

  private setItem(id: string, index: number, item: TurnItem): void {
    this.patchTurn(id, (turn) => ({ items: turn.items.map((existing, at) => (at === index ? item : existing)) }));
  }

  private addItem(id: string, item: TurnItem): number {
    let index = -1;
    this.patchTurn(id, (turn) => {
      index = turn.items.length;
      return { items: [...turn.items, item] };
    });
    return index;
  }

  /** Reads the saved conversation. A record this version cannot read is reported and a new conversation starts. */
  load(): Promise<void> {
    this.loading ??= this.read();
    return this.loading;
  }

  private async read(): Promise<void> {
    try {
      const record = await this.options.store.load();
      if (record && !isChatRecord(record)) {
        this.set({ loaded: true, problem: "The saved chat for this prototype could not be read, so a new one started." });
        return;
      }
      if (record) {
        this.history = new History(record.history);
        this.pending = [...record.pending];
        this.docsTold = record.docs ?? NO_SOURCES;
        this.rebound = record.rebound === true;
        // Calls the page closed on before they ran are answered, so the history stays valid; nothing is removed.
        const unanswered = this.history.unansweredCalls();
        if (unanswered.length > 0) this.history.appendToolResults(unanswered.map((id) => ({ type: "tool_result", tool_use_id: id, content: "Not run: the page closed before this ran.", is_error: true })));
        // A turn that was running when the page closed did not finish.
        const turns = record.turns.map((turn) => (turn.end.status === "running" ? { ...turn, end: { status: "stopped" as const } } : turn));
        this.set({ turns, loaded: true, log: [...(record.log ?? [])] });
        return;
      }
      this.set({ loaded: true });
    } catch (error) {
      this.set({ loaded: true, problem: `The saved chat could not be opened: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private save(): Promise<void> {
    const record: ChatRecord = {
      version: 1,
      history: this.history.toJSON(),
      turns: this.state.turns,
      pending: this.pending,
      ...(this.state.log.length > 0 ? { log: this.state.log } : {}),
      ...(this.docsTold !== NO_SOURCES ? { docs: this.docsTold } : {}),
      ...(this.rebound ? { rebound: true as const } : {}),
    };
    this.saving = this.saving.then(() => this.options.store.save(record)).catch(() => undefined);
    return this.saving;
  }

  /** Sends a message from the person and runs the agent until the turn ends. */
  async send(text: string): Promise<void> {
    const message = text.trim();
    // A message sent while the saved chat is still loading waits for it, so the loaded history cannot replace it.
    if (this.loading) await this.loading;
    if (!message || this.state.running) return;
    // A TSX prototype is read-only: nothing is sent, and the history is left as it is.
    if (this.options.host.tsx?.()) {
      this.set({ problem: TSX_READ_ONLY });
      return;
    }
    const settings = this.options.settings();
    const start = this.options.host.checked?.() ?? null;
    const turn: Turn = {
      id: this.options.newId?.() ?? crypto.randomUUID(),
      text: message,
      at: new Date().toISOString(),
      settings,
      items: [],
      end: { status: "running" },
      usage: NO_USAGE,
      cost: 0,
      rounds: 0,
      before: null,
      undone: false,
      ...(start ? { failingAtStart: reportRules(start).failing } : {}),
    };
    // The person's open pinned notes ride with every message of theirs, as findings beside core's (pins/describe.ts).
    const pins = this.options.host.pins?.();
    const notes = pins ? describePins(pins, new Set(this.options.host.variants().variants.map((variant) => variant.id))) : null;
    const open = pins ? openPins(pins).length : 0;
    const docs = this.takeDocs();
    this.history.appendUser(message, [...this.pending, ...(docs.note ? [docs.note] : []), ...(notes ? [notes] : [])]);
    this.pending = [];
    const notices: TurnItem[] = [
      ...(docs.notice ? [{ kind: "notice" as const, text: docs.notice, about: "docs" as const }] : []),
      ...(notes ? [{ kind: "notice" as const, text: `Sent with ${open === 1 ? "your open note" : `your ${open} open notes`} from the canvas.` }] : []),
    ];
    this.set({ turns: [...this.state.turns, { ...turn, items: notices }] });
    await this.run(turn.id);
  }

  /**
   * The doc sources for a turn that starts now. When they are not the ones
   * the agent was last told about, it is told in this message, which also
   * puts the websites' addresses where web fetch accepts them; and if the
   * conversation had begun, the request's system prompt and tools change
   * with them, so the conversation is marked `rebound` for good.
   */
  private takeDocs(): { readonly note: string | null; readonly notice: string | null } {
    const sources = this.options.docs?.().sources ?? [];
    this.turnSources = sources;
    const signature = docSignature(sources);
    if (signature === this.docsTold) return { note: null, notice: null };
    if (this.history.messages.some((message) => message.role === "assistant")) this.rebound = true;
    this.docsTold = signature;
    const notice = sources.length === 0 ? "The agent was told the project has no docs to read now." : `Sent with the project's docs: ${sources.map(sourceTitle).join(", ")}.`;
    return { note: docsNote(sources), notice };
  }

  /** Runs the last turn again from where it failed, when its error allows a retry. */
  async retry(): Promise<void> {
    const last = this.state.turns.at(-1);
    if (!last || this.state.running || last.end.status !== "error" || !last.end.retry || this.options.host.tsx?.()) return;
    // After a reload the turn's sources are gone: it continues with the project's, and a change since is told with the next message, since a retry adds nothing to the history.
    if (this.turnSources === null) {
      const docs = this.takeDocs();
      if (docs.note) this.pending.push(docs.note);
    }
    this.patchTurn(last.id, () => ({ end: { status: "running" } }));
    await this.run(last.id);
  }

  /** Stops the running turn: the stream is aborted, and a tool waiting on the checks stops waiting. */
  stop(): void {
    this.abort?.abort();
  }

  /** The notes a turn addressed that undoing it would open again: those nothing has happened to since. */
  private standing(turn: Turn): AddressedNote[] {
    const pins = this.options.host.pins?.();
    if (!pins || !turn.addressed) return [];
    return turn.addressed.filter((item) => unaddressPin(pins, item.note, item.event, "") !== pins);
  }

  /**
   * The turn whose changes can be undone now: the latest turn, not undone
   * yet, that changed the prototype or marked a note addressed that still
   * stands as it left it.
   */
  undoable(): Turn | undefined {
    // A TSX prototype is read-only: undo would change it.
    if (this.state.running || this.options.host.tsx?.()) return undefined;
    return [...this.state.turns].reverse().find((turn) => !turn.undone && (turn.before !== null || this.standing(turn).length > 0));
  }

  /**
   * Takes back what a turn did, as one step, and tells the agent next time:
   * the prototype as it was before the turn, and every note the turn marked
   * addressed open again, its reply dropped. A note the person has closed,
   * reopened or rewritten since is theirs and stays as they left it. The API
   * history is not touched: it is append-only, and the agent reads what was
   * undone in its next message.
   */
  async undo(id: string): Promise<void> {
    const turn = this.undoable();
    if (!turn || turn.id !== id) return;
    const host = this.options.host;
    if (turn.before) host.apply(turn.before);
    const before = host.pins?.();
    const reopened: number[] = [];
    if (before && host.savePins) {
      let pins = before;
      for (const item of turn.addressed ?? []) {
        const next = unaddressPin(pins, item.note, item.event, host.now());
        if (next !== pins) reopened.push(item.note);
        pins = next;
      }
      if (pins !== before) host.savePins(pins);
    }
    const told = [
      ...(turn.before ? ["the prototype is back to what it was before that message. Read the files again before you change them."] : []),
      ...(reopened.length > 0 ? [`${reopened.length === 1 ? `note ${reopened[0]} is` : `notes ${reopened.join(", ")} are`} open again, and your ${reopened.length === 1 ? "reply to it was" : "replies to them were"} withdrawn.`] : []),
    ];
    this.pending.push(`The person undid your changes from their message "${short(turn.text)}": ${told.join(" Also, ")}`);
    this.patchTurn(id, () => ({ undone: true }));
    await this.save();
  }

  /**
   * Keeps something the person did that the loop reads for patterns, such as
   * a press of "Ask the agent to fix" or a variant rejected with a note. It
   * tells the agent nothing; it is saved with the chat.
   */
  async record(event: LoopEvent): Promise<void> {
    if (this.loading) await this.loading;
    this.set({ log: [...this.state.log, event] });
    await this.save();
  }

  /** Tells the agent something the person did, in its next message, before the person's text: a pick applied or undone. */
  async note(text: string): Promise<void> {
    if (this.loading) await this.loading;
    this.pending.push(text);
    await this.save();
  }

  private end(id: string, end: TurnEnd): void {
    this.patchTurn(id, () => ({ end }));
  }

  private async run(id: string): Promise<void> {
    const key = this.options.key();
    if (!key) {
      this.end(id, { status: "error", title: "No API key", detail: "Enter your Anthropic API key to talk to the agent.", retry: false });
      return;
    }
    const client = (this.options.client ?? createClient)(key);
    const abort = new AbortController();
    this.abort = abort;
    this.set({ running: true });
    const maxRounds = this.options.maxRounds ?? MAX_ROUNDS;
    const context = this.options.docs?.() ?? NO_DOC_CONTEXT;
    const sources = this.turnSources ?? [];
    // Every token held is redacted from what the chat shows, not only this project's.
    const tokens = () => context.tokens();
    const clean = (text: string) => redact(text, key, tokens());
    let parseFailures = 0;
    try {
      for (;;) {
        if (abort.signal.aborted) return this.end(id, { status: "stopped" });
        const settings = this.options.settings();
        const startItems = this.turn(id)?.items.length ?? 0;
        const blocks = new Map<number, number>();
        // Each block's text as streamed, before redaction: what is shown is redacted from the whole of it.
        const raw = new Map<number, string>();
        let message: BetaMessage;
        try {
          // The agent writes specs, with the catalog's instructions, and reads the project's docs when it has any. Tokens are read for each request, so one the person just entered is used.
          const docs = { sources, token: (name: string, url: string) => this.options.docs?.().token(name, url) ?? null, rebound: this.rebound };
          const stream = client.stream(requestBody(settings, this.history.messages, specCatalogPrompt(this.options.host.config()), docs), { signal: abort.signal });
          for await (const event of stream) this.onEvent(id, event, blocks, raw, clean);
          message = await stream.finalMessage();
          parseFailures = 0;
        } catch (error) {
          if (isAbort(error) || abort.signal.aborted) {
            this.addItem(id, { kind: "notice", text: "Stopped. What streamed before the stop is shown but not kept in the conversation." });
            return this.end(id, { status: "stopped" });
          }
          // An input the SDK could not parse at all leaves no tool call to answer, so the request is made again.
          if (!(error instanceof APIError) && error instanceof AnthropicError && parseFailures < PARSE_RETRIES) {
            parseFailures += 1;
            this.dropItems(id, startItems);
            continue;
          }
          this.dropItems(id, startItems);
          throw error;
        }
        this.patchTurn(id, (turn) => ({ usage: addUsage(turn.usage, usageOf(message)), cost: turn.cost + requestCost(settings.model, usageOf(message)) }));

        // The stop reason decides what happens to the content, before any of it is read.
        const calls = toolCalls(message.content);
        if (message.stop_reason === "refusal") {
          this.dropItems(id, startItems);
          const details = message.stop_details;
          return this.end(id, { status: "refused", category: details?.category ?? null, explanation: details?.explanation ? redact(details.explanation, key, tokens()) : null });
        }
        if (message.stop_reason === "max_tokens" && calls.length > 0) {
          this.dropItems(id, startItems);
          return this.end(id, { status: "cut-off" });
        }
        // What the model wrote and what a docs server answered are kept, and saved with the chat, without any secret in them.
        this.history.appendAssistant(redactContent(message.content, clean));
        if (message.stop_reason === "pause_turn") {
          if (!this.nextRound(id, maxRounds)) return;
          continue;
        }
        if (message.stop_reason !== "tool_use" || calls.length === 0) {
          if (message.stop_reason === "max_tokens") this.addItem(id, { kind: "notice", text: "The reply reached its length limit and was cut off." });
          return this.end(id, { status: "done" });
        }

        await this.runTools(id, calls, abort.signal, clean);
        // The draft a streamed patch drew gives way to the prototype as the call left it.
        this.options.preview?.finish();
        await this.save();
        if (abort.signal.aborted) return this.end(id, { status: "stopped" });
        if (!this.nextRound(id, maxRounds)) return;
      }
    } catch (error) {
      const servers = sources.flatMap((source) => (source.kind === "mcp" ? [sourceTitle(source)] : []));
      this.end(id, { status: "error", ...describeError(error, key, { tokens: tokens(), servers }) });
    } finally {
      this.turnSources = null;
      this.options.preview?.finish();
      if (this.abort === abort) this.abort = null;
      this.set({ running: false });
      await this.save();
    }
  }

  /** Counts a round; at the limit the turn ends and says so. */
  private nextRound(id: string, maxRounds: number): boolean {
    this.patchTurn(id, (turn) => ({ rounds: turn.rounds + 1 }));
    const rounds = this.turn(id)?.rounds ?? 0;
    if (rounds < maxRounds) return true;
    this.end(id, { status: "limit", rounds });
    return false;
  }

  private dropItems(id: string, length: number): void {
    this.patchTurn(id, (turn) => ({ items: turn.items.slice(0, length) }));
  }

  /** Shows a streamed event as it arrives. */
  private onEvent(id: string, event: BetaRawMessageStreamEvent, blocks: Map<number, number>, raw: Map<number, string>, clean: (text: string) => string): void {
    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block.type === "server_tool_use" || block.type === "mcp_tool_use") {
        // A server tool runs at Anthropic: the app shows the call, and its result block follows in the same reply.
        const started = block.input && typeof block.input === "object" && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : "";
        raw.set(event.index, started);
        const input = clean(started);
        const item: TurnItem =
          block.type === "mcp_tool_use"
            ? { kind: "source", id: block.id, via: "mcp", name: block.name, server: block.server_name, status: "running", input }
            : { kind: "source", id: block.id, via: "web", name: block.name, status: "running", input };
        blocks.set(event.index, this.addItem(id, item));
        return;
      }
      if (block.type === "web_fetch_tool_result" || block.type === "mcp_tool_result") {
        const index = this.turn(id)?.items.findIndex((item) => item.kind === "source" && item.id === block.tool_use_id) ?? -1;
        const item = index >= 0 ? this.turn(id)?.items[index] : undefined;
        if (item?.kind !== "source") return;
        if (block.type === "web_fetch_tool_result") {
          const content = block.content;
          if (content.type === "web_fetch_tool_result_error") this.setItem(id, index, { ...item, status: "error", problem: fetchProblem(content.error_code) });
          else {
            const page = pageExcerpt(content, clean);
            this.setItem(id, index, { ...item, status: "done", url: clean(content.url), ...(page.title ? { pageTitle: clean(page.title) } : {}), result: page.text });
          }
        } else {
          const text = mcpExcerpt(block.content, clean);
          this.setItem(id, index, { ...item, status: block.is_error ? "error" : "done", result: text, ...(block.is_error ? { problem: "The docs server answered with an error." } : {}) });
        }
        return;
      }
      if (block.type === "text") {
        raw.set(event.index, block.text);
        blocks.set(event.index, this.addItem(id, { kind: "text", text: clean(block.text) }));
      } else if (block.type === "thinking") {
        raw.set(event.index, block.thinking);
        blocks.set(event.index, this.addItem(id, { kind: "thinking", text: clean(block.thinking) }));
      }
      else if (block.type === "tool_use") {
        this.options.preview?.start(block.name);
        blocks.set(event.index, this.addItem(id, { kind: "tool", id: block.id, name: block.name, status: "streaming", title: `Calling ${block.name}`, input: "" }));
      }
      else if (block.type === "fallback") this.addItem(id, { kind: "notice", text: `${block.from.model} declined this request; ${block.to.model} continued it.` });
      return;
    }
    if (event.type !== "content_block_delta") return;
    const index = blocks.get(event.index);
    const item = index === undefined ? undefined : this.turn(id)?.items[index];
    if (index === undefined || !item) return;
    const delta = event.delta;
    // What is shown is redacted from the whole block as streamed so far. A secret still arriving shows in part for a
    // moment, until it is whole; it is then replaced whole, and what is kept is always redacted.
    const grown = (more: string) => {
      const text = (raw.get(event.index) ?? "") + more;
      raw.set(event.index, text);
      return clean(text);
    };
    if (delta.type === "text_delta" && item.kind === "text") this.setItem(id, index, { ...item, text: grown(delta.text) });
    else if (delta.type === "thinking_delta" && item.kind === "thinking") this.setItem(id, index, { ...item, text: grown(delta.thinking) });
    else if (delta.type === "input_json_delta" && item.kind === "tool") {
      this.options.preview?.delta(delta.partial_json);
      this.setItem(id, index, { ...item, input: grown(delta.partial_json) });
    } else if (delta.type === "input_json_delta" && item.kind === "source") this.setItem(id, index, { ...item, input: grown(delta.partial_json) });
  }

  private toolIndex(id: string, callId: string): number {
    return this.turn(id)?.items.findIndex((item) => item.kind === "tool" && item.id === callId) ?? -1;
  }

  /** Runs each call in order; every call gets a result, so the history stays valid however the round ends. */
  private async runTools(id: string, calls: readonly { id: string; name: string; input: unknown }[], signal: AbortSignal, clean: (text: string) => string): Promise<void> {
    const host = this.options.host;
    const results: BetaToolResultBlockParam[] = [];
    let changed = false;
    let checkedSinceChange = false;
    for (const call of calls) {
      const index = this.toolIndex(id, call.id);
      const item = index >= 0 ? this.turn(id)?.items[index] : undefined;
      const input = clean(JSON.stringify(call.input, null, 2));
      if (signal.aborted) {
        results.push({ type: "tool_result", tool_use_id: call.id, content: "Not run: the person stopped the agent.", is_error: true });
        if (item?.kind === "tool") this.setItem(id, index, { ...item, input, status: "error", title: `${call.name} not run: stopped`, result: "Not run: the person stopped the agent." });
        continue;
      }
      if (item?.kind === "tool") this.setItem(id, index, { ...item, input, status: "running" });
      const before = host.prototype();
      let outcome: ToolOutcome;
      try {
        outcome = await runTool(call, host, signal);
      } catch (error) {
        const stopped = signal.aborted;
        const text = stopped ? "Stopped by the person before it finished." : `The tool failed: ${error instanceof Error ? error.message : String(error)}`;
        outcome = { content: text, isError: true, changed: false, title: `${call.name} ${stopped ? "stopped" : "failed"}` };
      }
      if (outcome.changed) {
        changed = true;
        checkedSinceChange = false;
        if (this.turn(id)?.before === null) this.patchTurn(id, () => ({ before }));
      }
      if (outcome.measured) checkedSinceChange = true;
      const addressed = outcome.addressed;
      if (addressed) this.patchTurn(id, (turn) => ({ addressed: [...(turn.addressed ?? []), addressed] }));
      // A result may quote the call's input, so it is redacted like the input.
      const content = clean(outcome.content);
      results.push({ type: "tool_result", tool_use_id: call.id, content, ...(outcome.isError ? { is_error: true } : {}) });
      const now = this.toolIndex(id, call.id);
      const current = now >= 0 ? this.turn(id)?.items[now] : undefined;
      if (current?.kind === "tool") this.setItem(id, now, { ...current, input, status: outcome.isError ? "error" : "done", title: outcome.title, result: content });
      if (outcome.measured) this.addItem(id, { kind: "checks", revision: outcome.measured.revision, status: outcome.measured.report.status, title: checksTitle(outcome.measured.report), text: content, ...reportRules(outcome.measured.report) });
      if (outcome.proposal) this.addItem(id, { kind: "proposal", ...outcome.proposal });
      if (outcome.variants) this.addItem(id, { kind: "variants", page: outcome.variants.page, ids: outcome.variants.ids, action: call.name === "revise_variant" ? "revised" : "offered" });
    }
    // After a round that changed the prototype, the agent gets the checks for it whether it asked or not.
    const notes: string[] = [];
    if (changed && !checkedSinceChange && !signal.aborted) {
      try {
        const measured = await host.measured(signal);
        // The report quotes frames' messages and the spec's values, so it is redacted like a tool's result.
        const text = clean(describeMeasured(measured));
        notes.push(`The app re-rendered every frame after your changes and ran the checks.\n${text}`);
        this.addItem(id, { kind: "checks", revision: measured.revision, status: measured.report.status, title: checksTitle(measured.report), text, ...reportRules(measured.report) });
      } catch {
        // Stopped while waiting: the results still go back, without checks.
      }
    }
    this.history.appendToolResults(results, notes);
  }
}
