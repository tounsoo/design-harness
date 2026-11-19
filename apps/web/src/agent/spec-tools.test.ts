import { checkPrototype, specCatalog } from "@design-harness/core";
import { describe, expect, it } from "vitest";
import { nook } from "../../../../packages/core/examples/nook/project";
import { scriptedFetch, streamEvents } from "../../e2e/fake-anthropic.mjs";
import { fakeHost } from "../../test/agent-host";
import { seedSpec } from "../../test/nook";
import { AgentController, type Turn } from "./controller";
import { DEFAULT_SETTINGS } from "./models";
import { createClient, SPEC_SYSTEM_PROMPT } from "./request";
import { catalogInstructions, specCatalogPrompt } from "./spec-prompt";
import { formatSpec } from "./spec-tools";
import { runTool, SPEC_TOOL_DEFINITIONS } from "./tools";

const KEY = "sk-ant-test-0123456789abcdefghij";
const signal = new AbortController().signal;
const call = (name: string, input: unknown) => ({ id: "toolu_1", name, input });

describe("the catalog's instructions", () => {
  const catalog = specCatalog(nook);
  if (!catalog) throw new Error("Nook has a catalog");
  const prompt = specCatalogPrompt(nook);

  it("are written here from core's catalog: every part with its props, and only what core accepts", () => {
    expect(prompt).toBe(catalogInstructions(catalog));
    const parts = Object.entries(catalog.components).filter(([, component]) => component.kind === "part");
    expect(prompt).toContain(`COMPONENTS (${parts.length})`);
    for (const [name] of parts) expect(prompt).toContain(`\n- ${name} {`);
    expect(prompt).toContain('- Button.Root { aria-label?: string, defaultPressed?: boolean, id?: string, pressed?: boolean (bindable), text?: string, tooltip?: boolean, variant?: "ghost" | "primary" | "secondary" } children; on: press. It is an action. With variant "primary" (or no variant), it is a primary action.');
    expect(prompt).toContain('- Field.Select { aria-label?: string, options: [{ "value", "label" }], value: string (bindable) }');
    expect(prompt).not.toContain("Badge.Root");
    // Layouts with parameters, which json-render's prompt could not teach.
    expect(prompt).toContain('"params": { "label": { "type": "text"');
    expect(prompt).toContain('{ "$scopedId": "field" }');
    expect(prompt).toContain('{ "op": "add-layout", "id": "<id>" }');
    // What json-render's prompt taught that core refuses is named only as refused.
    expect(prompt).toContain("Never write $computed, $bindItem, watch, validateForm, another action, style or className");
    expect(prompt).not.toMatch(/STATE WATCHERS|JSONL|realistic sample data/);
  });

  it("are shorter than json-render's 25,576 characters for Nook, and the same bytes every time", () => {
    expect(prompt.length).toBeLessThan(10_000);
    expect(SPEC_SYSTEM_PROMPT.length + prompt.length).toBeLessThan(13_500);
    expect(specCatalogPrompt(nook)).toBe(prompt);
  });
});

