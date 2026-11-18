import { describe, expect, it } from "vitest";
import { fakeHost } from "../../test/agent-host";
import { MANIFEST, TOOL_DEFINITIONS, runTool } from "./tools";

const signal = new AbortController().signal;
const call = (name: string, input: unknown) => ({ id: `toolu_${name}`, name, input });
const SECOND_PRIMARY = { path: "pages/booking.tsx", old_text: '<Button.Root variant="secondary">Hold room</Button.Root>', new_text: '<Button.Root variant="primary">Hold room</Button.Root>' };

describe("the agent's tools", () => {
  it("are declared once, in a fixed order, each streaming its input eagerly", () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(["read_project", "list_files", "read_file", "write_file", "edit_file", "delete_file", "set_manifest", "run_checks", "draft_proposal"]);
    expect(TOOL_DEFINITIONS.every((tool) => tool.eager_input_streaming === true && tool.input_schema.type === "object")).toBe(true);
  });

  it("read the project, the file list with the manifest, and one file", async () => {
    const { host } = fakeHost();
    const project = await runTool(call("read_project", {}), host, signal);
    expect(JSON.parse(project.content)).toMatchObject({ project: { id: "nook" }, library: { package: "@tounsoo/todae" }, inventories: { layouts: ["room-cards", "room-details", "select-question"] } });
    const files = await runTool(call("list_files", {}), host, signal);
    expect(files.content).toContain("pages/booking.tsx (");
    expect(files.content).toContain(`${MANIFEST}:\n{`);
    const file = await runTool(call("read_file", { path: "pages/rooms.tsx" }), host, signal);
    expect(file.content).toBe(host.prototype().files["pages/rooms.tsx"]);
    expect((await runTool(call("read_file", { path: "pages/nope.tsx" }), host, signal)).isError).toBe(true);
  });

  it("refuse input that does not fit the schema, and run nothing", async () => {
    const { host, applied } = fakeHost();
    const outcome = await runTool(call("write_file", { path: "../escape.tsx", content: "x" }), host, signal);
    expect(outcome).toMatchObject({ isError: true, changed: false, title: "write_file: input refused" });
    expect(outcome.content).toContain("input.path: does not match");
    expect((await runTool(call("write_file", { path: "pages/a.tsx" }), host, signal)).content).toContain('input: is missing "content"');
    expect((await runTool(call("write_file", { path: MANIFEST, content: "{}" }), host, signal)).isError).toBe(true);
    expect((await runTool(call("no_such_tool", {}), host, signal)).isError).toBe(true);
    expect(applied).toEqual([]);
  });

  it("edit a file only where old_text appears exactly once, and make each change a revision", async () => {
    const { host, applied } = fakeHost();
    const edited = await runTool(call("edit_file", SECOND_PRIMARY), host, signal);
    expect(edited).toMatchObject({ isError: false, changed: true, title: "Edited pages/booking.tsx" });
    expect(edited.content).toBe("Edited pages/booking.tsx. Revision 2 is rendering; the checks for it follow this round.");
    expect(host.prototype().files["pages/booking.tsx"]).toContain('<Button.Root variant="primary">Hold room</Button.Root>');
    expect(applied).toHaveLength(1);
    const twice = await runTool(call("edit_file", { path: "pages/booking.tsx", old_text: "<Slot", new_text: "<Slot " }), host, signal);
    expect(twice).toMatchObject({ isError: true, changed: false });
    expect(twice.content).toContain("old_text appears 5 times in pages/booking.tsx; it must appear exactly once");
  });

  it("create, rewrite and delete files, and refuse a manifest core does not accept", async () => {
    const { host } = fakeHost();
    expect((await runTool(call("write_file", { path: "layouts/note.tsx", content: "export const a = 1;\n" }), host, signal)).title).toBe("Created layouts/note.tsx");
    expect((await runTool(call("write_file", { path: "layouts/note.tsx", content: "export const a = 2;\n" }), host, signal)).title).toBe("Rewrote layouts/note.tsx");
    expect((await runTool(call("delete_file", { path: "layouts/note.tsx" }), host, signal)).title).toBe("Deleted layouts/note.tsx");
    const { files: _files, ...manifest } = host.prototype();
    const twice = { ...manifest, scenarios: [...manifest.scenarios, manifest.scenarios[0]] };
    const refused = await runTool(call("set_manifest", twice), host, signal);
    expect(refused).toMatchObject({ isError: true, changed: false });
    expect(refused.content).toContain('$.scenarios[4]: scenario id "rooms-list" appears twice');
    expect((await runTool(call("set_manifest", manifest), host, signal)).changed).toBe(true);
  });

  it("run_checks returns core's report for the measured revision, failing rules and findings word for word", async () => {
    const { host } = fakeHost();
    await runTool(call("edit_file", SECOND_PRIMARY), host, signal);
    const checks = await runTool(call("run_checks", {}), host, signal);
    expect(checks.measured?.report.status).toBe("fail");
    expect(checks.title).toBe("Checks fail: 3 rules");
    expect(checks.content).toMatch(/^Checks for revision 2, with every frame measured: fail\./);
    expect(checks.content).toContain('- one-primary-per-page (count): A page holds at most one primary action.\n  violation: Page "booking" has 2 primary actions, more than 1');
  });

  it("draft_proposal saves an open proposal and returns core's adoption dry run, refusal included", async () => {
    const { host, saved } = fakeHost();
    const toastPage = (count: number) => host.prototype().files["pages/booking.tsx"]?.replace('import { Button, Text } from "@tounsoo/todae";', 'import { Button, Text, Toast } from "@tounsoo/todae";').replace('<Slot name="facts">', `<Slot name="facts">${"<Toast.Root>Booked</Toast.Root>".repeat(count)}`);
    const draft = (fail: number) => ({
      id: "toast",
      title: "Add a toast for confirmations",
      reason: "A booking needs a confirmation that does not move the page.",
      inventory: [{ op: "add-component", name: "Toast" }],
      rules: { add: [{ type: "count", id: "one-toast-per-page", scope: "page", select: { component: "Toast.Root" }, max: 1 }] },
      examples: {
        pass: [{ name: "one-toast", files: { "pages/booking.tsx": toastPage(1) } }],
        fail: [{ name: "toasts", files: { "pages/booking.tsx": toastPage(fail) }, flagged_by: { rule: "one-toast-per-page" } }],
      },
    });
    const refused = await runTool(call("draft_proposal", draft(1)), host, signal);
    expect(refused.proposal).toMatchObject({ id: "toast", adoptable: false });
    expect(refused.content).toContain('Saved proposal "toast" as open. Core\'s adoption dry run refuses it: [failing-example-passes] failing example "toasts" is not flagged as it must be: "one-toast-per-page" passed it');
    const fixed = await runTool(call("draft_proposal", draft(2)), host, signal);
    expect(fixed.proposal).toMatchObject({ id: "toast", adoptable: true });
    expect(fixed.content).toContain('Replaced your open draft "toast". Core\'s adoption dry run passes');
    expect(saved.map((config) => config.proposals.map((proposal) => [proposal.id, proposal.status]))).toEqual([[["toast", "open"]], [["toast", "open"]]]);
    expect(host.config().rules.some((rule) => rule.id === "one-toast-per-page")).toBe(false);
  });

  it("draft_proposal refuses a draft core does not accept, and never touches a proposal that is no longer open", async () => {
    const { host, saved } = fakeHost();
    const bad = await runTool(call("draft_proposal", { id: "bad", title: "t", reason: "r", inventory: [{ op: "add-nothing" }], examples: { pass: [{ name: "a" }], fail: [{ name: "b", flagged_by: { rule: "x" } }] } }), host, signal);
    expect(bad).toMatchObject({ isError: true, title: "Proposal bad not drafted" });
    expect(bad.content).toContain("Core refused the draft, so it was not saved: [invalid-proposal]");
    expect(saved).toEqual([]);
  });
});
