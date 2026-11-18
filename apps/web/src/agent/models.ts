/**
 * The models the chat can use, the effort levels, and an approximate price
 * per million tokens for the cost shown under each turn. Prices are the list
 * prices in Anthropic's model guide for these models; the shown cost is an
 * estimate from the request's reported usage, not a bill.
 */

export const MODELS = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
] as const;
export type ModelId = (typeof MODELS)[number]["id"];

/** `output_config.effort`: how much the model thinks, and so its latency and cost. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export type AgentSettings = { readonly model: ModelId; readonly effort: Effort };

/** Opus 5.5 at medium effort, its API default, set explicitly; medium is a good start for agentic coding. */
export const DEFAULT_SETTINGS: AgentSettings = { model: "claude-opus-5-5", effort: "medium" };

export function isModel(value: unknown): value is ModelId {
  return MODELS.some((model) => model.id === value);
}

export function isEffort(value: unknown): value is Effort {
  return (EFFORTS as readonly unknown[]).includes(value);
}

/** Token counts of one or more requests, as the API reports them. */
export type Usage = { readonly input: number; readonly output: number; readonly cacheWrite: number; readonly cacheRead: number; readonly requests: number };

export const NO_USAGE: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, requests: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead, requests: a.requests + b.requests };
}

/** Dollars per million tokens: input, output, 5-minute cache write, cache read. */
type Rates = { readonly input: number; readonly output: number; readonly cacheWrite: number; readonly cacheRead: number };

function rates(model: ModelId, promptTokens: number): Rates {
  switch (model) {
    case "claude-opus-5-5":
      return { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 };
    case "claude-sonnet-5-5":
      return { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 };
    case "claude-haiku-5-5":
      // Two rate cards, chosen by the prompt's length.
      return promptTokens <= 100_000 ? { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 } : { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 };
  }
}

/** The approximate cost in dollars of one request's usage on `model`. */
export function requestCost(model: ModelId, usage: Usage): number {
  const rate = rates(model, usage.input + usage.cacheWrite + usage.cacheRead);
  return (usage.input * rate.input + usage.output * rate.output + usage.cacheWrite * rate.cacheWrite + usage.cacheRead * rate.cacheRead) / 1_000_000;
}

export function formatCost(dollars: number): string {
  if (dollars === 0) return "$0";
  if (dollars < 0.01) return "<$0.01";
  return `$${dollars.toFixed(dollars < 1 ? 3 : 2)}`;
}
