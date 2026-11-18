import { checkPrototype, specCatalog } from "@design-harness/core";
import { describe, expect, it } from "vitest";
import { nook } from "../../../../packages/core/examples/nook/project";
import { scriptedFetch, streamEvents } from "../../e2e/fake-anthropic.mjs";
import { fakeHost } from "../../test/agent-host";
import { seedSpec } from "../../test/nook";
import { AgentController, type Turn } from "./controller";
import { catalogPrompt, jsonRenderCatalog, SPEC_RULES } from "./json-render-catalog";
import { DEFAULT_SETTINGS } from "./models";
import { createClient, SPEC_SYSTEM_PROMPT } from "./request";
import { formatSpec } from "./spec-tools";
import { runTool, SPEC_TOOL_DEFINITIONS } from "./tools";

const KEY = "sk-ant-test-0123456789abcdefghij";
const signal = new AbortController().signal;
const call = (name: string, input: unknown) => ({ id: "toolu_1", name, input });

describe("the catalog's prompt", () => {
  const catalog = specCatalog(nook);
  if (!catalog) throw new Error("Nook has a catalog");

  it("is json-render's catalog.prompt() for core's catalog, listing exactly its components with their props", () => {
    const prompt = catalogPrompt(catalog);
    expect(prompt).toContain(`AVAILABLE COMPONENTS (${Object.keys(catalog.components).length}):`);
    expect(prompt).toContain('- Button.Root: { aria-label?: string, defaultPressed?: boolean, id?: string, pressed?: boolean, text?: string, tooltip?: boolean, variant?: "ghost" | "primary" | "secondary" }');
    expect(prompt).toContain("- Page: {  } - The root of a page spec, and only that.");
    expect(prompt).not.toContain("Badge.Root");
    for (const rule of SPEC_RULES) expect(prompt).toContain(rule);
    // What json-render's default prompt also teaches, which core refuses here; the custom rules say so.
    expect(prompt).toContain("STATE WATCHERS");
    expect(prompt).toContain("validateForm");
    expect(catalogPrompt(catalog)).toBe(prompt);
  });

  it("makes a json-render catalog whose own validate checks the type but not the props", () => {
    const made = jsonRenderCatalog(catalog);
    expect(made.componentNames).toEqual(Object.keys(catalog.components));
    expect(made.validate({ root: "a", elements: { a: { type: "Badge.Root", props: {}, children: [] } } }).success).toBe(false);
    // With more than one component json-render validates props as a record of unknowns: core is the judge.
    expect(made.validate({ root: "a", elements: { a: { type: "Button.Root", props: { variant: "danger", style: { color: "red" } }, children: [] } } }).success).toBe(true);
  });
});

describe("the spec tools", () => {
  it("are the spec mode's tools, with write_spec and patch_spec in place of the file tools", () => {
    expect(SPEC_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(["read_project", "list_files", "read_file", "write_spec", "patch_spec", "delete_file", "set_manifest", "run_checks", "draft_proposal", "revise_proposal"]);
  });

  it("patch_spec applies JSON Patch lines through json-render, checks the result against the catalog, and makes a revision", async () => {
    const parts = fakeHost(seedSpec());
    const outcome = await runTool(call("patch_spec", { path: "pages/booking.json", patches: '{"op":"replace","path":"/elements/book/props/text","value":"Book now"}\n{"op":"add","path":"/elements/page/slots/facts/-","value":"note"}\n{"op":"add","path":"/elements/note","value":{"type":"Text.Root","props":{"as":"p","text":"Free until 3 pm"},"children":[]}}' }), parts.host, signal);
    expect(outcome).toMatchObject({ isError: false, changed: true, title: "Patched pages/booking.json" });
    const text = parts.prototype().files["pages/booking.json"] ?? "";
    expect(text).toContain('"book": {"type":"Button.Root","props":{"variant":"primary","text":"Book now"},"children":[]}');
    expect(text).toContain('"note": {"type":"Text.Root","props":{"as":"p","text":"Free until 3 pm"},"children":[]}');
    const report = checkPrototype({ config: nook, prototype: parts.prototype() });
    expect(report.rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule)).toEqual(["primary-is-rank-1", "rank-1-shown"]);
  });

  it("refuses a patch whose result the catalog does not allow, and applies nothing", async () => {
    const parts = fakeHost(seedSpec());
    const outcome = await runTool(call("patch_spec", { path: "pages/rooms.json", patches: '{"op":"add","path":"/elements/page/slots/intro/-","value":"free"}\n{"op":"add","path":"/elements/free","value":{"type":"Badge.Root","props":{"text":"Free"},"children":[]}}\n{"op":"add","path":"/elements/heading/props/style","value":{"color":"red"}}' }), parts.host, signal);
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain('element "free" is a Badge.Root, which is not in the catalog');
    expect(outcome.content).toContain('element "heading" sets "style", which a Text.Root does not take');
    expect(parts.applied).toEqual([]);
  });

  it("refuses an operation json-render would apply silently or differently: a replace or remove of nothing, a line that is not a patch", async () => {
    const parts = fakeHost(seedSpec());
    const replace = await runTool(call("patch_spec", { path: "pages/booking.json", patches: '{"op":"replace","path":"/elements/bok/props/text","value":"x"}' }), parts.host, signal);
    expect(replace.content).toBe('Line 1 cannot apply: replace needs "/elements/bok/props/text" to exist, and it does not. Nothing was applied.');
    const remove = await runTool(call("patch_spec", { path: "pages/booking.json", patches: '{"op":"replace","path":"/root","value":"page"}\n{"op":"remove","path":"/elements/nothing"}' }), parts.host, signal);
    expect(remove.content).toBe('Line 2 cannot apply: remove needs "/elements/nothing" to exist, and it does not. Nothing was applied.');
    const garbage = await runTool(call("patch_spec", { path: "pages/booking.json", patches: "make the button bigger" }), parts.host, signal);
    expect(garbage.content).toMatch(/^Line 1 is not a JSON Patch operation/);
    expect(parts.applied).toEqual([]);
  });

  it("write_spec writes a whole spec, one element per line, after the same check", async () => {
    const parts = fakeHost(seedSpec());
    const spec = { root: "list", elements: { list: { type: "Stack.Root", props: { gap: "normal" }, children: ["hint"] }, hint: { type: "Text.Root", props: { as: "p", text: "Pick one" }, children: [] } } };
    const outcome = await runTool(call("write_spec", { path: "layouts/hint.json", spec }), parts.host, signal);
    expect(outcome).toMatchObject({ isError: false, changed: true, title: "Created layouts/hint.json" });
    expect(parts.prototype().files["layouts/hint.json"]).toBe(formatSpec(spec));
    expect(formatSpec(spec).split("\n")).toEqual(["{", '  "root": "list",', '  "elements": {', '    "list": {"type":"Stack.Root","props":{"gap":"normal"},"children":["hint"]},', '    "hint": {"type":"Text.Root","props":{"as":"p","text":"Pick one"},"children":[]}', "  }", "}", ""]);
    const bad = await runTool(call("write_spec", { path: "layouts/bad.json", spec: { root: "x", elements: { x: { type: "button", props: {}, children: [] } } } }), parts.host, signal);
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('element "x" is a button, which is not in the catalog');
  });

  it("are the only edit tools a spec prototype's agent has: write_file is refused", async () => {
    const parts = fakeHost(seedSpec());
    const outcome = await runTool(call("write_file", { path: "pages/x.tsx", content: "export default () => null" }), parts.host, signal);
    expect(outcome.content).toMatch(/^There is no tool "write_file" for this prototype\./);
  });
});

