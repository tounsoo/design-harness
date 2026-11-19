import { describe, expect, it } from "vitest";
import type { Proposal } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { seedLegal } from "../../test/nook";
import type { Turn, TurnItem } from "./controller";
import { NO_USAGE } from "./models";
import { ASKS, FIX_TURNS, NOTES, SHARED_WORDS, contentWords, detectPatterns, evidenceLines, fixedIn, patternMessage, patternSummary, suggestion, type LoopEvent } from "./patterns";

const legal = seedLegal();
const checks = (failing: string[], notRun: string[] = []): TurnItem => ({ kind: "checks", revision: 2, status: failing.length > 0 ? "fail" : "pass", title: "", text: "", failing, notRun });

function turn(id: string, at: string, items: TurnItem[], extra: Partial<Turn> = {}): Turn {
  return { id, text: `message ${id}`, at, settings: { model: "claude-opus-5-5", effort: "medium" }, items, end: { status: "done" }, usage: NO_USAGE, cost: 0, rounds: 1, before: legal, undone: false, ...extra };
}

/** A turn in which the agent broke `rule` and then fixed it. */
const fixing = (id: string, at: string, rule = "one-primary-per-page") => turn(id, at, [checks([rule]), checks([])]);

const ask = (at: string, rule = "one-primary-per-page"): LoopEvent => ({ kind: "fix-asked", at, rule });
const rejected = (at: string, note: string, variant = "b"): LoopEvent => ({ kind: "variant-rejected", at, page: "booking", variant, note });

function sentBack(id: string, notes: [string, string][]): Proposal {
  return {
    id,
    title: id,
    reason: "r",
    states: [],
    inventory: [],
    rules: { add: [], remove: [] },
    examples: { pass: [], fail: [] },
    status: "open",
    history: [{ status: "open", at: "2026-11-19T08:00:00Z" }],
    events: notes.map(([at, note]) => ({ kind: "sent-back" as const, at, note })),
  };
}

const detect = (turns: Turn[], log: LoopEvent[] = [], proposals: Proposal[] = []) => detectPatterns({ turns, log, proposals });

describe("what a turn fixed", () => {
  it("is a rule that failed at a check, or at the start, and passed at the turn's last check", () => {
    expect(fixedIn(fixing("t1", "2026-11-19T09:00:00Z"))).toEqual(["one-primary-per-page"]);
    expect(fixedIn(turn("t2", "t", [checks([])], { failingAtStart: ["visible-questions"] }))).toEqual(["visible-questions"]);
  });

  it("is nothing for a rule still failing, or one the last check could not run", () => {
    expect(fixedIn(turn("t", "t", [checks(["one-primary-per-page"]), checks(["one-primary-per-page"])]))).toEqual([]);
    expect(fixedIn(turn("t", "t", [checks(["target-size"]), checks([], ["target-size"])]))).toEqual([]);
  });

  it("is nothing in a turn that was undone, changed nothing, or has no checks the loop can read", () => {
    expect(fixedIn({ ...fixing("t", "t"), undone: true })).toEqual([]);
    expect(fixedIn({ ...fixing("t", "t"), before: null })).toEqual([]);
    expect(fixedIn(turn("t", "t", [{ kind: "checks", revision: 2, status: "pass", title: "", text: "" }], { failingAtStart: ["x"] }))).toEqual([]);
  });
});

