import { describe, expect, it } from "vitest";
import type { Prototype, RuleSpec } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { proposeByPerson, removalDraft } from "../review/rule-change";
import { fakeHost } from "../../test/agent-host";
import { withPrimaries, withTwoQuestions } from "../../test/rule-change";
import { SYSTEM_PROMPT } from "./request";
import { seedLegal, seedSpec } from "../../test/nook";
import { drafted, specToastDraft, withSpecToasts } from "../../test/proposals";
import { MANIFEST, TOOL_DEFINITIONS, runTool } from "./tools";

const signal = new AbortController().signal;
const call = (name: string, input: unknown) => ({ id: `toolu_${name}`, name, input });
const SECOND_PRIMARY = { path: "pages/booking.json", patches: '{"op":"replace","path":"/elements/hold/props/variant","value":"primary"}' };

describe("the agent's tools", () => {
  it("are declared once, in a fixed order, each streaming its input eagerly, and none writes code", () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(["read_project", "list_files", "read_file", "list_layouts", "write_spec", "patch_spec", "insert_layout", "set_layout_params", "delete_file", "set_manifest", "run_checks", "draft_proposal", "revise_proposal", "propose_variants", "revise_variant", "list_variants", "address_note"]);
    expect(TOOL_DEFINITIONS.every((tool) => tool.eager_input_streaming === true && tool.input_schema.type === "object")).toBe(true);
    expect(TOOL_DEFINITIONS.some((tool) => /write_file|edit_file/.test(tool.name))).toBe(false);
    expect(JSON.stringify(TOOL_DEFINITIONS)).not.toMatch(/\.tsx|TSX/);
  });

  it("read the project, the file list with the manifest, and one file", async () => {
    const { host } = fakeHost();
    const project = await runTool(call("read_project", {}), host, signal);
    expect(JSON.parse(project.content)).toMatchObject({ project: { id: "nook" }, library: { package: "@tounsoo/todae" }, inventories: { layouts: ["room-cards", "room-details", "select-question"] } });
    const files = await runTool(call("list_files", {}), host, signal);
    expect(files.content).toContain("pages/booking.json (");
    expect(files.content).toContain(`${MANIFEST}:\n{`);
    const file = await runTool(call("read_file", { path: "pages/rooms.json" }), host, signal);
    expect(file.content).toBe(host.prototype().files["pages/rooms.json"]);
    expect((await runTool(call("read_file", { path: "pages/nope.json" }), host, signal)).isError).toBe(true);
  });

  it("refuse input that does not fit the schema, and run nothing", async () => {
    const { host, applied } = fakeHost();
    const outcome = await runTool(call("patch_spec", { path: "../escape.json", patches: "x" }), host, signal);
    expect(outcome).toMatchObject({ isError: true, changed: false, title: "patch_spec: input refused" });
    expect(outcome.content).toContain("input.path: does not match");
    expect((await runTool(call("write_spec", { path: "pages/a.json" }), host, signal)).content).toContain('input: is missing "spec"');
    expect((await runTool(call("write_spec", { path: MANIFEST, spec: {} }), host, signal)).isError).toBe(true);
    expect((await runTool(call("write_spec", { path: "pages/a.tsx", spec: {} }), host, signal)).isError).toBe(true);
    expect((await runTool(call("no_such_tool", {}), host, signal)).isError).toBe(true);
    expect(applied).toEqual([]);
  });

  it("refuse every call on a TSX prototype, which is read-only, and change nothing", async () => {
    const { host, applied, saved, savedVariants } = fakeHost(seedLegal());
    for (const [name, input] of [
      ["read_project", {}],
      ["list_files", {}],
      ["read_file", { path: "pages/booking.tsx" }],
      ["write_file", { path: "pages/booking.tsx", content: "export default () => null;\n" }],
      ["edit_file", { path: "pages/booking.tsx", old_text: "Hold room", new_text: "Hold" }],
      ["delete_file", { path: "pages/booking.tsx" }],
      ["set_manifest", { pages: [], layouts: [], scenarios: [], flow: { states: [], tasks: [] } }],
      ["draft_proposal", { id: "x", title: "t", reason: "r", examples: { pass: [{ name: "a" }], fail: [{ name: "b", flagged_by: { rule: "x" } }] } }],
      ["propose_variants", { page: "booking", variants: [] }],
      ["address_note", { note: 1, reply: "Done." }],
    ] as const) {
      const outcome = await runTool(call(name, input), host, signal);
      expect(outcome).toMatchObject({ isError: true, changed: false, title: `${name} not run: TSX is read-only` });
      expect(outcome.content).toMatch(/^This prototype is TSX\. TSX prototypes are no longer edited here: the agent writes specs only\. .* Nothing ran\.$/);
    }
    expect(host.prototype()).toEqual(seedLegal());
    expect([applied, saved, savedVariants]).toEqual([[], [], []]);
  });

  it("delete a spec file, refuse a manifest core does not accept, and keep the prototype a spec", async () => {
    const { host } = fakeHost();
    expect((await runTool(call("write_spec", { path: "layouts/note.json", spec: { root: "x", elements: { x: { type: "Text.Root", props: { as: "p", text: "Note" }, children: [] } } } }), host, signal)).title).toBe("Created layouts/note.json");
    expect((await runTool(call("delete_file", { path: "layouts/note.json" }), host, signal)).title).toBe("Deleted layouts/note.json");
    expect((await runTool(call("delete_file", { path: "layouts/note.json" }), host, signal)).isError).toBe(true);
    const { files: _files, ...manifest } = host.prototype();
    const twice = { ...manifest, scenarios: [...manifest.scenarios, manifest.scenarios[0]] };
    const refused = await runTool(call("set_manifest", twice), host, signal);
    expect(refused).toMatchObject({ isError: true, changed: false });
    expect(refused.content).toContain('$.scenarios[4]: scenario id "rooms-list" appears twice');
    expect((await runTool(call("set_manifest", manifest), host, signal)).changed).toBe(true);
    // A manifest without "format" keeps the prototype a spec: set_manifest never turns it into TSX.
    const { format: _format, ...plain } = manifest;
    expect((await runTool(call("set_manifest", { ...plain, scenarios: plain.scenarios.slice(0, 3) }), host, signal)).changed).toBe(true);
    expect(host.prototype()).toMatchObject({ format: "spec", scenarios: plain.scenarios.slice(0, 3) });
  });

  it("run_checks returns core's report for the measured revision, failing rules and findings word for word", async () => {
    const { host } = fakeHost();
    await runTool(call("patch_spec", SECOND_PRIMARY), host, signal);
    const checks = await runTool(call("run_checks", {}), host, signal);
    expect(checks.measured?.report.status).toBe("fail");
    expect(checks.title).toBe("Checks fail: 3 rules");
    expect(checks.content).toMatch(/^Checks for revision 2, with every frame measured: fail\./);
    expect(checks.content).toContain('- one-primary-per-page (count): A page holds at most one primary action.\n  violation: Page "booking" has 2 primary actions, more than 1');
  });

  it("draft_proposal drafts a removal and a change of a rule in force, each open, and neither tool nor prompt lets the agent decide one", async () => {
    const { host, saved } = fakeHost(withPrimaries(1));
    const page = (prototype: Prototype) => prototype.files["pages/booking.json"] ?? "";
    const removal = await runTool(
      call("draft_proposal", {
        id: "drop-one-primary",
        title: "Let a page hold more than one primary action",
        reason: "Booking early is a second primary action.",
        rules: { remove: ["one-primary-per-page"] },
        examples: { pass: [{ name: "book-early" }], fail: [{ name: "two-questions", files: { "pages/booking.json": page(withTwoQuestions()) }, flagged_by: { rule: "visible-questions" } }] },
      }),
      host,
      signal,
    );
    expect(removal.proposal).toMatchObject({ id: "drop-one-primary", adoptable: true, action: "drafted" });
    expect(removal.content).toContain('classified loosens-or-removes. remove rule "one-primary-per-page": loosens-or-removes (a rule leaves force)');
    const change = await runTool(
      call("draft_proposal", {
        id: "two-primaries",
        title: "Allow two primary actions",
        reason: "Booking early is a second primary action.",
        rules: { remove: ["one-primary-per-page"], add: [{ type: "count", id: "one-primary-per-page", scope: "page", select: { role: "primary-action" }, max: 2 }] },
        examples: { pass: [{ name: "book-early" }], fail: [{ name: "three-ways", files: { "pages/booking.json": page(withPrimaries(2)) }, flagged_by: { rule: "one-primary-per-page" } }] },
      }),
      host,
      signal,
    );
    expect(change.proposal).toMatchObject({ id: "two-primaries", adoptable: true });
    expect(change.content).toContain('classified loosens-or-removes. change rule "one-primary-per-page": loosens-or-removes (moves max from 1 to 2, the looser way)');
    // Both are open, by the agent, and the rule is in force as it was: only a person approves and adopts.
    const config = saved.at(-1);
    expect(config?.proposals.map((proposal) => [proposal.id, proposal.status, proposal.history[0]?.by])).toEqual([
      ["drop-one-primary", "open", "agent"],
      ["two-primaries", "open", "agent"],
    ]);
    expect(config?.rules).toEqual(nook.rules);
    expect(TOOL_DEFINITIONS.some((tool) => /approve|adopt|decline/.test(tool.name))).toBe(false);
    expect(SYSTEM_PROMPT).toContain("To remove a rule in force, draft a proposal with its id in rules.remove. To change one, give its id in rules.remove and the changed rule, under that id, in rules.add");
    expect(SYSTEM_PROMPT).toContain("Only the person can approve, decline or adopt it");
  });

  it("revise_proposal adds examples to a proposal the person opened, leaving what it changes as they wrote it", async () => {
    const opened = proposeByPerson(nook, removalDraft(nook, nook.rules.find((rule) => rule.id === "one-primary-per-page") as RuleSpec, "Booking early is a second primary action."), { pass: [], fail: [] }, "2026-11-19T10:00:00.000Z");
    if (!opened.ok) throw new Error(opened.error.message);
    const { host, saved } = fakeHost(withPrimaries(1), opened.value);
    const page = (prototype: Prototype) => prototype.files["pages/booking.json"] ?? "";
    const revised = await runTool(
      call("revise_proposal", { id: "remove-one-primary-per-page", note: "Added the examples it needs.", examples: { pass: [{ name: "book-early" }], fail: [{ name: "two-questions", files: { "pages/booking.json": page(withTwoQuestions()) }, flagged_by: { rule: "visible-questions" } }] } }),
      host,
      signal,
    );
    expect(revised.proposal).toMatchObject({ id: "remove-one-primary-per-page", adoptable: true, action: "revised" });
    const proposal = saved.at(-1)?.proposals[0];
    expect(proposal).toMatchObject({ status: "open", title: "Remove the rule “A page holds at most one primary action”", reason: "Booking early is a second primary action.", rules: { add: [], remove: ["one-primary-per-page"] } });
    expect(proposal?.history).toEqual([{ status: "open", at: "2026-11-19T10:00:00.000Z", by: "you" }]);
    expect(proposal?.events?.map((event) => [event.kind, event.by])).toEqual([["revised", "agent"]]);
  });

  it("draft_proposal saves an open proposal and returns core's adoption dry run, refusal included", async () => {
    const { host, saved } = fakeHost();
    const toastPage = (count: number) => withSpecToasts(count, host.prototype()).files["pages/booking.json"];
    const draft = (fail: number) => ({
      id: "toast",
      title: "Add a toast for confirmations",
      reason: "A booking needs a confirmation that does not move the page.",
      inventory: [{ op: "add-component", name: "Toast" }],
      rules: { add: [{ type: "count", id: "one-toast-per-page", scope: "page", select: { component: "Toast.Root" }, max: 1 }] },
      examples: {
        pass: [{ name: "one-toast", files: { "pages/booking.json": toastPage(1) } }],
        fail: [{ name: "toasts", files: { "pages/booking.json": toastPage(fail) }, flagged_by: { rule: "one-toast-per-page" } }],
      },
    });
    const refused = await runTool(call("draft_proposal", draft(1)), host, signal);
    expect(refused.proposal).toMatchObject({ id: "toast", adoptable: false });
    expect(refused.content).toContain('Saved proposal "toast" as open. Core\'s adoption dry run refuses it: [failing-example-passes] failing example "toasts" is not flagged as it must be: "one-toast-per-page" passed it');
    const again = await runTool(call("draft_proposal", draft(2)), host, signal);
    expect(again).toMatchObject({ isError: true, title: "Proposal toast not drafted" });
    expect(again.content).toContain('A proposal "toast" already exists and is open. Change it with revise_proposal');
    const fixed = await runTool(call("revise_proposal", { id: "toast", note: "Two toasts in the failing example.", examples: draft(2).examples }), host, signal);
    expect(fixed.proposal).toMatchObject({ id: "toast", adoptable: true, action: "revised" });
    expect(fixed.content).toContain('Revised proposal "toast"; it is still open, and its history keeps the version before this one. Core\'s adoption dry run passes');
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

describe("revise_proposal", () => {
  const signal = new AbortController().signal;
  const call = (name: string, input: unknown) => ({ id: `toolu_${name}`, name, input });

  it("revises an open proposal, keeps its status and history, records the version it replaced, and runs the dry run again", async () => {
    const { host, saved } = fakeHost(seedSpec(), drafted(specToastDraft()));
    const revised = await runTool(call("revise_proposal", { id: "booking-toast", note: "A clearer title.", title: "One toast confirms a booking" }), host, signal);
    expect(revised).toMatchObject({ isError: false, changed: false, title: "Revised proposal booking-toast", proposal: { id: "booking-toast", action: "revised", adoptable: true } });
    expect(revised.content).toContain("Core's adoption dry run passes: once approved it would be adopted, classified tightens.");
    const proposal = host.config().proposals[0];
    expect(proposal).toMatchObject({ title: "One toast confirms a booking", status: "open", history: [{ status: "open", at: "2026-11-18T09:00:00.000Z", by: "agent" }] });
    expect(proposal?.events).toEqual([{ kind: "revised", at: "2026-11-17T12:00:00.000Z", by: "agent", note: "A clearer title.", previous: expect.objectContaining({ title: "A toast that confirms a booking" }) }]);
    expect(proposal?.examples).toEqual(drafted(specToastDraft()).proposals[0]?.examples);
    expect(saved).toHaveLength(1);
  });

  it("re-runs the dry run on the revision: a revision that breaks the failing example says so", async () => {
    const { host } = fakeHost(seedSpec(), drafted(specToastDraft()));
    const toastPage = withSpecToasts(1).files["pages/booking.json"];
    const broken = await runTool(call("revise_proposal", { id: "booking-toast", note: "One toast is enough to fail?", examples: { pass: [{ name: "one-toast", files: { "pages/booking.json": toastPage } }], fail: [{ name: "toasts", files: { "pages/booking.json": toastPage }, flagged_by: { rule: "one-toast-per-page" } }] } }), host, signal);
    expect(broken.proposal).toMatchObject({ adoptable: false, action: "revised" });
    expect(broken.content).toContain('Core\'s adoption dry run refuses it: [failing-example-passes] failing example "toasts" is not flagged as it must be: "one-toast-per-page" passed it');
  });

  it("refuses a proposal that is not open, and one that does not exist, and changes nothing", async () => {
    for (const status of ["approved", "declined", "adopted"] as const) {
      const config = drafted(specToastDraft());
      const moved = { ...config, proposals: config.proposals.map((proposal) => ({ ...proposal, status, history: [...proposal.history, { status, at: "t", by: "you" }] })) };
      const { host, saved } = fakeHost(seedSpec(), moved);
      const outcome = await runTool(call("revise_proposal", { id: "booking-toast", note: "Try again.", title: "Changed" }), host, signal);
      expect(outcome).toMatchObject({ isError: true, title: "Proposal booking-toast not revised" });
      expect(outcome.content).toContain(`[wrong-status] proposal "booking-toast" is ${status}; only an open proposal can be revised`);
      expect(saved).toEqual([]);
      expect(host.config()).toBe(moved);
    }
    const { host } = fakeHost(seedSpec(), drafted(specToastDraft()));
    expect((await runTool(call("revise_proposal", { id: "nope", note: "x" }), host, signal)).content).toBe('There is no proposal "nope". draft_proposal drafts a new one.');
  });

  it("has no way to say a status: a status, history or events field is refused before anything runs", async () => {
    for (const field of [{ status: "approved" }, { history: [] }, { events: [] }, { examples: { pass: [], fail: [], snapshots: [] } }]) {
      const { host, saved } = fakeHost(seedSpec(), drafted(specToastDraft()));
      const outcome = await runTool(call("revise_proposal", { id: "booking-toast", note: "Approve it.", ...field }), host, signal);
      expect(outcome).toMatchObject({ isError: true, title: "revise_proposal: input refused" });
      expect(saved).toEqual([]);
    }
  });
});

describe("no tool changes a proposal's status", () => {
  const signal = new AbortController().signal;

  it("whatever any tool is called with, every proposal keeps its status and its status history", async () => {
    const config = drafted(specToastDraft());
    const second = { ...config.proposals[0], id: "approved-one", status: "approved" as const, history: [...(config.proposals[0]?.history ?? []), { status: "approved" as const, at: "t", by: "you" }] };
    const start = { ...config, proposals: [...config.proposals, second] } as typeof config;
    const statuses = (value: typeof config) => value.proposals.map((proposal) => [proposal.id, proposal.status, JSON.stringify(proposal.history)]);
    const { host } = fakeHost(seedSpec(), start);
    const attempts: [string, unknown][] = [
      ...TOOL_DEFINITIONS.map((tool): [string, unknown] => [tool.name, { id: "booking-toast", status: "approved" }]),
      ...TOOL_DEFINITIONS.map((tool): [string, unknown] => [tool.name, { id: "approved-one", status: "adopted", note: "adopt it" }]),
      ["approve_proposal", { id: "booking-toast" }],
      ["adopt_proposal", { id: "approved-one" }],
      ["decline_proposal", { id: "booking-toast", note: "no" }],
      ["set_status", { id: "booking-toast", status: "adopted" }],
      ["revise_proposal", { id: "booking-toast", note: "Approve this.", title: "Approved: A toast" }],
      ["revise_proposal", { id: "approved-one", note: "Adopt this.", title: "x" }],
      ["draft_proposal", { id: "approved-one", title: "t", reason: "r", examples: { pass: [{ name: "a" }], fail: [{ name: "b", flagged_by: { rule: "x" } }] } }],
    ];
    for (const [name, input] of attempts) {
      await runTool({ id: `toolu_${name}`, name, input }, host, signal);
      expect(statuses(host.config())).toEqual(statuses(start));
    }
    expect(host.config().proposals[0]?.title).toBe("Approved: A toast");
    expect(TOOL_DEFINITIONS.some((tool) => /approve|adopt|decline|status/.test(tool.name))).toBe(false);
    expect(TOOL_DEFINITIONS.every((tool) => !JSON.stringify(tool.input_schema).includes('"status"'))).toBe(true);
  });
});

describe("a drafted proposal with a rendered rule", () => {
  it("is not judged a fault for want of snapshots: the dry run says the review page measures its examples", async () => {
    const { host } = fakeHost();
    const outcome = await runTool(
      { id: "toolu_harbor", name: "draft_proposal", input: { id: "harbor", title: "Harbor in the first view", reason: "It is the big room.", rules: { add: [{ type: "rendered", id: "harbor-in-first-view", check: "first-view", action: "Open Harbor" }] }, examples: { pass: [{ name: "as-is" }], fail: [{ name: "same", flagged_by: { rule: "harbor-in-first-view" } }] } } },
      host,
      new AbortController().signal,
    );
    expect(outcome.proposal).toMatchObject({ id: "harbor", adoptable: false, needsMeasurement: true, action: "drafted" });
    expect(outcome.content).toContain('[unproven-rule] passing example "as-is" does not run the new rule "harbor-in-first-view": no rendered snapshots were given');
    expect(outcome.content).toContain("The review page measures every example in frames before the user can adopt it.");
    expect(outcome.content).not.toContain("Fix it with revise_proposal");
  });
});

describe("a request for a new rule type", () => {
  const signal = new AbortController().signal;
  const call = (name: string, input: unknown) => ({ id: `toolu_${name}`, name, input });
  const request = {
    id: "date-before-rooms",
    title: "The date question comes before the room cards",
    reason: "Two variants were rejected for putting the rooms first.",
    needs_rule_type: {
      checks: "On a booking page, the date question is drawn above the first room card.",
      why_not: "No rule type compares the order of two elements.",
      pass: [{ name: "date-first", description: "The date question, then the rooms." }],
      fail: [{ name: "rooms-first", description: "The rooms, then the date question.", snippet: "<RoomCards />" }],
    },
  };

  it("is saved open with draft_proposal, as a request core never adopts, and the agent is told so", async () => {
    const { host, saved } = fakeHost();
    const outcome = await runTool(call("draft_proposal", request), host, signal);
    expect(outcome).toMatchObject({ isError: false, title: "Filed a request for a new rule type, date-before-rooms", proposal: { id: "date-before-rooms", adoptable: false, request: true } });
    expect(outcome.content).toContain('Saved request "date-before-rooms" for a new rule type as open.');
    expect(outcome.content).toContain("core will never approve or adopt it as a check");
    expect(saved).toHaveLength(1);
    expect(host.config().proposals[0]).toMatchObject({ status: "open", needsRuleType: { checks: request.needs_rule_type.checks, whyNot: request.needs_rule_type.why_not, fail: [{ name: "rooms-first", snippet: "<RoomCards />" }] } });
    expect(JSON.parse((await runTool(call("read_project", {}), host, signal)).content).proposals[0]).toMatchObject({ id: "date-before-rooms", needsRuleType: { whyNot: request.needs_rule_type.why_not } });
  });

  it("is refused with rules or examples beside it, and a draft with neither examples nor a request saves nothing", async () => {
    const { host, saved } = fakeHost();
    const mixed = await runTool(call("draft_proposal", { ...request, rules: { remove: ["visible-questions"] } }), host, signal);
    expect(mixed.content).toContain("[invalid-proposal] a request for a new rule type changes nothing, so it carries no rules");
    const empty = await runTool(call("draft_proposal", { id: "empty", title: "t", reason: "r" }), host, signal);
    expect(empty).toMatchObject({ isError: true });
    expect(empty.content).toContain("Give examples that pass and fail");
    expect(saved).toEqual([]);
  });

  it("is revised like any open proposal, and keeps the request it does not replace", async () => {
    const { host } = fakeHost();
    await runTool(call("draft_proposal", request), host, signal);
    const revised = await runTool(call("revise_proposal", { id: request.id, note: "A clearer title.", title: "Date first" }), host, signal);
    expect(revised).toMatchObject({ isError: false, proposal: { request: true, action: "revised" } });
    expect(host.config().proposals[0]).toMatchObject({ title: "Date first", status: "open", needsRuleType: { checks: request.needs_rule_type.checks } });
  });
});