describe("a spec prototype's agent turn, against the fake API", () => {
  it("asks with the spec prompt, the catalog's prompt and the spec tools, and its patch reaches the checks", async () => {
    const parts = fakeHost(seedSpec());
    const fake = scriptedFetch([
      { events: streamEvents({ id: "msg_1", blocks: [{ type: "tool_use", id: "toolu_1", name: "patch_spec", input: { path: "pages/booking.json", patches: '{"op":"replace","path":"/elements/hold/props/variant","value":"primary"}' } }], stopReason: "tool_use" }) },
      (body: { messages: { content: unknown }[] }) => {
        const last = JSON.stringify(body.messages.at(-1)?.content);
        expect(last).toContain("- one-primary-per-page (count)");
        return { events: streamEvents({ id: "msg_2", blocks: [{ type: "tool_use", id: "toolu_2", name: "patch_spec", input: { path: "pages/booking.json", patches: '{"op":"replace","path":"/elements/hold/props/variant","value":"secondary"}' } }], stopReason: "tool_use" }) };
      },
      { events: streamEvents({ id: "msg_3", blocks: [{ type: "text", text: "Hold room stays secondary." }], stopReason: "end_turn" }) },
    ]);
    let id = 0;
    const controller = new AgentController({ host: parts.host, store: { load: async () => null, save: async () => undefined }, key: () => KEY, settings: () => DEFAULT_SETTINGS, client: (key) => createClient(key, { fetch: fake.fetch, maxRetries: 0 }), newId: () => `turn-${(id += 1)}` });
    await controller.send("Make Hold room primary");
    const turn = controller.getState().turns.at(-1) as Turn;
    expect(turn.end).toEqual({ status: "done" });
    const [first] = fake.requests;
    const system = first?.body.system as { text: string; cache_control?: unknown }[];
    expect(system.map((block) => block.text.slice(0, 40))).toEqual([SPEC_SYSTEM_PROMPT.slice(0, 40), catalogPrompt(specCatalog(nook) as NonNullable<ReturnType<typeof specCatalog>>).slice(0, 40)]);
    expect(system.every((block) => block.cache_control !== undefined)).toBe(true);
    expect((first?.body.tools as { name: string }[]).map((tool) => tool.name)).toContain("patch_spec");
    expect((first?.body.tools as { name: string }[]).map((tool) => tool.name)).not.toContain("write_file");
    expect(turn.items.filter((item) => item.kind === "checks").map((item) => item.kind === "checks" && item.status)).toEqual(["fail", "incomplete"]);
    // The same spec as before the turn, rewritten one element per line.
    expect(JSON.parse(parts.prototype().files["pages/booking.json"] ?? "")).toEqual(JSON.parse(seedSpec().files["pages/booking.json"] ?? ""));
  });
});
