import type { BetaTextBlock, BetaWebFetchBlock, BetaWebFetchToolResultErrorCode } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { TurnItem } from "./controller";

/**
 * The agent's reading of the project's docs, in plain words: a page web
 * fetch read or could not read, and a docs server's tool and its answer.
 * The chat keeps a short excerpt of each; the whole of it stays in the API
 * history, where the agent reads it.
 */

type SourceItem = Extract<TurnItem, { kind: "source" }>;

/** Characters of a page or an answer the chat keeps, enough to see what it was. */
export const EXCERPT = 600;

const excerpt = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1)}…` : flat;
};

/** A web fetch error code, as a designer reads it. */
export function fetchProblem(code: BetaWebFetchToolResultErrorCode | string): string {
  switch (code) {
    case "url_not_allowed":
      return "That address is not on one of the project's docs sites, or the site does not allow it to be read.";
    case "url_not_in_prior_context":
      return "The agent can only open an address that is in the conversation. Send another message so it is told the project's docs again.";
    case "url_not_accessible":
      return "The page could not be opened: the site answered with an error or could not be reached.";
    case "url_too_long":
      return "The address is too long to open.";
    case "invalid_tool_input":
      return "That is not an address the agent can open.";
    case "unsupported_content_type":
      return "That page is not text, a web page or a PDF, so it cannot be read.";
    case "content_too_large":
      return "That document is too large to read.";
    case "too_many_requests":
      return "Too many pages were opened at once. Try again in a moment.";
    case "max_uses_exceeded":
      return "The agent opened as many pages as one message allows.";
    default:
      return "The page could not be read.";
  }
}

/** A fetched page's title and the start of its text; a PDF or other binary content has no text to show. */
export function pageExcerpt(result: BetaWebFetchBlock, clean: (text: string) => string = (text) => text): { readonly title: string | null; readonly text: string } {
  const document = result.content;
  const source = document.source;
  // Cleaned whole before it is cut, so a secret across the cut is not left in part.
  const text = source.type === "text" ? excerpt(clean(source.data)) : "";
  return { title: document.title ?? null, text };
}

/** A docs server's answer, as text, cleaned whole before it is cut, so a secret across the cut is not left in part. */
export function mcpExcerpt(content: string | readonly BetaTextBlock[], clean: (text: string) => string = (text) => text): string {
  return excerpt(clean(typeof content === "string" ? content : content.map((block) => block.text).join("\n")));
}

/** The address a web fetch call asked for, from its input as it streamed. */
export function fetchedUrl(item: SourceItem): string | null {
  if (item.url) return item.url;
  try {
    const value: unknown = JSON.parse(item.input || "{}");
    const url = typeof value === "object" && value !== null ? (value as { url?: unknown }).url : undefined;
    return typeof url === "string" ? url : null;
  } catch {
    return /"url"\s*:\s*"([^"]+)"/.exec(item.input)?.[1] ?? null;
  }
}

/** The short line the chat shows for a source item. `finished` is false while its turn still runs; a call with no answer by then never got one. */
export function sourceSummary(item: SourceItem, finished: boolean, serverTitle: (name: string) => string = (name) => name): string {
  if (item.via === "web") {
    const url = fetchedUrl(item);
    const where = item.pageTitle ?? url ?? "a page";
    if (item.status === "running") return finished ? `Did not finish reading ${url ?? "a page"}` : `Reading ${url ?? "a page"}…`;
    if (item.status === "error") return `Could not read ${url ?? "a page"}`;
    return `Read ${where}`;
  }
  const server = serverTitle(item.server ?? "");
  if (item.status === "running") return finished ? `${server} did not answer ${item.name}` : `Asking ${server}: ${item.name}…`;
  if (item.status === "error") return `${server} could not answer ${item.name}`;
  return `Asked ${server}: ${item.name}`;
}
