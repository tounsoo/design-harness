/**
 * A project's documentation sources: websites, such as the design system's
 * docs site, and remote MCP servers, such as a docs or knowledge connector,
 * that the agent may read when it designs, proposes or answers. They are the
 * person's context for the agent and nothing else: core never reads them,
 * they are not a rule input, and they change no report.
 *
 * A source holds no secret. An MCP server's token is kept apart, like the
 * API key (`token-vault.ts`), and never in a source, the project store, an
 * export or a frame. Requests to these sites and servers are made by
 * Anthropic's API, server side (`agent/doc-request.ts`), never by this
 * browser and never by a frame.
 */

export type WebsiteSource = { readonly kind: "website"; readonly url: string; readonly label?: string };
/** `name` is the server's name in the request (`mcp_servers[].name`): a slug, unique in the project. */
export type McpSource = { readonly kind: "mcp"; readonly url: string; readonly name: string; readonly label?: string };
export type DocSource = WebsiteSource | McpSource;

/** At most this many sources: enough for a docs site or two and a connector, and well under the API's 64 allowed domains. */
export const MAX_SOURCES = 10;
/** The web fetch tool refuses a URL longer than this (`url_too_long`), so a website's address must fit. */
export const MAX_WEBSITE_URL = 250;
const MAX_MCP_URL = 2000;
const MAX_LABEL = 80;
const MAX_NAME = 64;
export const SERVER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A host name the API can reach and filter on: a public DNS name, not an IP address, localhost or a single label. */
function hostProblem(host: string): string | null {
  if (host === "") return "The address has no host.";
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return "Use the site's name, not an IP address.";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return "Anthropic cannot reach an address on your own computer or network. Use a public address.";
  if (!host.includes(".")) return "Use the site's full name, such as docs.example.com.";
  return null;
}

/**
 * Why a URL cannot be a source, in plain words, or null. It must be a whole
 * https address on a public host, with no user name or password in it: a
 * credential belongs in a docs server's token, which is kept apart.
 */
export function urlProblem(text: string, kind: DocSource["kind"]): string | null {
  const value = text.trim();
  if (value === "") return "Enter the address.";
  if (/\s/.test(value)) return "An address has no spaces.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "That is not a whole web address. It starts with https://.";
  }
  if (url.protocol !== "https:") return "Use an https:// address.";
  if (url.username !== "" || url.password !== "") return kind === "mcp" ? "Leave the user name and password out of the address. Put a token in the token field instead." : "Leave the user name and password out of the address.";
  const host = hostProblem(url.hostname);
  if (host) return host;
  if (url.port !== "" && url.port !== "443") return "Use the standard https port.";
  if (kind === "website" && value.length > MAX_WEBSITE_URL) return `The address is longer than ${MAX_WEBSITE_URL} characters, which is more than the agent can open.`;
  if (kind === "mcp" && value.length > MAX_MCP_URL) return `The address is longer than ${MAX_MCP_URL} characters.`;
  return null;
}

/** The domain a website source lets the agent read: the URL's host, lowercase. A host covers its subdomains, not its parent. */
export function websiteDomain(url: string): string {
  return new URL(url.trim()).hostname.toLowerCase();
}

/** The domains of every website source, each once, in order. */
export function websiteDomains(sources: readonly DocSource[]): string[] {
  return [...new Set(sources.filter((source): source is WebsiteSource => source.kind === "website").map((source) => websiteDomain(source.url)))].sort();
}

/** A server name from a label or a URL: a lowercase slug, as `name` takes it. */
export function suggestName(text: string): string {
  let base = text.trim();
  try {
    base = new URL(base).hostname.replace(/^(www|mcp|api)\./, "").split(".")[0] ?? base;
  } catch {
    // Not a URL: a label.
  }
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_NAME) || "docs";
}

export function nameProblem(name: string): string | null {
  if (name === "") return "Give the server a short name.";
  if (name.length > MAX_NAME) return `A name is at most ${MAX_NAME} characters.`;
  if (!SERVER_NAME.test(name)) return "Use lowercase letters, numbers and single dashes, such as design-docs.";
  return null;
}

/** A source as a person reads it: its label, or its address. */
export function sourceTitle(source: DocSource): string {
  return source.label ?? (source.kind === "mcp" ? source.name : source.url);
}

/** A source with its text trimmed and an empty label left out. */
export function cleanSource(source: DocSource): DocSource {
  const label = source.label?.trim();
  const url = source.url.trim();
  return source.kind === "website" ? { kind: "website", url, ...(label ? { label } : {}) } : { kind: "mcp", url, name: source.name.trim(), ...(label ? { label } : {}) };
}

/**
 * Every problem with a list of sources, each with where it is (`$[1].url`),
 * a duplicate address or server name included.
 */
export function sourceProblems(sources: readonly unknown[]): string[] {
  const problems: string[] = [];
  if (sources.length > MAX_SOURCES) problems.push(`$: at most ${MAX_SOURCES} sources`);
  const urls = new Set<string>();
  const names = new Set<string>();
  sources.forEach((entry, index) => {
    const at = `$[${index}]`;
    if (!isObject(entry)) return problems.push(`${at}: expected a source object`);
    const kind = entry.kind;
    if (kind !== "website" && kind !== "mcp") return problems.push(`${at}.kind: expected "website" or "mcp"`);
    const allowed = kind === "website" ? ["kind", "url", "label"] : ["kind", "url", "name", "label"];
    const extra = Object.keys(entry).filter((key) => !allowed.includes(key));
    // A token or any other field has no place here: a docs server's token is kept apart, on this device only.
    if (extra.length > 0) problems.push(`${at}: has unknown fields ${extra.map((key) => `"${key}"`).join(", ")}`);
    if (typeof entry.url !== "string") problems.push(`${at}.url: expected a string`);
    else {
      const why = urlProblem(entry.url, kind);
      if (why) problems.push(`${at}.url: ${why}`);
      else if (urls.has(`${kind} ${entry.url.trim()}`)) problems.push(`${at}.url: this address is already a source`);
      else urls.add(`${kind} ${entry.url.trim()}`);
    }
    if (entry.label !== undefined && (typeof entry.label !== "string" || entry.label.trim() === "" || entry.label.length > MAX_LABEL)) problems.push(`${at}.label: expected text of 1 to ${MAX_LABEL} characters`);
    if (kind === "mcp") {
      if (typeof entry.name !== "string") problems.push(`${at}.name: expected a string`);
      else {
        const why = nameProblem(entry.name);
        if (why) problems.push(`${at}.name: ${why}`);
        else if (names.has(entry.name)) problems.push(`${at}.name: another docs server is named "${entry.name}"`);
        else names.add(entry.name);
      }
    }
    return undefined;
  });
  return problems;
}

/**
 * Reads stored or imported sources. A project from before doc sources has
 * none: `undefined` reads as an empty list. Anything else is checked whole.
 */
export function parseDocSources(json: unknown): { readonly ok: true; readonly value: readonly DocSource[] } | { readonly ok: false; readonly error: readonly string[] } {
  if (json === undefined) return { ok: true, value: [] };
  if (!Array.isArray(json)) return { ok: false, error: ["$: expected a list of doc sources"] };
  const problems = sourceProblems(json);
  if (problems.length > 0) return { ok: false, error: problems };
  return { ok: true, value: (json as DocSource[]).map(cleanSource) };
}

/** What the agent is told about the sources, as one string: when it changes, the agent is told again. Tokens are not part of it. */
export function docSignature(sources: readonly DocSource[]): string {
  return JSON.stringify(sources.map(cleanSource));
}
