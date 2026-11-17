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

/**
 * What went wrong with a request, said plainly, from the SDK's typed error
 * classes and never from matching message text. Every string shown is passed
 * through `redact` first, so the key cannot reach the screen even if an
 * error body were to echo it.
 */

export type ShownError = { readonly title: string; readonly detail: string; readonly retry: boolean };

/** Replaces the key, and anything shaped like an Anthropic key, with a marker. */
export function redact(text: string, key: string | null): string {
  let out = text;
  if (key && key.length >= 8) out = out.split(key).join("[your API key]");
  return out.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[an API key]");
}

export function describeError(error: unknown, key: string | null): ShownError {
  const shown = (title: string, detail: string, retry: boolean): ShownError => ({ title, detail: redact(detail, key), retry });
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
  if (error instanceof BadRequestError) return shown("The request was refused", `Anthropic refused the request (400). ${apiDetail(error)}`, false);
  if (error instanceof InternalServerError) return shown("Anthropic had an error", `The API failed (${error.status}). Retry in a moment. ${apiDetail(error)}`, true);
  if (error instanceof APIError) return shown("The request failed", `${error.status ? `${error.status}. ` : ""}${apiDetail(error)}`, true);
  if (error instanceof AnthropicError) return shown("A reply could not be read", `${error.message.slice(0, 300)} The request was made again and still failed.`, true);
  return shown("Something went wrong", error instanceof Error ? error.message : String(error), true);
}

export function isAbort(error: unknown): boolean {
  return error instanceof APIUserAbortError || (error instanceof DOMException && error.name === "AbortError");
}
