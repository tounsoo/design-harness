import { describe, expect, it } from "vitest";
import { errorBody, scriptedFetch, streamEvents, type FakeReply } from "../../e2e/fake-anthropic.mjs";
import { fakeHost } from "../../test/agent-host";
import { seedSpec } from "../../test/nook";
import type { DocSource } from "../docs/sources";
import { AgentController, type ChatRecord, type DocContext, type Turn } from "./controller";
import { DEFAULT_SETTINGS } from "./models";
import { createClient, FALLBACK_BETA, SYSTEM_PROMPT } from "./request";
import { specCatalogPrompt } from "./spec-prompt";
import type { Prototype } from "@design-harness/core";
import type { AgentHost } from "./tools";

const KEY = "sk-ant-test-0123456789abcdefghij";
const SECOND_PRIMARY = { path: "pages/booking.json", patches: '{"op":"replace","path":"/elements/hold/props/variant","value":"primary"}' };
const BACK = { path: "pages/booking.json", patches: '{"op":"replace","path":"/elements/hold/props/variant","value":"secondary"}' };

/** A spec prototype as data: each spec file parsed, so a file written as core formats it equals the same file written by hand. */
const asData = (prototype: Prototype) => ({ ...prototype, files: Object.fromEntries(Object.entries(prototype.files).map(([path, text]) => [path, JSON.parse(text) as unknown])) });

type Body = { messages: Array<{ role: string; content: unknown }> } & Record<string, unknown>;
type Reply = FakeReply | ((body: Body) => FakeReply);

/** The text of the last message, all its text blocks joined. */
function lastText(body: Body): string {
  const content = body.messages.at(-1)?.content;
  if (typeof content === "string") return content;
  return (content as Array<{ type: string; text?: string; content?: unknown }>).map((block) => (block.type === "text" ? block.text : block.type === "tool_result" ? String(block.content) : "")).join("\n");
}

function setup(replies: readonly Reply[], options: { host?: AgentHost; maxRounds?: number; docs?: () => DocContext } = {}) {
  const fake = scriptedFetch(replies);
  const hostParts = fakeHost();
  const host = options.host ?? hostParts.host;
  const saved: ChatRecord[] = [];
  let id = 0;
  const controller = new AgentController({
    host,
    store: { load: async () => null, save: async (record) => void saved.push(JSON.parse(JSON.stringify(record)) as ChatRecord) },
    key: () => KEY,
    settings: () => DEFAULT_SETTINGS,
    client: (key) => createClient(key, { fetch: fake.fetch, maxRetries: 0 }),
    newId: () => `turn-${(id += 1)}`,
    ...(options.maxRounds !== undefined ? { maxRounds: options.maxRounds } : {}),
    ...(options.docs ? { docs: options.docs } : {}),
  });
  return { controller, fake, host, hostParts, saved, turn: (): Turn => controller.getState().turns.at(-1) as Turn };
}

const tool = (id: string, name: string, input: unknown, extra: object = {}) => ({ events: streamEvents({ id: `msg_${id}`, blocks: [{ type: "thinking", thinking: `Planning ${id}.` }, { type: "tool_use", id: `toolu_${id}`, name, input }], stopReason: "tool_use", ...extra }) });
const done = (text: string) => ({ events: streamEvents({ id: "msg_done", blocks: [{ type: "text", text }], stopReason: "end_turn" }) });

