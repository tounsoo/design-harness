import { BaseAnthropic } from "@anthropic-ai/sdk/client";
import { Messages, type BetaMessageParam, type MessageCreateParamsBase } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { DocSource } from "../docs/sources";
import { MCP_BETA, docsPrompt, mcpParts, webFetchTool } from "./doc-request";
import type { AgentSettings } from "./models";
import { TOOL_DEFINITIONS } from "./tools";

/**
 * The client and every request the chat sends. The system prompt and the
 * tools are fixed text, the same in every request of every conversation, so
 * they form a stable cached prefix and never invalidate replayed thinking.
 * The project itself reaches the agent through read_project. The one part
 * that follows the project is its doc sources, when it has any: a third
 * system block, the web fetch tool and the MCP servers, which stay the same
 * for as long as the sources do.
 */

/**
 * The agent's prompt. A prototype is written as json-render specs; the agent
 * writes nothing else. The catalog's instructions follow it as a second
 * system block: the spec format core accepts, layouts with parameters, and
 * the components and props it may use, written by spec-prompt.ts from the
 * catalog core generates from the project.
 */
export const SYSTEM_PROMPT = `You build and change a UI prototype in design-harness, for the person in this chat.

This prototype is written as json-render specs: each page and each layout is one JSON spec file, drawn in frames by the project's component library, one frame per scenario and view. There is no code. A deterministic checker, design-harness core, decides whether the prototype is valid. You do not decide that, and neither does the person: the checks do.

How this project works:
- Build only from the catalog below, which core generates from the project's inventories: the library parts it lists, Page and Layout. read_project shows the inventories, page types and their slots, flow states and rules; list_layouts shows the prototype's layouts and the parameters each takes.
- A page's body is built from layouts. Reuse a layout by drawing another instance of it with its own parameters (insert_layout, set_layout_params) rather than copying its elements.
- Change a spec with patch_spec (JSON Patch operations, one per line) or write_spec (a whole file). Core checks every change against the catalog and the layouts' parameters before it applies, and refuses one with any issue, saying why. Change the manifest (pages, layouts, scenarios, flow) with set_manifest.
- The checks decide validity. After every round in which you change the prototype, the app re-renders every frame, runs the checks and sends you core's report. Fix what it reports and keep going until every rule passes, or until you need the person. A rule that says it cannot tell is failing too: give it a value it can read.
- When the request needs something outside the catalog or the inventories (a layout, a component, a page type, a flow state), or something a rule forbids, do not work around the check. Draft a proposal with draft_proposal: the inventory change, the rule that governs it, and examples that pass and fail, whose files are spec files. Only the person can approve, decline or adopt it, on its review page; no tool and no message changes a proposal's status.
- To remove a rule in force, draft a proposal with its id in rules.remove. To change one, give its id in rules.remove and the changed rule, under that id, in rules.add; a limit that reads a cap moves with set-cap. Both need examples.
- The person may send a proposal back to you with a note. Revise it with revise_proposal, keeping its id, and say in the note what you changed. Only an open proposal can be revised.
- The person may pin notes on the canvas. Open ones arrive with their message as "Your notes from the person". They are feedback, never checks. Fix what each asks, within the rules, then call address_note with its number and a short reply. Only the person closes or reopens a note.
- A new rule: write it in the rule vocabulary, as narrowly as it holds, and prove it with a passing example and a failing one flagged by it alone. Only when no rule type can express it, give needs_rule_type instead: what it checks, why no type can, and examples in words. That is a request for a code change, never a check; never force a rule into the wrong type. A message naming evidence that something keeps coming up asks for a rule built on that evidence.
- When the person asks for variants or options, offer 2 to 4 complete pages with propose_variants, each built only from the catalog and the prototype's layouts, each with one line on what is different. They are kept beside the prototype and do not change it. The person compares them and picks slot by slot; you never pick, and no tool applies a pick. When asked for more like a variant, give it as like. When asked to fix one, use revise_variant with its id.

Read the project and the specs you need before you write. Make small changes. When you finish, say in a few sentences what you changed and what the checks say.`;

