import { BaseAnthropic } from "@anthropic-ai/sdk/client";
import { Messages, type BetaMessageParam, type MessageCreateParamsBase } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AgentSettings } from "./models";
import { TOOL_DEFINITIONS } from "./tools";

/**
 * The client and every request the chat sends. The system prompt and the
 * tools are fixed text, the same in every request of every conversation, so
 * they form a stable cached prefix and never invalidate replayed thinking.
 * The project itself reaches the agent through read_project.
 */

export const SYSTEM_PROMPT = `You build and change a UI prototype in design-harness, for the person in this chat.

The prototype is React in TSX, rendered with the project's component library, one frame per scenario and view. A deterministic checker, design-harness core, decides whether it is valid. You do not decide that, and neither does the person: the checks do.

How this project works:
- Build only from the project's inventories: the library components, layouts, page types and flow states read_project lists. Pages import Slot and PageProps from "@design-harness/page", fill their page type's slots, and get { scenario, state } as props.
- The checks decide validity. After every round in which you change files, the app re-renders every frame, runs the checks and sends you core's report. Fix what it reports and keep going until every rule passes, or until you need the person. A rule that says it cannot tell is failing too: rewrite the code so the checker can read it.
- Prototype code uses only its imports, React and plain language built-ins. No browser globals or timers, no refs, no event.target, no property read by a computed key, no assigning to object properties.
- When the request needs something outside the inventories, or something a rule forbids, do not work around the check. Draft a proposal with draft_proposal: the inventory change, the rule that governs it, and examples that pass and fail. Only the person can approve or adopt it.

Read the project and the files you need before you write. Make small changes. When you finish, say in a few sentences what you changed and what the checks say.`;

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

/** One streamed request: everything but `messages` is the same for every turn of a conversation at the same settings. */
export function requestBody(settings: AgentSettings, messages: readonly BetaMessageParam[]): RequestBody {
  return {
    model: settings.model,
    max_tokens: MAX_TOKENS,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: [...TOOL_DEFINITIONS],
    // Forced tool choice is refused by these models; the prompt steers instead.
    tool_choice: { type: "auto" },
    // Adaptive thinking is these models' default; summaries make the agent's reasoning and progress readable in the chat.
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: settings.effort },
    // Caches the conversation up to its newest block, on top of the system prompt's breakpoint.
    cache_control: { type: "ephemeral" },
    fallbacks: "default",
    betas: [FALLBACK_BETA],
    messages: [...messages],
  };
}
