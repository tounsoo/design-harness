import { describe, expect, it } from "vitest";
import type { RuleReport } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { checksSummary, fileWords, toolSummary } from "./chat-words";
import { DEFAULT_PANELS, PANEL_SIZES, parsePanels } from "./panels";
import { findingPlace, frameLabel, humanize, ruleLead } from "./words";

describe("the panels a viewer keeps", () => {
  it("restores what was stored, and falls back to the default for anything missing or malformed", () => {
    expect(parsePanels(JSON.stringify({ chat: { open: false, width: 420 }, side: { open: true, width: 500 } }))).toEqual({ chat: { open: false, width: 420 }, side: { open: true, width: 500 } });
    expect(parsePanels(null)).toBe(DEFAULT_PANELS);
    expect(parsePanels("not json")).toBe(DEFAULT_PANELS);
    expect(parsePanels(JSON.stringify({ chat: { open: "yes", width: "wide" } }))).toEqual(DEFAULT_PANELS);
  });

  it("keeps a stored width within the panel's bounds", () => {
    const panels = parsePanels(JSON.stringify({ chat: { open: true, width: 10 }, side: { open: true, width: 99999 } }));
    expect(panels.chat.width).toBe(PANEL_SIZES.chat.min);
    expect(panels.side.width).toBe(PANEL_SIZES.side.max);
  });
});

describe("plain words", () => {
  it("names scenarios and frames the way a designer would", () => {
    expect(humanize("lantern-held")).toBe("Lantern held");
    expect(frameLabel("lantern-held", "phone")).toBe("Lantern held — phone");
    expect(findingPlace({ rule: "r", kind: "violation", message: "m", file: "pages/booking.tsx", line: 12 })).toBe("pages/booking.tsx, line 12");
  });

  it("leads with the rule's description, its caps written as their values", () => {
    const rule = (id: string, description?: string): RuleReport => ({ rule: id, type: "count", status: "fail", findings: [], ...(description ? { description } : {}) });
    expect(ruleLead(rule("visible-questions", "A page asks at most MAX_VISIBLE_QUESTIONS questions outside a disclosure."), nook)).toBe(`A page asks at most ${nook.inputs.caps.MAX_VISIBLE_QUESTIONS?.value} questions outside a disclosure.`);
    expect(ruleLead(rule("target-size", "Every control meets TARGET_MIN_PX or the WCAG 2.5.8 spacing exception."), nook)).toBe("Every control meets 24 px or the WCAG 2.5.8 spacing exception.");
    expect(ruleLead(rule("no-such-rule"), undefined)).toBe("No such rule");
  });

  it("says a tool call and a check in a line", () => {
    expect(fileWords("pages/booking.tsx")).toBe("the booking page");
    expect(fileWords("layouts/room-cards.json")).toBe("the room cards layout");
    expect(toolSummary({ kind: "tool", id: "t", name: "edit_file", status: "done", title: "Edited pages/rooms.tsx", input: '{"path":"pages/rooms.tsx"}' })).toBe("Changed the rooms page");
    expect(toolSummary({ kind: "tool", id: "t", name: "patch_spec", status: "streaming", title: "Calling patch_spec", input: '{"path":"pages/rooms.json","pat' })).toBe("Writing the rooms page…");
    expect(toolSummary({ kind: "tool", id: "t", name: "write_file", status: "error", title: "write_file: refused", input: '{"path":"data/rooms.ts"}' })).toBe("Could not change the rooms data");
    expect(checksSummary({ kind: "checks", revision: 2, status: "pass", title: "Checks pass", text: "" })).toBe("Checked the rules: all good");
    expect(checksSummary({ kind: "checks", revision: 2, status: "fail", title: "Checks fail: 2 rules", text: "" })).toBe("Checked the rules: 2 things to fix");
  });
});