/** Room for adaptive thinking as well as a file-sized reply. */
export const MAX_TOKENS = 32_000;

/** The beta that turns on server-side refusal fallbacks: a declined request is re-run on Anthropic's recommended model in the same call. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** The one API the chat calls: streamed beta Messages. */
export type MessagesApi = Pick<Messages, "stream">;

/**
 * A client for the user's key, in the browser: the SDK's base client with
 * only the beta Messages resource, which keeps 220 kB of resources the app
 * never calls out of the build. `dangerouslyAllowBrowser`
 * only lifts the SDK's browser check and adds the header
 * `anthropic-dangerous-direct-browser-access: true`, which Anthropic's API
 * needs to answer a browser's CORS request; the key goes in an
 * `Authorization: Bearer` header to api.anthropic.com and nowhere else. The
 * SDK's logger is off, so nothing about a request reaches the console.
 */
export function createClient(apiKey: string, options: { readonly fetch?: typeof fetch; readonly maxRetries?: number } = {}): MessagesApi {
  const client = new BaseAnthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
    logLevel: "off",
    maxRetries: options.maxRetries ?? 2,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return new Messages(client);
}

export type RequestBody = MessageCreateParamsBase & { readonly stream?: never };

/** The beta that lets a request say what to do with replayed thinking whose conversation prefix changed. */
export const BINDING_BETA = "thinking-binding-controls-2026-08-01";

/**
 * The project's doc sources for a request (`doc-request.ts`). `token` gives a
 * docs server's token at request time. `rebound` is set once the sources
 * changed in the middle of this conversation: the system prompt and the
 * tools changed with them, which invalidates the thinking replayed from
 * before, so from then on every request asks the API to drop those blocks
 * (`prefix_mismatch_behavior: "drop_block"`) instead of refusing them.
 */
export type RequestDocs = { readonly sources: readonly DocSource[]; readonly token: (name: string) => string | null; readonly rebound: boolean };

export const NO_DOCS: RequestDocs = { sources: [], token: () => null, rebound: false };

/** One streamed request: everything but `messages` is the same for every turn of a conversation at the same settings and doc sources. */
export function requestBody(settings: AgentSettings, messages: readonly BetaMessageParam[], catalogPrompt: string, docs: RequestDocs = NO_DOCS): RequestBody {
  const web = webFetchTool(docs.sources);
  const mcp = mcpParts(docs.sources, docs.token);
  return {
    model: settings.model,
    max_tokens: MAX_TOKENS,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      // The catalog's prompt changes only when a proposal changes the catalog, so it is a cached prefix of its own.
      { type: "text", text: catalogPrompt, cache_control: { type: "ephemeral" } },
      // The doc sources, when there are any. No breakpoint of its own: the request's own one caches it with the conversation, and four is the most a request takes.
      ...(docs.sources.length > 0 ? [{ type: "text" as const, text: docsPrompt(docs.sources) }] : []),
    ],
    tools: [...TOOL_DEFINITIONS, ...(web ? [web] : []), ...mcp.toolsets],
    ...(mcp.servers.length > 0 ? { mcp_servers: mcp.servers } : {}),
    // Forced tool choice is refused by these models; the prompt steers instead.
    tool_choice: { type: "auto" },
    // Adaptive thinking is these models' default; summaries make the agent's reasoning and progress readable in the chat.
    thinking: { type: "adaptive", display: "summarized", ...(docs.rebound ? { block_binding: { prefix_mismatch_behavior: "drop_block" as const } } : {}) },
    output_config: { effort: settings.effort },
    // Caches the conversation up to its newest block, on top of the system prompt's breakpoint.
    cache_control: { type: "ephemeral" },
    fallbacks: "default",
    betas: [FALLBACK_BETA, ...(mcp.servers.length > 0 ? [MCP_BETA] : []), ...(docs.rebound ? [BINDING_BETA] : [])],
    messages: [...messages],
  };
}