describe("a fixed rule", () => {
  it(`is a pattern once the agent fixed it in ${FIX_TURNS} separate turns`, () => {
    const [pattern] = detect([fixing("t1", "2026-11-19T09:00:00Z"), turn("t2", "2026-11-19T09:05:00Z", [checks([])]), fixing("t3", "2026-11-19T09:10:00Z")]);
    expect(pattern).toMatchObject({ kind: "rule", key: "rule:one-primary-per-page", evidence: 2, last: "2026-11-19T09:10:00Z" });
    expect(pattern?.kind === "rule" && pattern.fixes.map((fix) => fix.turn)).toEqual(["t1", "t3"]);
  });

  it("is no pattern after a single fix, nor when one of two fixes was undone", () => {
    expect(detect([fixing("t1", "2026-11-19T09:00:00Z")])).toEqual([]);
    expect(detect([fixing("t1", "2026-11-19T09:00:00Z"), { ...fixing("t2", "2026-11-19T09:10:00Z"), undone: true }])).toEqual([]);
  });

  it("counts each rule on its own: two different rules fixed once each are no pattern", () => {
    expect(detect([fixing("t1", "2026-11-19T09:00:00Z", "one-primary-per-page"), fixing("t2", "2026-11-19T09:10:00Z", "visible-questions")])).toEqual([]);
  });
});

describe("an asked fix", () => {
  const turns = [turn("t1", "2026-11-19T09:01:00Z", []), turn("t2", "2026-11-19T09:11:00Z", [])].map((item) => ({ ...item, before: null }));

  it(`is a pattern after ${ASKS} presses for one rule with a message sent between them`, () => {
    const [pattern] = detect(turns, [ask("2026-11-19T09:00:00Z"), ask("2026-11-19T09:10:00Z")]);
    expect(pattern).toMatchObject({ kind: "rule", rules: ["one-primary-per-page"], asks: ["2026-11-19T09:00:00Z", "2026-11-19T09:10:00Z"], evidence: 2 });
  });

  it("is no pattern after one press, nor after presses with no message between them", () => {
    expect(detect(turns, [ask("2026-11-19T09:00:00Z")])).toEqual([]);
    expect(detect(turns, [ask("2026-11-19T09:00:00Z"), ask("2026-11-19T09:00:30Z")])).toEqual([]);
  });

  it("joins the fixes of the same rule in one pattern", () => {
    const patterns = detect([fixing("t1", "2026-11-19T09:01:00Z"), fixing("t2", "2026-11-19T09:11:00Z")], [ask("2026-11-19T09:00:00Z")]);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toMatchObject({ evidence: 3 });
  });
});

describe("repeated notes", () => {
  it("are content words: four letters or more, a trailing s dropped, common words out", () => {
    expect(contentWords("Put the dates BEFORE the rooms, please; the date question first.")).toEqual(["date", "first", "question", "room"]);
    expect(SHARED_WORDS).toBe(2);
  });

  it(`are a pattern when ${NOTES} notes from separate events share ${SHARED_WORDS} content words`, () => {
    const proposals = [sentBack("toast", [["2026-11-19T09:20:00Z", "The date question has to come first, above the rooms."]])];
    const [pattern] = detect([], [rejected("2026-11-19T09:00:00Z", "Rooms before the date question again; ask the date first.")], proposals);
    expect(pattern).toMatchObject({ kind: "notes", key: "notes:date first question room", evidence: 2 });
    expect(pattern && evidenceLines(pattern)).toEqual([
      '2026-11-19T09:00:00Z, rejecting variant B of page "booking": "Rooms before the date question again; ask the date first."',
      '2026-11-19T09:20:00Z, sending back proposal "toast": "The date question has to come first, above the rooms."',
    ]);
  });

  it("are no pattern for a single note, notes sharing one word, or a rejection without a note", () => {
    expect(detect([], [rejected("t1", "The date question should come first.")])).toEqual([]);
    expect(detect([], [rejected("t1", "The date question should come first."), rejected("t2", "Bigger photos of each room.", "c")])).toEqual([]);
    expect(detect([], [rejected("t1", "The date question should come first."), rejected("t2", "", "c")])).toEqual([]);
  });

  it("gather every note that holds the shared words, and leave out a group inside a larger one", () => {
    const log = [rejected("t1", "date question first please"), rejected("t2", "the date question goes first", "c"), rejected("t3", "date question on top", "d")];
    const patterns = detect([], log);
    expect(patterns.map((pattern) => [pattern.key, pattern.evidence])).toEqual([["notes:date question", 3]]);
  });
});