describe("the spec tools", () => {
  it("are the spec mode's tools, with write_spec and patch_spec in place of the file tools", () => {
    expect(SPEC_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(["read_project", "list_files", "read_file", "list_layouts", "write_spec", "patch_spec", "insert_layout", "set_layout_params", "delete_file", "set_manifest", "run_checks", "draft_proposal", "revise_proposal", "propose_variants", "revise_variant", "list_variants", "address_note"]);
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
    expect(outcome.content).toContain('element "heading" sets "style", a style prop the project excludes');
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

describe("the layout tools", () => {
  it("list_layouts lists each layout with its parameters and where it is drawn", async () => {
    const parts = fakeHost(seedSpec());
    const outcome = await runTool(call("list_layouts", {}), parts.host, signal);
    expect(outcome.title).toBe("Listed 3 layouts");
    const listed = JSON.parse(outcome.content) as { id: string; params: Record<string, { type: string; is: string; required: boolean }>; drawnAt: string[] }[];
    expect(listed.map((layout) => layout.id)).toEqual(["room-cards", "room-details", "select-question"]);
    const question = listed.find((layout) => layout.id === "select-question");
    expect(question?.params.label).toMatchObject({ type: "text", is: "text", required: true, example: "How long?" });
    expect(question?.params.hint).toMatchObject({ type: "slot", required: false });
    expect(question?.drawnAt).toEqual(['pages/booking.json:20 (element "question")']);
  });

  it("insert_layout draws a second instance with its own parameters, which core checks first", async () => {
    const parts = fakeHost(seedSpec());
    const outcome = await runTool(call("insert_layout", { path: "pages/booking.json", into: { element: "page", slot: "body", index: 1 }, key: "start", layout: "select-question", params: { label: "Starting when?", choices: [{ value: "now", label: "Now" }], answer: { $bindState: "/start" } } }), parts.host, signal);
    expect(outcome).toMatchObject({ isError: false, changed: true, title: "Drew select-question in pages/booking.json" });
    const spec = JSON.parse(parts.prototype().files["pages/booking.json"] ?? "") as { elements: Record<string, { slots?: Record<string, string[]>; props?: unknown }> };
    expect(spec.elements.page?.slots?.body).toEqual(["question", "start", "details"]);
    // Two questions now: the checks say so, and nothing collides.
    const report = checkPrototype({ config: nook, prototype: parts.prototype() });
    expect(report.rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule)).toEqual(["visible-questions"]);
    const wrong = await runTool(call("insert_layout", { path: "pages/booking.json", into: { element: "page", slot: "body" }, key: "bad", layout: "select-question", params: { label: 30 } }), parts.host, signal);
    expect(wrong.isError).toBe(true);
    expect(wrong.content).toContain('element "bad" gives "label" 30; "label" is text.');
    expect(wrong.content).toContain('element "bad" has no "answer", which layout "select-question" needs.');
    expect(parts.applied).toHaveLength(1);
  });

  it("set_layout_params changes an instance's parameters and slots, and refuses what the layout does not take", async () => {
    const parts = fakeHost(seedSpec());
    const outcome = await runTool(call("set_layout_params", { path: "pages/booking.json", key: "question", set: { label: "For how long?" } }), parts.host, signal);
    expect(outcome).toMatchObject({ isError: false, changed: true, content: expect.stringContaining('Instance "question" in pages/booking.json: set label.') });
    expect(parts.prototype().files["pages/booking.json"]).toContain('"label":"For how long?"');
    const refusedValue = await runTool(call("set_layout_params", { path: "pages/booking.json", key: "question", set: { colour: "red" } }), parts.host, signal);
    expect(refusedValue.content).toContain('element "question" sets "colour", which layout "select-question" does not take. It takes "answer", "choices", "label".');
    const notInstance = await runTool(call("set_layout_params", { path: "pages/booking.json", key: "book", set: { label: "x" } }), parts.host, signal);
    expect(notInstance.content).toBe('pages/booking.json has no Layout element "book"; it is a Button.Root.');
    const required = await runTool(call("set_layout_params", { path: "pages/booking.json", key: "question", remove: ["label"] }), parts.host, signal);
    expect(required.content).toContain('has no "label", which layout "select-question" needs.');
    expect(parts.applied).toHaveLength(1);
  });

  it("a new layout is drafted as a proposal with its spec and examples, and core's dry run judges it", async () => {
    const parts = fakeHost(seedSpec());
    const note = { params: { text: { type: "text", example: "Quiet room" } }, root: "note", elements: { note: { type: "Text.Root", props: { as: "p", text: { $param: "text" } }, children: [] } } };
    const base = seedSpec();
    const booking = base.files["pages/booking.json"] ?? "";
    const withNotes = (count: number) =>
      booking
        .replace('"body": ["question", "details"]', `"body": ["question", "details"${Array.from({ length: count }, (_, index) => `, "note-${index}"`).join("")}]`)
        .replace('    "hold":', `${Array.from({ length: count }, (_, index) => `    "note-${index}": { "type": "Layout", "props": { "id": "room-note", "text": "Note ${index}" }, "children": [] },\n`).join("")}    "hold":`);
    const manifest = { pages: base.pages, layouts: [...base.layouts, { id: "room-note", component: { file: "layouts/room-note.json", export: "default" } }], scenarios: base.scenarios, flow: base.flow };
    const outcome = await runTool(
      call("draft_proposal", {
        id: "room-note",
        title: "A note about a room",
        reason: "The booking page needs one line about the room that is not a detail.",
        inventory: [{ op: "add-layout", id: "room-note" }],
        rules: { add: [{ type: "count", id: "one-room-note-per-page", scope: "page", select: { layout: "room-note" }, max: 1 }] },
        examples: {
          pass: [{ name: "one-note", files: { "layouts/room-note.json": formatSpec(note), "pages/booking.json": withNotes(1) }, manifest }],
          fail: [{ name: "two-notes", files: { "layouts/room-note.json": formatSpec(note), "pages/booking.json": withNotes(2) }, manifest, flagged_by: { rule: "one-room-note-per-page" } }],
        },
      }),
      parts.host,
      signal,
    );
    expect(outcome.proposal).toMatchObject({ id: "room-note", adoptable: true, action: "drafted" });
    expect(outcome.content).toContain("Core's adoption dry run passes");
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
    expect(system.map((block) => block.text.slice(0, 40))).toEqual([SPEC_SYSTEM_PROMPT.slice(0, 40), specCatalogPrompt(nook).slice(0, 40)]);
    expect(system.every((block) => block.cache_control !== undefined)).toBe(true);
    expect((first?.body.tools as { name: string }[]).map((tool) => tool.name)).toContain("patch_spec");
    expect((first?.body.tools as { name: string }[]).map((tool) => tool.name)).not.toContain("write_file");
    expect(turn.items.filter((item) => item.kind === "checks").map((item) => item.kind === "checks" && item.status)).toEqual(["fail", "incomplete"]);
    // The same spec as before the turn, rewritten one element per line.
    expect(JSON.parse(parts.prototype().files["pages/booking.json"] ?? "")).toEqual(JSON.parse(seedSpec().files["pages/booking.json"] ?? ""));
  });
});