describe("an agent turn", () => {
  it("edits a file, gets the failing check without asking, fixes it, and ends; every request extends the one before", async () => {
    const { controller, fake, turn, hostParts } = setup([
      tool("edit", "patch_spec", SECOND_PRIMARY),
      (body) => {
        expect(lastText(body)).toContain("The app re-rendered every frame after your changes and ran the checks.");
        expect(lastText(body)).toContain("- one-primary-per-page (count)");
        return tool("fix", "patch_spec", BACK);
      },
      (body) => {
        expect(lastText(body)).toMatch(/Checks for revision 3, with every frame measured: incomplete\. \d+ pass, 0 fail/);
        return done("Hold room is secondary again; no rule fails.");
      },
    ]);
    await controller.send("Make Hold room stand out");
    expect(turn().end).toEqual({ status: "done" });
    expect(fake.left()).toBe(0);
    expect(controller.messages().map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    for (let index = 1; index < fake.requests.length; index += 1) {
      const before = fake.requests[index - 1]?.body.messages ?? [];
      expect(fake.requests[index]?.body.messages.slice(0, before.length)).toEqual(before);
    }
    const thinking = (controller.messages()[1]?.content as Array<{ type: string; signature?: string }>)[0];
    expect(thinking).toEqual({ type: "thinking", thinking: "Planning edit.", signature: "sig-msg_edit-0" });
    expect(turn().items.filter((item) => item.kind === "checks").map((item) => item.kind === "checks" && item.title)).toEqual(["Checks fail: 3 rules", "Checks incomplete"]);
    // The fix puts the page's data back as it was; patch_spec writes it as core formats a spec.
    expect(asData(hostParts.prototype())).toEqual(asData(seedSpec()));
    expect(turn().before).toEqual(seedSpec());
    expect(turn().usage).toMatchObject({ requests: 3, output: 720 });
    expect(turn().cost).toBeGreaterThan(0);
  });

  it("refuses a turn on a TSX prototype: nothing is sent, nothing runs, and the history stays as it is", async () => {
    const tsx = fakeHost(seedSpec(), undefined, undefined, { tsx: true });
    const { controller, fake, saved } = setup([done("Hello.")], { host: tsx.host });
    await controller.send("Rename the rooms page");
    expect(fake.requests).toEqual([]);
    expect(fake.left()).toBe(1);
    expect(controller.getState()).toMatchObject({ turns: [], running: false, problem: expect.stringMatching(/^This prototype is TSX\. TSX prototypes are no longer edited or checked here: the agent writes specs only\./) });
    expect(controller.messages()).toEqual([]);
    expect(controller.undoable()).toBeUndefined();
    expect(tsx.applied).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("sends the model, effort, adaptive thinking, auto tool choice, fallbacks, caching and the key only in its header", async () => {
    const { controller, fake, hostParts } = setup([done("Hello.")]);
    await controller.send("Hi");
    const [request] = fake.requests;
    expect(request?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request?.body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 32000,
      stream: true,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "medium" },
      tool_choice: { type: "auto" },
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        { type: "text", text: specCatalogPrompt(hostParts.config()), cache_control: { type: "ephemeral" } },
      ],
    });
    expect((request?.body.tools as Array<{ eager_input_streaming?: boolean }>).every((item) => item.eager_input_streaming === true)).toBe(true);
    expect(request?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(request?.headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(request?.headers.get("anthropic-beta")).toContain(FALLBACK_BETA);
    expect(JSON.stringify(request?.body)).not.toContain(KEY);
  });

  it("on a refusal, shows stop_details, keeps nothing of the declined reply, and runs none of its tools", async () => {
    const { controller, turn, hostParts } = setup([
      { events: streamEvents({ blocks: [{ type: "text", text: "Sure, here is" }, { type: "tool_use", id: "toolu_x", name: "edit_file", input: SECOND_PRIMARY }], stopReason: "refusal", stopDetails: { type: "refusal", category: "cyber", explanation: "This looks like exploit development." } }) },
    ]);
    await controller.send("Do something");
    expect(turn().end).toEqual({ status: "refused", category: "cyber", explanation: "This looks like exploit development." });
    expect(turn().items).toEqual([]);
    expect(controller.messages().map((message) => message.role)).toEqual(["user"]);
    expect(hostParts.applied).toEqual([]);
  });

  it("does not run a tool call cut off at max_tokens", async () => {
    const { controller, turn, hostParts } = setup([{ events: streamEvents({ blocks: [{ type: "tool_use", id: "toolu_cut", name: "write_spec", input: { path: "pages/a.json", spec: { root: "x" } } }], stopReason: "max_tokens" }) }]);
    await controller.send("Write a page");
    expect(turn().end).toEqual({ status: "cut-off" });
    expect(hostParts.applied).toEqual([]);
    expect(controller.messages()).toHaveLength(1);
  });

  it("stops after the round limit, with every call answered, and the next message carries on", async () => {
    const { controller, turn } = setup([tool("a", "read_project", {}), tool("b", "list_files", {}), done("Carrying on.")], { maxRounds: 2 });
    await controller.send("Look around");
    expect(turn().end).toEqual({ status: "limit", rounds: 2 });
    expect(controller.messages().map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    await controller.send("Go on");
    expect(turn().end).toEqual({ status: "done" });
    expect(controller.messages().map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user", "user", "assistant"]);
  });

  it("stops mid-stream: the partial reply is shown, not kept, and the next request starts clean", async () => {
    const events = streamEvents({ blocks: [{ type: "text", text: "I will now rewrite every page of the prototype" }], stopReason: "end_turn" });
    const { controller, turn } = setup([{ events, holdAfter: 4 }, done("Fine.")]);
    const sent = controller.send("Rewrite everything");
    await new Promise((resolve) => {
      const unsubscribe = controller.subscribe(() => {
        const item = turn()?.items[0];
        if (item?.kind === "text" && item.text.length > 0) {
          unsubscribe();
          resolve(undefined);
        }
      });
    });
    controller.stop();
    await sent;
    expect(turn().end).toEqual({ status: "stopped" });
    expect(turn().items.at(-1)).toMatchObject({ kind: "notice" });
    expect(controller.messages().map((message) => message.role)).toEqual(["user"]);
    await controller.send("Never mind");
    expect(turn().end).toEqual({ status: "done" });
  });

  it("stops while waiting for the checks, and still answers the call so the history stays valid", async () => {
    const parts = fakeHost();
    let waiting: () => void = () => undefined;
    const host: AgentHost = {
      ...parts.host,
      measured: (signal) =>
        new Promise((_resolve, reject) => {
          waiting();
          signal.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")));
        }),
    };
    const { controller, turn } = setup([tool("checks", "run_checks", {})], { host });
    const started = new Promise<void>((resolve) => (waiting = resolve));
    const sent = controller.send("Check it");
    await started;
    controller.stop();
    await sent;
    expect(turn().end).toEqual({ status: "stopped" });
    const results = controller.messages()[2]?.content as Array<{ type: string; is_error?: boolean; content: string }>;
    expect(results).toEqual([{ type: "tool_result", tool_use_id: "toolu_checks", content: "Stopped by the person before it finished.", is_error: true }]);
  });

  it("shows an auth error plainly, without the key, and offers no retry", async () => {
    const { controller, turn } = setup([{ status: 401, body: errorBody("authentication_error", `invalid x-api-key ${KEY}`) }]);
    await controller.send("Hi");
    const end = turn().end;
    expect(end).toMatchObject({ status: "error", title: "The API key was refused", retry: false });
    expect(JSON.stringify(end)).not.toContain(KEY);
    expect(JSON.stringify(end)).toContain("[your API key]");
  });

  it("offers a retry when Anthropic is overloaded, and the retry continues the same turn", async () => {
    const { controller, turn } = setup([{ status: 529, body: errorBody("overloaded_error", "Overloaded") }, done("Back.")]);
    await controller.send("Hi");
    expect(turn().end).toMatchObject({ status: "error", title: "Anthropic is overloaded", retry: true });
    await controller.retry();
    expect(turn().end).toEqual({ status: "done" });
    expect(controller.getState().turns).toHaveLength(1);
  });

  it("re-requests a turn whose tool input cannot be parsed at all, then runs the good one", async () => {
    const broken = streamEvents({ blocks: [{ type: "tool_use", id: "toolu_bad", name: "read_project", input: {} }], stopReason: "tool_use" }).map((event) =>
      (event.data as { delta?: { type?: string } }).delta?.type === "input_json_delta" ? { ...event, data: { ...(event.data as object), delta: { type: "input_json_delta", partial_json: '{"a": tru' } } } : event,
    );
    const { controller, turn, fake } = setup([{ events: broken }, tool("good", "read_project", {}), done("Read it.")]);
    await controller.send("Read the project");
    expect(turn().end).toEqual({ status: "done" });
    expect(fake.requests).toHaveLength(3);
  });

  it("undoes a turn's changes as one step, and tells the agent in the next message", async () => {
    const { controller, turn, hostParts, fake } = setup([tool("edit", "patch_spec", SECOND_PRIMARY), done("Done."), done("Understood.")]);
    await controller.send("Make Hold room primary");
    expect(hostParts.prototype()).not.toEqual(seedSpec());
    expect(controller.undoable()?.id).toBe("turn-1");
    await controller.undo("turn-1");
    expect(hostParts.prototype()).toEqual(seedSpec());
    expect(turn().undone).toBe(true);
    expect(controller.undoable()).toBeUndefined();
    await controller.send("Thanks");
    expect(lastText(fake.requests.at(-1)?.body as Body)).toMatch(/^The person undid your changes from their message "Make Hold room primary"/);
  });

  it("tells the agent of a pick the person applied, in the next message, before the person's text", async () => {
    const { controller, fake } = setup([done("Noted.")]);
    await controller.note('The person applied a pick to page "booking": body from Variant A.');
    await controller.send("What changed?");
    expect(lastText(fake.requests.at(-1)?.body as Body)).toMatch(/^The person applied a pick to page "booking": body from Variant A\.[\s\S]*What changed\?$/);
  });

  it("answers tool calls a closed page left unanswered when it opens the chat again, and waits for the chat before sending", async () => {
    const history = [
      { role: "user", content: [{ type: "text", text: "Read it" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_left", name: "read_project", input: {} }] },
    ] as ChatRecord["history"];
    const fake = scriptedFetch([done("Back again.")]);
    const reopened = new AgentController({
      host: fakeHost().host,
      store: { load: async () => ({ version: 1, history, turns: [], pending: [] }), save: async () => undefined },
      key: () => KEY,
      settings: () => DEFAULT_SETTINGS,
      client: (key) => createClient(key, { fetch: fake.fetch, maxRetries: 0 }),
    });
    void reopened.load();
    await reopened.send("Go on");
    expect(fake.requests[0]?.body.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "user"]);
    expect((fake.requests[0]?.body.messages[2]?.content as Array<{ content: string }>)[0]?.content).toBe("Not run: the page closed before this ran.");
  });

  it("saves the conversation per prototype without the key, and opens it again", async () => {
    const { controller, saved } = setup([tool("edit", "patch_spec", SECOND_PRIMARY), done("Done.")]);
    await controller.send("Make Hold room primary");
    const last = saved.at(-1) as ChatRecord;
    expect(JSON.stringify(saved)).not.toContain(KEY);
    expect(last.history.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const reopened = new AgentController({ host: fakeHost().host, store: { load: async () => last, save: async () => undefined }, key: () => KEY, settings: () => DEFAULT_SETTINGS });
    await reopened.load();
    expect(reopened.messages()).toEqual(controller.messages());
    expect(reopened.getState().turns.map((item) => item.end.status)).toEqual(["done"]);
  });

  it("keeps what the loop reads: the rules each check failed, those failing at the turn's start, and the person's log, saved and opened again", async () => {
    const parts = fakeHost();
    const host: AgentHost = { ...parts.host, checked: () => ({ status: "fail", findings: [], rules: [{ rule: "visible-questions", type: "count", status: "fail", findings: [] }] }) };
    const { controller, saved, turn } = setup([tool("edit", "patch_spec", SECOND_PRIMARY), tool("fix", "patch_spec", BACK), done("Fixed.")], { host });
    await controller.record({ kind: "fix-asked", at: "2026-11-19T09:00:00Z", rule: "one-primary-per-page" });
    await controller.send("Make Hold room primary");
    expect(turn().failingAtStart).toEqual(["visible-questions"]);
    const checks = turn().items.flatMap((item) => (item.kind === "checks" ? [item.failing] : []));
    expect(checks[0]).toContain("one-primary-per-page");
    expect(checks[1]).not.toContain("one-primary-per-page");
    const last = saved.at(-1) as ChatRecord;
    expect(last.log).toEqual([{ kind: "fix-asked", at: "2026-11-19T09:00:00Z", rule: "one-primary-per-page" }]);
    const reopened = new AgentController({ host: fakeHost().host, store: { load: async () => last, save: async () => undefined }, key: () => KEY, settings: () => DEFAULT_SETTINGS });
    await reopened.load();
    expect(reopened.getState().log).toEqual(last.log);
  });
});

describe("a turn that reads the project's docs", () => {
  const SITE: DocSource = { kind: "website", url: "https://todae.design/docs", label: "Todae docs" };
  const SERVER: DocSource = { kind: "mcp", url: "https://mcp.example.com/mcp", name: "design-docs" };
  const TOKEN = "mcp-secret-token-0123456789";
  const docsOf = (sources: { current: readonly DocSource[] }): (() => DocContext) => () => ({ sources: sources.current, token: (name) => (name === "design-docs" ? TOKEN : null), tokens: () => [TOKEN] });
  const reading = {
    events: streamEvents({
      id: "msg_read",
      blocks: [
        { type: "thinking", thinking: "Checking Button's documented usage." },
        { type: "web_fetch", id: "srvtoolu_page", url: "https://todae.design/docs/button" },
        { type: "web_fetch_result", id: "srvtoolu_page", url: "https://todae.design/docs/button", title: "Button", text: "Use one primary Button per view." },
        { type: "mcp_tool_use", id: "mcptoolu_search", name: "search_docs", server: "design-docs", input: { query: "secondary button" } },
        { type: "mcp_tool_result", id: "mcptoolu_search", text: "Secondary buttons sit beside the primary one." },
        { type: "tool_use", id: "toolu_edit", name: "patch_spec", input: SECOND_PRIMARY },
      ],
      stopReason: "tool_use",
    }),
  };

  it("names the sources in the first message, sends web fetch and the docs server, shows each read, and replays the server tool blocks as they came", async () => {
    const sources = { current: [SITE, SERVER] as readonly DocSource[] };
    const { controller, fake, turn, saved } = setup([reading, done("Per the docs, Hold room stays secondary.")], { docs: docsOf(sources) });
    await controller.send("Make Hold room stand out");
    expect(turn().end).toEqual({ status: "done" });
    const [first, second] = fake.requests;
    expect(first?.headers.get("anthropic-beta")).toBe(`${FALLBACK_BETA},mcp-client-2025-11-20`);
    expect(first?.body.mcp_servers).toEqual([{ type: "url", url: "https://mcp.example.com/mcp", name: "design-docs", authorization_token: TOKEN }]);
    expect((first?.body.tools as Array<{ type?: string }>).slice(-2).map((item) => item.type)).toEqual(["web_fetch_20260209", "mcp_toolset"]);
    expect((first?.body.messages[0]?.content as Array<{ text: string }>)[0]?.text).toMatch(/^This project's documentation sources, from the person:\n- Website, Todae docs: https:\/\/todae\.design\/docs\n/);
    expect(turn().items[0]).toEqual({ kind: "notice", text: "Sent with the project's docs: Todae docs, design-docs.", about: "docs" });
    const read = turn().items.filter((item) => item.kind === "source");
    expect(read).toEqual([
      { kind: "source", id: "srvtoolu_page", via: "web", name: "web_fetch", status: "done", input: '{"url":"https://todae.design/docs/button"}', url: "https://todae.design/docs/button", pageTitle: "Button", result: "Use one primary Button per view." },
      { kind: "source", id: "mcptoolu_search", via: "mcp", name: "search_docs", server: "design-docs", status: "done", input: '{"query":"secondary button"}', result: "Secondary buttons sit beside the primary one." },
    ]);
    // The assistant turn goes back whole: thinking, the fetch and its result, the MCP call and its result, and the app's own tool call, which alone gets a tool result.
    const assistant = second?.body.messages[1]?.content as Array<{ type: string }>;
    expect(assistant.map((block) => block.type)).toEqual(["thinking", "server_tool_use", "web_fetch_tool_result", "mcp_tool_use", "mcp_tool_result", "tool_use"]);
    expect((second?.body.messages[2]?.content as Array<{ type: string; tool_use_id?: string }>)[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_edit" });
    expect(second?.body.messages.slice(0, first?.body.messages.length)).toEqual(first?.body.messages);
    expect(second?.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    // Undo still takes the turn back, whatever the agent read during it.
    expect(controller.undoable()?.id).toBe(turn().id);
    await controller.undo(turn().id);
    expect(turn().undone).toBe(true);
  });

  it("tells the agent when the sources change, and from then on asks the API to drop the thinking from before", async () => {
    const sources = { current: [] as readonly DocSource[] };
    const { controller, fake, saved } = setup([done("Hello."), done("Read it."), done("Thanks.")], { docs: docsOf(sources) });
    await controller.send("Hi");
    expect(fake.requests[0]?.body.system).toHaveLength(2);
    expect(fake.requests[0]?.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    sources.current = [SITE];
    await controller.send("Look at the docs");
    const changed = fake.requests[1];
    expect(lastText(changed?.body as Body)).toContain("- Website, Todae docs: https://todae.design/docs");
    expect(changed?.body.thinking).toEqual({ type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(changed?.headers.get("anthropic-beta")).toBe(`${FALLBACK_BETA},thinking-binding-controls-2026-08-01`);
    expect(saved.at(-1)).toMatchObject({ docs: JSON.stringify([SITE]), rebound: true });
    await controller.send("Thanks");
    expect(lastText(fake.requests[2]?.body as Body)).toBe("Thanks");
    expect(fake.requests[2]?.body.thinking).toMatchObject({ block_binding: { prefix_mismatch_behavior: "drop_block" } });
  });

  it("opens a saved conversation with the sources it was told about, and tells nothing again", async () => {
    const sources = { current: [SITE] as readonly DocSource[] };
    const first = setup([done("Hello.")], { docs: docsOf(sources) });
    await first.controller.send("Hi");
    const record = first.saved.at(-1) as ChatRecord;
    expect(record.docs).toBe(JSON.stringify([SITE]));
    expect(record.rebound).toBeUndefined();
    const fake = scriptedFetch([done("Again.")]);
    const reopened = new AgentController({ host: fakeHost().host, store: { load: async () => record, save: async () => undefined }, key: () => KEY, settings: () => DEFAULT_SETTINGS, client: (key) => createClient(key, { fetch: fake.fetch, maxRetries: 0 }), docs: docsOf(sources) });
    await reopened.load();
    await reopened.send("Hi again");
    expect(lastText(fake.requests[0]?.body as Body)).toBe("Hi again");
    expect(fake.requests[0]?.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("says a page it could not read in plain words, and a refused request names the docs server without its token", async () => {
    const failing = {
      events: streamEvents({
        id: "msg_fail",
        blocks: [
          { type: "web_fetch", id: "srvtoolu_x", url: "https://elsewhere.example.com/" },
          { type: "web_fetch_result", id: "srvtoolu_x", url: "https://elsewhere.example.com/", error: "url_not_allowed" },
          { type: "text", text: "That page is outside the project's docs." },
        ],
        stopReason: "end_turn",
      }),
    };
    const sources = { current: [SITE, SERVER] as readonly DocSource[] };
    const { controller, turn } = setup([failing, { status: 400, body: errorBody("invalid_request_error", `MCP server design-docs rejected authorization_token ${TOKEN}`) }], { docs: docsOf(sources) });
    await controller.send("Read elsewhere");
    expect(turn().items.find((item) => item.kind === "source")).toMatchObject({ status: "error", problem: "That address is not on one of the project's docs sites, or the site does not allow it to be read." });
    await controller.send("Ask the docs server");
    const end = turn().end;
    expect(end.status).toBe("error");
    if (end.status !== "error") return;
    expect(end.detail).not.toContain(TOKEN);
    expect(end.detail).toContain("[a docs server token]");
    expect(end.detail).toContain("This request used the docs server design-docs.");
    expect(end.detail).toContain("check the address and the token under Docs in the Project view");
  });
});
