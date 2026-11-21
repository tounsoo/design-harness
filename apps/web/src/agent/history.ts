import type { BetaContentBlock, BetaContentBlockParam, BetaMessageParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";

/**
 * The conversation as the API sees it, append-only. Earlier turns are never
 * rewritten or dropped, and an assistant turn goes back exactly as the API
 * returned it, thinking blocks and their signatures included, so the cached
 * prefix stays warm and replayed thinking stays valid. Every appended message
 * is a deep-frozen copy, so nothing can change it later by accident.
 *
 * The one transformation is the API's own rule for echoing a turn that a
 * server-side refusal fallback continued: before the last `fallback` block,
 * only text and the fallback markers go back; thinking, tool calls and any
 * block type this app does not know, all from the model that declined, are
 * left out. It is applied once, when the turn is appended, so every later
 * request sends the same bytes.
 */

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

/** A plain copy: JSON drops the SDK's non-enumerable stream bookkeeping. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Block types an assistant turn may carry that this app sends back as they
 * are. The server tools' calls and results, a page web fetch read and a docs
 * server's MCP tool call and its answer, are part of the turn: they go back
 * whole, so the conversation stays the one the API produced and a turn
 * paused mid-tool (`pause_turn`) can continue.
 */
const KNOWN = new Set(["text", "thinking", "redacted_thinking", "tool_use", "fallback", "server_tool_use", "web_fetch_tool_result", "web_search_tool_result", "mcp_tool_use", "mcp_tool_result"]);

/** The blocks of an assistant turn that go back to the API, in their order. */
export function echoable(content: readonly BetaContentBlock[]): BetaContentBlockParam[] {
  let boundary = -1;
  content.forEach((block, index) => {
    if (block.type === "fallback") boundary = index;
  });
  const kept = content.filter((block, index) => {
    if (index < boundary) return block.type === "text" || block.type === "fallback";
    return KNOWN.has(block.type);
  });
  return copy(kept) as unknown as BetaContentBlockParam[];
}

/** The tool calls of an assistant turn that the app runs: those after the last fallback boundary, which the serving model made. */
export function toolCalls(content: readonly BetaContentBlock[]): { id: string; name: string; input: unknown }[] {
  let boundary = -1;
  content.forEach((block, index) => {
    if (block.type === "fallback") boundary = index;
  });
  return content.flatMap((block, index) => (index > boundary && block.type === "tool_use" ? [{ id: block.id, name: block.name, input: block.input }] : []));
}

export class History {
  private readonly items: BetaMessageParam[];

  constructor(initial: readonly BetaMessageParam[] = []) {
    this.items = initial.map((message) => deepFreeze(copy(message)));
  }

  /** The messages to send, oldest first. The array is new; the messages in it are the same frozen objects every time. */
  get messages(): readonly BetaMessageParam[] {
    return [...this.items];
  }

  get length(): number {
    return this.items.length;
  }

  /** Whose turn it is to speak next by the history alone: the user's after an assistant turn, else the assistant's. */
  get last(): "user" | "assistant" | null {
    return this.items.at(-1)?.role === "assistant" ? "assistant" : this.items.length === 0 ? null : "user";
  }

  /** The ids of the last assistant turn's tool calls, when no results follow them yet. */
  unansweredCalls(): string[] {
    const last = this.items.at(-1);
    if (last?.role !== "assistant" || !Array.isArray(last.content)) return [];
    return last.content.flatMap((block) => (block.type === "tool_use" ? [block.id] : []));
  }

  appendUser(text: string, notes: readonly string[] = []): void {
    const content: BetaContentBlockParam[] = [...notes.map((note) => ({ type: "text" as const, text: note })), { type: "text", text }];
    this.items.push(deepFreeze({ role: "user", content }));
  }

  /** Appends an assistant turn as the API returned it (see `echoable`), and returns what was appended. */
  appendAssistant(content: readonly BetaContentBlock[]): readonly BetaContentBlockParam[] {
    const blocks = echoable(content);
    this.items.push(deepFreeze({ role: "assistant", content: blocks }));
    return blocks;
  }

  /**
   * Appends the results of an assistant turn's tool calls, one per call, and
   * after them any text the app adds, such as the checks it ran. Every
   * tool_use the last assistant turn carries must have its result here.
   */
  appendToolResults(results: readonly BetaToolResultBlockParam[], notes: readonly string[] = []): void {
    const last = this.items.at(-1);
    const expected = last?.role === "assistant" && Array.isArray(last.content) ? last.content.flatMap((block) => (block.type === "tool_use" ? [block.id] : [])) : [];
    const given = results.map((result) => result.tool_use_id);
    if (expected.length !== given.length || expected.some((id, index) => id !== given[index])) {
      throw new Error(`tool results must answer the last turn's calls in order: expected ${expected.join(", ") || "none"}, got ${given.join(", ") || "none"}`);
    }
    const content: BetaContentBlockParam[] = [...copy(results), ...notes.map((note) => ({ type: "text" as const, text: note }))];
    this.items.push(deepFreeze({ role: "user", content }));
  }

  toJSON(): BetaMessageParam[] {
    return copy(this.items);
  }
}
