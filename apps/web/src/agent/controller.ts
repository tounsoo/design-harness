import { APIError, AnthropicError } from "@anthropic-ai/sdk/core/error";
import type { BetaMessage, BetaMessageParam, BetaRawMessageStreamEvent, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { CheckStatus, Prototype } from "@design-harness/core";
import { describeError, isAbort, redact } from "./errors";
import { History, toolCalls } from "./history";
import { NO_USAGE, addUsage, requestCost, type AgentSettings, type Usage } from "./models";
import { createClient, requestBody, type MessagesApi } from "./request";
import { checksTitle, describeMeasured, runTool, type AgentHost, type ToolOutcome } from "./tools";

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
  | { readonly kind: "checks"; readonly revision: number; readonly status: CheckStatus; readonly title: string; readonly text: string }
  | { readonly kind: "proposal"; readonly id: string; readonly title: string; readonly adoptable: boolean; readonly verdict: string }
  | { readonly kind: "notice"; readonly text: string };

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
};

/** What is saved per prototype. It never holds the API key. */
export type ChatRecord = { readonly version: 1; readonly history: readonly BetaMessageParam[]; readonly turns: readonly Turn[]; readonly pending: readonly string[] };

export type ChatStore = { load(): Promise<ChatRecord | null>; save(record: ChatRecord): Promise<void> };

export type AgentState = { readonly turns: readonly Turn[]; readonly running: boolean; readonly loaded: boolean; readonly problem: string | null };

export type AgentOptions = {
  readonly host: AgentHost;
  readonly store: ChatStore;
  readonly key: () => string | null;
  readonly settings: () => AgentSettings;
  /** Builds the API client for a key; tests pass one with a scripted fetch. */
  readonly client?: (key: string) => MessagesApi;
  readonly maxRounds?: number;
  readonly newId?: () => string;
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
    Array.isArray(record.pending)
  );
}

function usageOf(message: BetaMessage): Usage {
  const usage = message.usage;
  return { input: usage.input_tokens, output: usage.output_tokens, cacheWrite: usage.cache_creation_input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, requests: 1 };
}