describe("the suggestion", () => {
  const twoFixes = [fixing("t1", "2026-11-19T09:00:00Z"), fixing("t2", "2026-11-19T09:10:00Z")];

  it("is the newest pattern, and stays quiet once answered until there is more evidence", () => {
    const [pattern] = detect(twoFixes);
    expect(suggestion(detect(twoFixes), [])?.key).toBe("rule:one-primary-per-page");
    const answered: LoopEvent[] = [{ kind: "suggestion", at: "t", key: pattern?.key ?? "", answer: "dismissed", evidence: 2 }];
    expect(suggestion(detect(twoFixes), answered)).toBeUndefined();
    const more = [...twoFixes, fixing("t3", "2026-11-19T09:20:00Z")];
    expect(suggestion(detect(more), answered)?.evidence).toBe(3);
  });

  it("says what it noticed, and its message names the rule, the turns and what to propose", () => {
    const [pattern] = detect(twoFixes, [ask("2026-11-19T08:59:00Z")]);
    if (!pattern) throw new Error("no pattern");
    expect(patternSummary(pattern)).toBe('The agent fixed "one-primary-per-page" in 2 separate turns, and you asked it to fix it once.');
    const message = patternMessage(pattern, nook);
    expect(message).toContain('This keeps coming up with the rule "one-primary-per-page". "one-primary-per-page" says: Each page holds at most 1 primary action.');
    expect(message).toContain('- 2026-11-19T09:00:00Z, turn "message t1": "one-primary-per-page" failed, and passed by the turn\'s end.');
    expect(message).toContain('- 2026-11-19T08:59:00Z: "Ask the agent to fix" pressed for "one-primary-per-page".');
    expect(message).toMatch(/draft_proposal .*passing and failing examples .*needs_rule_type/s);
  });

  it("gives the same patterns for the same history, whatever order the turns' rules come in", () => {
    const a = detect([turn("t1", "2026-11-19T09:00:00Z", [checks(["b-rule", "a-rule"]), checks([])]), turn("t2", "2026-11-19T09:10:00Z", [checks(["a-rule", "b-rule"]), checks([])])]);
    expect(a.map((pattern) => pattern.key)).toEqual(["rule:a-rule+b-rule"]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(detect([turn("t1", "2026-11-19T09:00:00Z", [checks(["a-rule", "b-rule"]), checks([])]), turn("t2", "2026-11-19T09:10:00Z", [checks(["b-rule", "a-rule"]), checks([])])])));
  });

  it("makes rules fixed in exactly the same turns one pattern, and an answer about them answers each of them", () => {
    const both = (id: string, at: string) => turn(id, at, [checks(["one-primary-per-page", "primary-is-rank-1"]), checks([])]);
    const turns = [both("t1", "2026-11-19T09:00:00Z"), both("t2", "2026-11-19T09:10:00Z")];
    const [pattern, ...rest] = detect(turns);
    expect(rest).toEqual([]);
    expect(pattern).toMatchObject({ key: "rule:one-primary-per-page+primary-is-rank-1", rules: ["one-primary-per-page", "primary-is-rank-1"], evidence: 2 });
    if (!pattern) throw new Error("no pattern");
    expect(patternSummary(pattern)).toBe('The agent fixed "one-primary-per-page" and "primary-is-rank-1" in 2 separate turns.');
    // A third turn fixes only one of them: the groups split, and the answer about both still covers each at its evidence.
    const answered: LoopEvent[] = [{ kind: "suggestion", at: "t", key: pattern.key, answer: "accepted", evidence: 2 }];
    const split = detect([...turns, fixing("t3", "2026-11-19T09:20:00Z")]);
    expect(split.map((item) => [item.key, item.evidence])).toEqual([["rule:one-primary-per-page", 3], ["rule:primary-is-rank-1", 2]]);
    expect(suggestion(split, answered)?.key).toBe("rule:one-primary-per-page");
    expect(suggestion(split.slice(1), answered)).toBeUndefined();
  });
});
