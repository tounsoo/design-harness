import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AnthropicError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk/core/error";
import type { BetaContentBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";

/**
 * What went wrong with a request, said plainly, from the SDK's typed error
 * classes and never from matching message text. Every string shown is passed
 * through `redact` first, so the key cannot reach the screen even if an
 * error body were to echo it.
 */

export type ShownError = { readonly title: string; readonly detail: string; readonly retry: boolean };

/** Replaces the key, every docs server token given, and anything shaped like an Anthropic key, with a marker. */
export function redact(text: string, key: string | null, tokens: readonly string[] = []): string {
  let out = text;
  if (key && key.length >= 8) out = out.split(key).join("[your API key]");
  // Longest first, so a token that holds another is replaced whole.
  // Each also as it is written inside a JSON string, so a token with a quote or a backslash is caught in a tool's input as shown.
  const forms = tokens.flatMap((token) => [token, JSON.stringify(token).slice(1, -1)]);
  for (const token of [...new Set(forms)].sort((a, b) => b.length - a.length)) if (token.length >= 4) out = out.split(token).join("[a docs server token]");
  return out.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[an API key]");
}

/**
 * A reply's content with every secret `clean` finds replaced, before it is kept
 * in the conversation and saved with the chat: every string in every block,
 * keys included, so the model's text, a tool call's input, what a docs server
 * answered and what a page fetch returned are all covered. Thinking is kept as
 * it came, because the API checks its signature when it is sent back.
 */
export function redactContent(content: readonly BetaContentBlock[], clean: (text: string) => string): BetaContentBlock[] {
  return content.map((block) => (block.type === "thinking" || block.type === "redacted_thinking" ? block : (redactStrings(block, clean) as typeof block)));
}

function redactStrings(value: unknown, clean: (text: string) => string): unknown {
  if (typeof value === "string") return clean(value);
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, clean));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [clean(key), redactStrings(item, clean)]));
  return value;
}

/** The docs servers a refused request named, so a 400 about one can say where to look. */
export type ErrorContext = { readonly tokens?: readonly string[]; readonly servers?: readonly string[] };

export function describeError(error: unknown, key: string | null, context: ErrorContext = {}): ShownError {
  const shown = (title: string, detail: string, retry: boolean): ShownError => ({ title, detail: redact(detail, key, context.tokens), retry });
  const servers = context.servers ?? [];
  const apiDetail = (value: APIError) => [value.apiMessage ?? value.message, value.requestID ? `Request ${value.requestID}.` : ""].filter(Boolean).join(" ");
  if (error instanceof AuthenticationError) return shown("The API key was refused", `Anthropic did not accept this key (401). Check it in the chat's settings, or enter another. ${apiDetail(error)}`, false);
  if (error instanceof PermissionDeniedError) return shown("This key may not use this model", `Anthropic refused the request (403). ${apiDetail(error)}`, false);
  if (error instanceof RateLimitError) {
    const after = error.headers?.get("retry-after");
    return shown("Rate limited", `Anthropic is limiting this key's requests (429)${after ? `; it asks to wait ${after} s` : ""}. Retry in a moment. ${apiDetail(error)}`, true);
  }
  if (error instanceof APIError && (error.status === 529 || error.type === "overloaded_error")) return shown("Anthropic is overloaded", `The API is busy right now (${error.status ?? "during the stream"}). Retry in a moment.`, true);
  if (error instanceof APIConnectionTimeoutError) return shown("The request timed out", "No answer came in time. Retry, or check your connection.", true);
  if (error instanceof APIUserAbortError) return shown("Stopped", "You stopped the agent.", false);
  if (error instanceof APIConnectionError) return shown("No connection to Anthropic", "The request did not reach api.anthropic.com. Check your connection, then retry.", true);
  if (error instanceof BadRequestError) {
    // The MCP connector reaches a project's docs servers while it handles the request, so one it cannot reach, or that refuses its token, refuses the request.
    const hint = servers.length > 0 ? ` This request used the docs ${servers.length === 1 ? `server ${servers[0]}` : `servers ${servers.join(", ")}`}. If Anthropic could not reach ${servers.length === 1 ? "it" : "one of them"}, or ${servers.length === 1 ? "it" : "one"} refused its token, the request is refused like this: check the address and the token under Docs in the Project view, or remove the server, then send again.` : "";
    return shown("The request was refused", `Anthropic refused the request (400). ${apiDetail(error)}${hint}`, false);
  }
  if (error instanceof InternalServerError) return shown("Anthropic had an error", `The API failed (${error.status}). Retry in a moment. ${apiDetail(error)}`, true);
  if (error instanceof APIError) return shown("The request failed", `${error.status ? `${error.status}. ` : ""}${apiDetail(error)}`, true);
  if (error instanceof AnthropicError) return shown("A reply could not be read", `${error.message.slice(0, 300)} The request was made again and still failed.`, true);
  return shown("Something went wrong", error instanceof Error ? error.message : String(error), true);
}

export function isAbort(error: unknown): boolean {
  return error instanceof APIUserAbortError || (error instanceof DOMException && error.name === "AbortError");
}
