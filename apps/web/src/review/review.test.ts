import { describe, expect, it } from "vitest";
import { parseProjectConfig, rerunExamples, revise, type ProjectConfig, type Refusal, type Result } from "@design-harness/core";
import { exportProject, importProject } from "../store/project-file";
import { seedLegal } from "../../test/nook";
import { drafted, harborBelowFold, harborDraft, legalSnapshots, toastDraft } from "../../test/proposals";
import { adoptProposal, approveProposal, declineProposal, sendBackMessage, sendBackProposal } from "./actions";
import { inventoryDiff } from "./diff";
import { REVIEWER, ownProposal, proposalTimeline, timelineTitle } from "./timeline";

function ok<T>(result: Result<T, Refusal | string>): T {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.error)}`);
  return result.value;
}

const proposal = (config: ProjectConfig, id = "booking-toast") => {
  const found = config.proposals.find((item) => item.id === id);
  if (!found) throw new Error(`no proposal ${id}`);
  return found;
};

describe("the review's history", () => {
  it("records every status change and note with the time and who, oldest first", () => {
    let config = drafted();
    config = ok(sendBackProposal(config, "booking-toast", "Say what the toast says when booking fails.", "2026-11-18T09:05:00.000Z")).config;
    config = ok(revise(config, "booking-toast", { ...toastDraft(), title: "A toast for booking, and for a failed booking" }, { at: "2026-11-18T09:06:00.000Z", by: "agent", note: "Named the failure state." }));
    config = ok(approveProposal(config, "booking-toast", "2026-11-18T09:10:00.000Z"));
    config = ok(declineProposal(config, "booking-toast", "  Not this quarter.  ", "2026-11-18T09:20:00.000Z"));
    const timeline = proposalTimeline(proposal(config));
    expect(timeline.map((entry) => [timelineTitle(entry), entry.at, "note" in entry ? entry.note : undefined])).toEqual([
      ["Drafted by agent", "2026-11-18T09:00:00.000Z", undefined],
      ["Sent back by you", "2026-11-18T09:05:00.000Z", "Say what the toast says when booking fails."],
      ["Revised by agent", "2026-11-18T09:06:00.000Z", "Named the failure state."],
      ["Approved by you", "2026-11-18T09:10:00.000Z", undefined],
      ["Declined by you", "2026-11-18T09:20:00.000Z", "Not this quarter."],
    ]);
    const revised = timeline[2];
    expect(revised?.kind === "revised" && revised.previous.title).toBe("A toast that confirms a booking");
    expect(proposal(config).title).toBe("A toast for booking, and for a failed booking");
    expect(proposal(config).history.every((entry, index) => index === 0 || entry.by === REVIEWER)).toBe(true);
  });

  it("keeps the order of entries at the same time, status first", () => {
    const config = ok(sendBackProposal(drafted(), "booking-toast", "Tighter.", "2026-11-18T09:00:00.000Z")).config;
    expect(proposalTimeline(proposal(config)).map((entry) => entry.kind)).toEqual(["status", "sent-back"]);
  });
});

describe("the review's actions", () => {
  it("decline needs a note, and approve and decline follow core's status rules", () => {
    const config = drafted();
    expect(declineProposal(config, "booking-toast", "   ", "t")).toMatchObject({ ok: false, error: { code: "missing-note" } });
    const declined = ok(declineProposal(config, "booking-toast", "No.", "t"));
    expect(proposal(declined).history.at(-1)).toEqual({ status: "declined", at: "t", by: "you", note: "No." });
    expect(approveProposal(declined, "booking-toast", "t2")).toMatchObject({ ok: false, error: { code: "wrong-status" } });
  });

  it("send back needs a note, keeps the proposal open, and names the proposal in the agent's message", () => {
    expect(sendBackProposal(drafted(), "booking-toast", "", "t")).toMatchObject({ ok: false, error: { code: "missing-note" } });
    const sent = ok(sendBackProposal(drafted(), "booking-toast", "Two examples, please.", "t"));
    expect(proposal(sent.config).status).toBe("open");
    expect(sent.message).toBe(sendBackMessage(proposal(sent.config), "Two examples, please."));
    expect(sent.message).toContain('proposal "booking-toast" (A toast that confirms a booking)');
    expect(sent.message).toContain("revise_proposal");
    expect(sent.message.endsWith("Two examples, please.")).toBe(true);
  });

  it("a proposal the person drafted is not sent back: the agent is asked to revise it, and the history says so", () => {
    const mine = drafted();
    const own = { ...mine, proposals: mine.proposals.map((item) => ({ ...item, history: item.history.map((entry, index) => (index === 0 ? { ...entry, by: REVIEWER } : entry)) })) };
    const sent = ok(sendBackProposal(own, "booking-toast", "Keep it to the booking page.", "2026-11-18T09:05:00.000Z"));
    expect(sent.message).toBe('I started proposal "booking-toast" (A toast that confirms a booking) myself, and I am asking you to revise it from its review page. Revise it with revise_proposal, keeping its id. My note:\n\nKeep it to the booking page.');
    expect(sent.message).not.toContain("back");
    expect(ownProposal(proposal(sent.config))).toBe(true);
    expect(proposalTimeline(proposal(sent.config)).map((entry) => timelineTitle(entry, true))).toEqual(["Drafted by you", "Revision asked by you"]);
    // The agent's proposal reads as it did.
    expect(ownProposal(proposal(drafted()))).toBe(false);
    expect(ok(sendBackProposal(drafted(), "booking-toast", "Tighter.", "t")).message).toMatch(/^I sent proposal "booking-toast" \(A toast that confirms a booking\) back to you from its review page\./);
  });

  it("adopts on measured examples, storing the snapshots, so a reload re-runs the examples to the same result", () => {
    const config = ok(approveProposal(drafted(harborDraft()), "harbor", "t1"));
    const measurement = { "as-is": legalSnapshots(), "long-intro": harborBelowFold() };
    expect(adoptProposal(config, "harbor", { "as-is": legalSnapshots() }, [], "t2")).toMatchObject({ ok: false, error: { code: "incomplete-measurement" } });
    const adoption = ok(adoptProposal(config, "harbor", measurement, [{ name: "Booking", prototype: seedLegal(), snapshots: legalSnapshots() }], "t2"));
    expect(proposal(adoption.config, "harbor").history.at(-1)).toEqual({ status: "adopted", at: "t2", by: "you" });
    expect(adoption.config.rules.some((rule) => rule.id === "harbor-in-first-view")).toBe(true);
    const before = rerunExamples(adoption.config);
    expect(before.map((run) => [run.example, run.ok])).toEqual([["as-is", true], ["long-intro", true]]);

    // A reload reads the project back from the export format and core's validation, with no frames.
    const file = exportProject(adoption.config, [{ projectId: "nook", id: "booking", name: "Booking", prototype: seedLegal() }]);
    const reloaded = ok(importProject(file) as Result<{ config: ProjectConfig }, string>).config;
    expect(rerunExamples(reloaded)).toEqual(before);
    const stored = parseProjectConfig(JSON.parse(JSON.stringify(adoption.config)));
    expect(stored.ok && rerunExamples(stored.value)).toEqual(before);
  });

  it("refuses an adoption whose failing example does not fail, in core's words", () => {
    const config = ok(approveProposal(drafted(toastDraft(1)), "booking-toast", "t1"));
    const measurement = { "one-toast": legalSnapshots(), toasts: legalSnapshots() };
    expect(adoptProposal(config, "booking-toast", measurement, [], "t2")).toEqual({
      ok: false,
      error: { code: "failing-example-passes", example: "toasts", findings: [], message: 'failing example "toasts" is not flagged as it must be: "one-toast-per-page" passed it' },
    });
  });
});

describe("the inventory diff", () => {
  it("lists only what the proposal changes, before and after", () => {
    const sections = ok(inventoryDiff(drafted(), proposal(drafted())));
    expect(sections).toEqual([
      {
        kind: "list",
        key: "components",
        title: "Components",
        before: ["Alert", "Button", "Card", "Disclosure", "EmptyState", "Field", "Label", "Stack", "Text"],
        after: ["Alert", "Button", "Card", "Disclosure", "EmptyState", "Field", "Label", "Stack", "Text", "Toast"],
        added: ["Toast"],
        removed: [],
      },
    ]);
  });

  it("shows changed rule inputs, added page types and removed members as rows", () => {
    const draft = {
      ...toastDraft(),
      inventory: [
        { op: "set-cap" as const, name: "MAX_DISCLOSURES_PER_PAGE", value: 2 },
        { op: "add-page-type" as const, pageType: { id: "receipt", kind: "content" as const, slots: ["title", "body"], chrome: ["title"] } },
        { op: "remove-layout" as const, id: "room-cards" },
        { op: "set-max-steps" as const, task: "hold-room", value: 3 },
        { op: "add-flow-state" as const, state: "cancelled" },
      ],
    };
    const config = drafted(draft);
    const sections = ok(inventoryDiff(config, proposal(config)));
    expect(sections.map((section) => section.key)).toEqual(["layouts", "page-types", "flow-states", "tasks", "caps"]);
    expect(sections.find((section) => section.key === "layouts")).toMatchObject({ added: [], removed: ["room-cards"] });
    expect(sections.find((section) => section.key === "page-types")).toMatchObject({ rows: [{ name: "receipt", change: "added", after: "content: slots title, body; chrome title" }] });
    expect(sections.find((section) => section.key === "caps")).toMatchObject({ rows: [{ name: "MAX_DISCLOSURES_PER_PAGE", change: "changed", before: "1 (stricter when lower)", after: "2 (stricter when lower)" }] });
    expect(sections.find((section) => section.key === "tasks")).toMatchObject({ rows: [{ name: "hold-room", change: "changed", before: "ends in held, at most 2 steps", after: "ends in held, at most 3 steps" }] });
  });

  it("says why a proposal cannot apply, and shows nothing for a rule-only proposal", () => {
    const again = drafted({ ...toastDraft(), inventory: [{ op: "add-component", name: "Button" }] });
    expect(inventoryDiff(again, proposal(again))).toEqual({ ok: false, error: 'operation 1, add-component "Button": Button is already an inventoried component' });
    const rulesOnly = drafted(harborDraft());
    expect(ok(inventoryDiff(rulesOnly, proposal(rulesOnly, "harbor")))).toEqual([]);
  });
});
