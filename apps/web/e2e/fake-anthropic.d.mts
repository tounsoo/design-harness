/** Types for fake-anthropic.mjs, which unit tests import too. */
export type FakeBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "fallback"; from: string; to: string }
  | { type: "web_fetch"; id: string; url: string }
  | { type: "web_fetch_result"; id: string; url: string; text?: string; title?: string; error?: string }
  | { type: "mcp_tool_use"; id: string; name: string; server: string; input: unknown }
  | { type: "mcp_tool_result"; id: string; text: string; isError?: boolean };

export type FakeEvent = { event: string; data: unknown };

export type FakeReply = { events: FakeEvent[]; holdAfter?: number; delayMs?: number; onHold?: () => void } | { status: number; body: unknown };

export function streamEvents(script: {
  id?: string;
  model?: string;
  blocks: FakeBlock[];
  stopReason: string;
  stopDetails?: unknown;
  usage?: { input?: number; output?: number; cacheWrite?: number; cacheRead?: number };
}): FakeEvent[];

export function sseText(events: FakeEvent[]): string;

export function errorBody(type: string, message: string): unknown;

export function scriptedFetch(replies: ReadonlyArray<FakeReply | ((body: { messages: Array<{ role: string; content: unknown }> } & Record<string, unknown>) => FakeReply)>): {
  fetch: typeof fetch;
  requests: Array<{ url: string; body: Record<string, unknown> & { messages: Array<{ role: string; content: unknown }> }; headers: Headers }>;
  left: () => number;
};
