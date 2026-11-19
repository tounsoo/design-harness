import { describe, expect, it } from "vitest";
import { nook } from "../../examples/nook/project";
import type { ProjectConfig } from "../config/types";
import { parseProjectConfig } from "../parse";
import type { Result } from "../validate";
import { adopt, approve, decline, dryRunAdoption, propose, revise, sendBack, tryExamples, withExampleSnapshots, type ProposalDraft, type Refusal } from "./lifecycle";
import { ruleTypeIssue } from "./request";
import type { Proposal } from "./types";

const request: ProposalDraft = {
  id: "date-before-rooms",
  title: "The date question comes before the room cards",
  reason: "The designer sent back two variants for putting the rooms before the date.",
  states: [],
  inventory: [],
  rules: { add: [], remove: [] },
  examples: { pass: [], fail: [] },
  needsRuleType: {
    checks: "On a booking page, the date question is drawn above the first room card.",
    whyNot: "No rule type compares the order of two elements on a page: count, containment and slot rules read what is there, not in which order.",
    pass: [{ name: "date-first", description: "The date question, then the room cards." }],
    fail: [{ name: "rooms-first", description: "The room cards, then the date question.", snippet: '{ "type": "RoomCards" }\n```' }],
  },
};

const stamp = { at: "2026-11-19T09:00:00Z", by: "agent" };

function ok<T>(result: Result<T, Refusal>): T {
  if (!result.ok) throw new Error(`refused: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function refusal<T>(result: Result<T, Refusal>): Refusal {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

const filed = (): ProjectConfig => ok(propose(nook, request, stamp));
const proposalOf = (config: ProjectConfig): Proposal => config.proposals.find((item) => item.id === request.id) as Proposal;

describe("a request for a new rule type", () => {
  it("is saved open, with what it checks, why the vocabulary cannot, and its examples", () => {
    const saved = proposalOf(filed());
    expect(saved.status).toBe("open");
    expect(saved.needsRuleType).toEqual(request.needsRuleType);
  });

  it("is refused when it carries an inventory change, a rule or an example prototype, or leaves a field blank", () => {
    const withOp = refusal(propose(nook, { ...request, inventory: [{ op: "add-component", name: "Toast" }] }, stamp));
    expect(withOp.code).toBe("invalid-proposal");
    expect(withOp.message).toMatch(/changes nothing, so it carries no inventory changes/);
    expect(refusal(propose(nook, { ...request, rules: { add: [], remove: ["one-primary-per-page"] } }, stamp)).message).toMatch(/carries no rules/);
    const blank = refusal(propose(nook, { ...request, needsRuleType: { ...request.needsRuleType!, whyNot: "  " } }, stamp));
    expect(blank.message).toMatch(/needsRuleType\.whyNot is blank/);
    expect(refusal(propose(nook, { ...request, needsRuleType: { ...request.needsRuleType!, fail: [] } }, stamp)).message).toMatch(/needsRuleType\.fail/);
  });

  it("can never be approved, tried or adopted, in core's words", () => {
    const config = filed();
    const results: Result<unknown, Refusal>[] = [approve(config, request.id, stamp), dryRunAdoption(config, request.id, stamp), tryExamples(config, request.id), adopt(config, request.id, stamp)];
    for (const result of results) {
      const refused = refusal(result);
      expect(refused.code).toBe("needs-rule-type");
      expect(refused.message).toMatch(/needs a new rule type.*can never become a check without a code change to core/);
    }
    expect(proposalOf(config).status).toBe("open");
  });

  it("is refused by adopt even when a stored config says it is approved", () => {
    const forged = { ...filed() };
    const approvedRequest = { ...proposalOf(forged), status: "approved" as const, history: [...proposalOf(forged).history, { status: "approved" as const, at: "t" }] };
    const config = { ...forged, proposals: [approvedRequest] };
    expect(refusal(adopt(config, request.id, stamp)).code).toBe("needs-rule-type");
    // Nor can one come in through a project file: the schema refuses an approved or adopted request.
    const parsed = parseProjectConfig(JSON.parse(JSON.stringify(config)));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.map((issue) => issue.message).join("\n")).toMatch(/never approved or adopted/);
  });

  it("can be declined, sent back and revised, and a revision can turn it into a proposal", () => {
    const config = filed();
    expect(proposalOf(ok(decline(config, request.id, { at: "t", note: "Filed as an issue." }))).status).toBe("declined");
    const sent = ok(sendBack(config, request.id, { at: "t", note: "Order is expressible as a slot rule." }));
    expect(proposalOf(sent).events?.map((event) => event.kind)).toEqual(["sent-back"]);
    const reworded = ok(revise(config, request.id, { ...request, needsRuleType: { ...request.needsRuleType!, checks: "The date question is above every room card." } }, { at: "t", note: "Said it more exactly." }));
    expect(proposalOf(reworded).needsRuleType?.checks).toBe("The date question is above every room card.");
    // Dropping the request makes it an ordinary proposal again, which still needs examples to be adopted.
    const { needsRuleType: _dropped, ...plain } = request;
    const revised = ok(revise(config, request.id, { ...plain, rules: { add: [], remove: ["visible-questions"] } }, { at: "t", note: "Not a new type after all." }));
    expect(proposalOf(revised).needsRuleType).toBeUndefined();
    expect(proposalOf(revised).events?.[0]).toMatchObject({ kind: "revised", previous: { needsRuleType: request.needsRuleType } });
  });

  it("keeps its examples' measurements out of reach: it has no example prototypes to measure", () => {
    expect(withExampleSnapshots(filed(), request.id, {}).ok).toBe(true);
  });

  it("is written as an issue to file: a title, and a Markdown body with every part of the request", () => {
    const issue = ruleTypeIssue(proposalOf(filed()));
    expect(issue?.title).toBe("New rule type: The date question comes before the room cards");
    expect(issue?.body).toContain("## What the rule should check\n\nOn a booking page, the date question is drawn above the first room card.");
    expect(issue?.body).toContain("## Why the vocabulary cannot express it\n\nNo rule type compares the order");
    expect(issue?.body).toContain("## Must pass\n\n- **date-first**: The date question, then the room cards.");
    // A snippet with backticks of its own is fenced with more.
    expect(issue?.body).toContain('- **rooms-first**: The room cards, then the date question.\n\n  ````\n  { "type": "RoomCards" }\n  ```\n  ````');
    expect(issue?.body).toContain("Proposal `date-before-rooms`, drafted by agent at 2026-11-19T09:00:00Z.");
    expect(ruleTypeIssue(proposalOf(filed()))).toEqual(issue);
  });

  it("is not written for an ordinary proposal", () => {
    const { needsRuleType: _dropped, ...plain } = request;
    expect(ruleTypeIssue({ ...plain, status: "open", history: [{ status: "open", at: "t" }] })).toBeUndefined();
  });
});