const short = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}...` : text);

export class AgentController {
  private state: AgentState = { turns: [], running: false, loaded: false, problem: null };
  private readonly listeners = new Set<() => void>();
  private history = new History();
  private pending: string[] = [];
  private abort: AbortController | null = null;
  private saving: Promise<void> = Promise.resolve();
  private loading: Promise<void> | null = null;

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
        // Calls the page closed on before they ran are answered, so the history stays valid; nothing is removed.
        const unanswered = this.history.unansweredCalls();
        if (unanswered.length > 0) this.history.appendToolResults(unanswered.map((id) => ({ type: "tool_result", tool_use_id: id, content: "Not run: the page closed before this ran.", is_error: true })));
        // A turn that was running when the page closed did not finish.
        const turns = record.turns.map((turn) => (turn.end.status === "running" ? { ...turn, end: { status: "stopped" as const } } : turn));
        this.set({ turns, loaded: true });
        return;
      }
      this.set({ loaded: true });
    } catch (error) {
      this.set({ loaded: true, problem: `The saved chat could not be opened: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private save(): Promise<void> {
    const record: ChatRecord = { version: 1, history: this.history.toJSON(), turns: this.state.turns, pending: this.pending };
    this.saving = this.saving.then(() => this.options.store.save(record)).catch(() => undefined);
    return this.saving;
  }

  /** Sends a message from the person and runs the agent until the turn ends. */
  async send(text: string): Promise<void> {
    const message = text.trim();
    // A message sent while the saved chat is still loading waits for it, so the loaded history cannot replace it.
    if (this.loading) await this.loading;
    if (!message || this.state.running) return;
    const settings = this.options.settings();
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
    };
    this.history.appendUser(message, this.pending);
    this.pending = [];
    this.set({ turns: [...this.state.turns, turn] });
    await this.run(turn.id);
  }

  /** Runs the last turn again from where it failed, when its error allows a retry. */
  async retry(): Promise<void> {
    const last = this.state.turns.at(-1);
    if (!last || this.state.running || last.end.status !== "error" || !last.end.retry) return;
    this.patchTurn(last.id, () => ({ end: { status: "running" } }));
    await this.run(last.id);
  }

  /** Stops the running turn: the stream is aborted, and a tool waiting on the checks stops waiting. */
  stop(): void {
    this.abort?.abort();
  }

  /** The turn whose changes can be undone now: the latest turn that changed the prototype and is not undone yet. */
  undoable(): Turn | undefined {
    if (this.state.running) return undefined;
    return [...this.state.turns].reverse().find((turn) => turn.before !== null && !turn.undone);
  }

  /** Puts the prototype back as it was before a turn, as one step, and tells the agent next time. */
  async undo(id: string): Promise<void> {
    const turn = this.undoable();
    if (!turn || turn.id !== id || !turn.before) return;
    this.options.host.apply(turn.before);
    this.pending.push(`The person undid your changes from their message "${short(turn.text)}": the prototype is back to what it was before that message. Read the files again before you change them.`);
    this.patchTurn(id, () => ({ undone: true }));
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
    let parseFailures = 0;
    try {
      for (;;) {
        if (abort.signal.aborted) return this.end(id, { status: "stopped" });
        const settings = this.options.settings();
        const startItems = this.turn(id)?.items.length ?? 0;
        const blocks = new Map<number, number>();
        let message: BetaMessage;
        try {
          const stream = client.stream(requestBody(settings, this.history.messages), { signal: abort.signal });
          for await (const event of stream) this.onEvent(id, event, blocks);
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
          return this.end(id, { status: "refused", category: details?.category ?? null, explanation: details?.explanation ? redact(details.explanation, key) : null });
        }
        if (message.stop_reason === "max_tokens" && calls.length > 0) {
          this.dropItems(id, startItems);
          return this.end(id, { status: "cut-off" });
        }
        this.history.appendAssistant(message.content);
        if (message.stop_reason === "pause_turn") {
          if (!this.nextRound(id, maxRounds)) return;
          continue;
        }
        if (message.stop_reason !== "tool_use" || calls.length === 0) {
          if (message.stop_reason === "max_tokens") this.addItem(id, { kind: "notice", text: "The reply reached its length limit and was cut off." });
          return this.end(id, { status: "done" });
        }

        await this.runTools(id, calls, abort.signal);
        await this.save();
        if (abort.signal.aborted) return this.end(id, { status: "stopped" });
        if (!this.nextRound(id, maxRounds)) return;
      }
    } catch (error) {
      this.end(id, { status: "error", ...describeError(error, key) });
    } finally {
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
  private onEvent(id: string, event: BetaRawMessageStreamEvent, blocks: Map<number, number>): void {
    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block.type === "text") blocks.set(event.index, this.addItem(id, { kind: "text", text: block.text }));
      else if (block.type === "thinking") blocks.set(event.index, this.addItem(id, { kind: "thinking", text: block.thinking }));
      else if (block.type === "tool_use") blocks.set(event.index, this.addItem(id, { kind: "tool", id: block.id, name: block.name, status: "streaming", title: `Calling ${block.name}`, input: "" }));
      else if (block.type === "fallback") this.addItem(id, { kind: "notice", text: `${block.from.model} declined this request; ${block.to.model} continued it.` });
      return;
    }
    if (event.type !== "content_block_delta") return;
    const index = blocks.get(event.index);
    const item = index === undefined ? undefined : this.turn(id)?.items[index];
    if (index === undefined || !item) return;
    const delta = event.delta;
    if (delta.type === "text_delta" && item.kind === "text") this.setItem(id, index, { ...item, text: item.text + delta.text });
    else if (delta.type === "thinking_delta" && item.kind === "thinking") this.setItem(id, index, { ...item, text: item.text + delta.thinking });
    else if (delta.type === "input_json_delta" && item.kind === "tool") this.setItem(id, index, { ...item, input: item.input + delta.partial_json });
  }

  private toolIndex(id: string, callId: string): number {
    return this.turn(id)?.items.findIndex((item) => item.kind === "tool" && item.id === callId) ?? -1;
  }

  /** Runs each call in order; every call gets a result, so the history stays valid however the round ends. */
  private async runTools(id: string, calls: readonly { id: string; name: string; input: unknown }[], signal: AbortSignal): Promise<void> {
    const host = this.options.host;
    const results: BetaToolResultBlockParam[] = [];
    let changed = false;
    let checkedSinceChange = false;
    for (const call of calls) {
      const index = this.toolIndex(id, call.id);
      const item = index >= 0 ? this.turn(id)?.items[index] : undefined;
      const input = JSON.stringify(call.input, null, 2);
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
      results.push({ type: "tool_result", tool_use_id: call.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
      const now = this.toolIndex(id, call.id);
      const current = now >= 0 ? this.turn(id)?.items[now] : undefined;
      if (current?.kind === "tool") this.setItem(id, now, { ...current, input, status: outcome.isError ? "error" : "done", title: outcome.title, result: outcome.content });
      if (outcome.measured) this.addItem(id, { kind: "checks", revision: outcome.measured.revision, status: outcome.measured.report.status, title: checksTitle(outcome.measured.report), text: outcome.content });
      if (outcome.proposal) this.addItem(id, { kind: "proposal", ...outcome.proposal });
    }
    // After a round that changed the prototype, the agent gets the checks for it whether it asked or not.
    const notes: string[] = [];
    if (changed && !checkedSinceChange && !signal.aborted) {
      try {
        const measured = await host.measured(signal);
        const text = describeMeasured(measured);
        notes.push(`The app re-rendered every frame after your changes and ran the checks.\n${text}`);
        this.addItem(id, { kind: "checks", revision: measured.revision, status: measured.report.status, title: checksTitle(measured.report), text });
      } catch {
        // Stopped while waiting: the results still go back, without checks.
      }
    }
    this.history.appendToolResults(results, notes);
  }
}
