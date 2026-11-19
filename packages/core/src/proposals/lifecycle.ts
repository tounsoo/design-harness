import { configReferenceIssues } from "../config/references";
import type { ProjectConfig } from "../config/types";
import { checkPrototype } from "../engine/check";
import { compareStrings, type CheckReport, type Finding } from "../engine/report";
import { prototypeIssues } from "../parse";
import type { Prototype } from "../prototype/types";
import { snapshotSchema } from "../rendered/schema";
import type { RenderedSnapshot } from "../rendered/types";
import { run, type Result } from "../validate";
import { applyProposal } from "./apply";
import { classifyProposal, type Classification } from "./classify";
import { proposalSchema } from "./schema";
import type { FailingExample, PassingExample, Proposal, ProposalContent, ProposalStatus } from "./types";

export type RefusalCode =
  | "invalid-proposal"
  | "duplicate-id"
  | "not-found"
  | "wrong-status"
  | "changes-nothing"
  | "cannot-apply"
  | "invalid-config"
  | "missing-examples"
  | "unknown-rule"
  | "unproven-rule"
  | "passing-example-fails"
  | "failing-example-passes"
  | "fails-for-another-reason"
  | "breaks-adopted-example"
  | "unchanged"
  | "missing-note"
  | "incomplete-measurement"
  | "needs-rule-type";

/**
 * Why a step was refused, precisely enough to fix: which example, and what
 * happened instead. `proposal` names an earlier adopted proposal when the
 * example is one of its examples rather than the refused proposal's own.
 */
export type Refusal = { readonly code: RefusalCode; readonly message: string; readonly proposal?: string; readonly example?: string; readonly findings?: readonly Finding[] };

export type Stamp = { readonly at: string; readonly by?: string; readonly note?: string };

/** What a proposal is written as: everything but its status and history, which the lifecycle owns. */
export type ProposalDraft = Omit<Proposal, "status" | "history">;

const NEXT: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  open: ["approved", "declined"],
  approved: ["adopted", "declined"],
  adopted: [],
  declined: [],
};

function refuse<T>(code: RefusalCode, message: string, extra: Omit<Refusal, "code" | "message"> = {}): Result<T, Refusal> {
  return { ok: false, error: { code, message, ...extra } };
}

function stamped(proposal: Proposal, status: ProposalStatus, stamp: Stamp): Proposal {
  return { ...proposal, status, history: [...proposal.history, { status, ...stamp }] };
}

function replace(config: ProjectConfig, proposal: Proposal): ProjectConfig {
  return { ...config, proposals: config.proposals.map((item) => (item.id === proposal.id ? proposal : item)) };
}

/** A proposal's content: what a revision replaces and keeps as the previous version. */
export function contentOf(proposal: ProposalContent): ProposalContent {
  const { title, reason, states, inventory, rules, examples, needsRuleType } = proposal;
  return { title, reason, states, inventory, rules, examples, ...(needsRuleType !== undefined ? { needsRuleType } : {}) };
}

/** Why a request for a new rule type goes no further than open, in the words every refusal of one uses. */
function requestRefusal<T>(proposal: Proposal, step: string): Result<T, Refusal> {
  return refuse(
    "needs-rule-type",
    `proposal "${proposal.id}" needs a new rule type, which core's rule vocabulary does not have: it cannot be ${step}, and can never become a check without a code change to core. File it as a request, then decline it or send it back.`,
  );
}

/**
 * What a request for a new rule type may not carry: it changes nothing, so
 * there is no inventory change, rule or example prototype for adoption to
 * prove. Its examples are the request's own, in words.
 */
function requestIssue(proposal: ProposalContent): string | null {
  if (!proposal.needsRuleType) return null;
  const carried = [
    proposal.inventory.length > 0 ? "inventory changes" : null,
    proposal.rules.add.length > 0 || proposal.rules.remove.length > 0 ? "rules" : null,
    proposal.examples.pass.length > 0 || proposal.examples.fail.length > 0 ? "example prototypes" : null,
  ].filter((item): item is string => item !== null);
  const blank = (["checks", "whyNot"] as const).find((field) => proposal.needsRuleType?.[field].trim() === "");
  if (blank) return `needsRuleType.${blank} is blank; a request says what the rule should check and why the vocabulary cannot say it`;
  if (carried.length === 0) return null;
  return `a request for a new rule type changes nothing, so it carries no ${carried.join(", ")}; draft those as a proposal of their own, and give the request's examples in words under needsRuleType`;
}

/** Validates a whole proposal: its shape, unique example names, and every example a valid prototype. */
function checkedProposal(proposal: Proposal): Result<Proposal, Refusal> {
  const checked = run(proposalSchema, proposal, "proposal");
  if (!checked.ok) return refuse("invalid-proposal", checked.error.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
  const names = [...proposal.examples.pass, ...proposal.examples.fail].map((example) => example.name);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined) return refuse("invalid-proposal", `two examples are named "${repeated}"; each example needs its own name`, { example: repeated });
  const request = requestIssue(proposal);
  if (request !== null) return refuse("invalid-proposal", request);
  for (const example of [...proposal.examples.pass, ...proposal.examples.fail]) {
    const issues = prototypeIssues(example.prototype, `example "${example.name}"`);
    if (issues.length > 0) return refuse("invalid-proposal", issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"), { example: example.name });
  }
  return { ok: true, value: checked.value };
}

/** Adds a proposal to the config as `open`. Time and who are the caller's. */
export function propose(config: ProjectConfig, draft: ProposalDraft, stamp: Stamp): Result<ProjectConfig, Refusal> {
  const checked = checkedProposal({ ...draft, status: "open", history: [{ status: "open", ...stamp }] });
  if (!checked.ok) return checked;
  if (config.proposals.some((item) => item.id === draft.id)) return refuse("duplicate-id", `a proposal "${draft.id}" already exists`);
  return { ok: true, value: { ...config, proposals: [...config.proposals, checked.value] } };
}

/**
 * Replaces an open proposal's content with a new draft of the same id. The
 * status stays open and the status history is kept; the content it replaces
 * is kept too, as a `revised` event with the stamp's time, who and note, so
 * every version stays readable. Only an open proposal can be revised: once
 * approved, what was approved is what is adopted.
 */
export function revise(config: ProjectConfig, id: string, draft: ProposalDraft, stamp: Stamp): Result<ProjectConfig, Refusal> {
  const proposal = config.proposals.find((item) => item.id === id);
  if (!proposal) return refuse("not-found", `there is no proposal "${id}"`);
  if (proposal.status !== "open") return refuse("wrong-status", `proposal "${id}" is ${proposal.status}; only an open proposal can be revised`);
  if (draft.id !== id) return refuse("invalid-proposal", `the revision names proposal "${draft.id}", not "${id}"; a revision keeps its proposal's id`);
  // The draft's content replaces the proposal's whole, a request for a new rule type included: a revision may drop one or add one.
  const { needsRuleType: _replaced, ...kept } = proposal;
  const checked = checkedProposal({ ...kept, ...contentOf(draft), events: [...(proposal.events ?? []), { kind: "revised", ...stamp, previous: contentOf(proposal) }] });
  if (!checked.ok) return checked;
  // Both sides as the schema writes them, so key order in the draft cannot make an unchanged revision look new.
  if (JSON.stringify(contentOf(checked.value)) === JSON.stringify(contentOf(proposal))) return refuse("unchanged", `the revision of "${id}" says exactly what it said before`);
  return { ok: true, value: replace(config, checked.value) };
}

/**
 * Records that a reviewer sent an open proposal back for a revision, with a
 * note saying what to change. The status does not change; the note is kept
 * as a `sent-back` event. The note is required: a send-back without one
 * gives the author nothing to act on.
 */
export function sendBack(config: ProjectConfig, id: string, stamp: Stamp): Result<ProjectConfig, Refusal> {
  const proposal = config.proposals.find((item) => item.id === id);
  if (!proposal) return refuse("not-found", `there is no proposal "${id}"`);
  if (proposal.status !== "open") return refuse("wrong-status", `proposal "${id}" is ${proposal.status}; only an open proposal can be sent back for a revision`);
  const note = stamp.note?.trim() ?? "";
  if (note === "") return refuse("missing-note", `sending "${id}" back needs a note that says what to change`);
  const event = { kind: "sent-back" as const, at: stamp.at, ...(stamp.by !== undefined ? { by: stamp.by } : {}), note };
  return { ok: true, value: replace(config, { ...proposal, events: [...(proposal.events ?? []), event] }) };
}

/**
 * Stores measured snapshots with each of an open or approved proposal's
 * examples, so its rendered rules can run on them and an adopted proposal's
 * examples re-run later with the measurements it was adopted on. Every
 * example must be measured, at exactly one snapshot per scenario of the
 * example and view of the config: a partial measurement is refused, never
 * stored, so adoption cannot run on one. Snapshots are validated with core's
 * snapshot schema.
 */
export function withExampleSnapshots(config: ProjectConfig, id: string, measured: Readonly<Record<string, readonly RenderedSnapshot[]>>): Result<ProjectConfig, Refusal> {
  const proposal = config.proposals.find((item) => item.id === id);
  if (!proposal) return refuse("not-found", `there is no proposal "${id}"`);
  if (proposal.status !== "open" && proposal.status !== "approved") return refuse("wrong-status", `proposal "${id}" is ${proposal.status}; its examples' measurements can no longer change`);
  const names = new Set([...proposal.examples.pass, ...proposal.examples.fail].map((example) => example.name));
  const unknown = Object.keys(measured).filter((name) => !names.has(name)).sort(compareStrings)[0];
  if (unknown !== undefined) return refuse("incomplete-measurement", `snapshots are given for "${unknown}", which is not an example of "${id}"`, { example: unknown });
  const measure = <T extends PassingExample>(example: T): Result<T, Refusal> => {
    const given = measured[example.name];
    if (given === undefined) return refuse("incomplete-measurement", `example "${example.name}" is not measured`, { example: example.name });
    const snapshots: RenderedSnapshot[] = [];
    for (const [index, snapshot] of given.entries()) {
      const valid = run(snapshotSchema, snapshot, `example "${example.name}" snapshot ${index + 1}`);
      if (!valid.ok) return refuse("incomplete-measurement", valid.error.map((issue) => `${issue.path}: ${issue.message}`).join("\n"), { example: example.name });
      snapshots.push(valid.value);
    }
    for (const scenario of example.prototype.scenarios) {
      for (const view of config.views) {
        const count = snapshots.filter((snapshot) => snapshot.scenario === scenario.id && snapshot.view === view.name).length;
        if (count !== 1) {
          return refuse("incomplete-measurement", `example "${example.name}" has ${count === 0 ? "no snapshot" : `${count} snapshots`} of scenario "${scenario.id}" at view "${view.name}"; it needs exactly one`, { example: example.name });
        }
      }
    }
    const extra = snapshots.find((snapshot) => !example.prototype.scenarios.some((scenario) => scenario.id === snapshot.scenario) || !config.views.some((view) => view.name === snapshot.view));
    if (extra) return refuse("incomplete-measurement", `example "${example.name}" has a snapshot of scenario "${extra.scenario}" at view "${extra.view}", which it does not render`, { example: example.name });
    return { ok: true, value: { ...example, snapshots } };
  };
  const pass: PassingExample[] = [];
  for (const example of proposal.examples.pass) {
    const result = measure(example);
    if (!result.ok) return result;
    pass.push(result.value);
  }
  const fail: FailingExample[] = [];
  for (const example of proposal.examples.fail) {
    const result = measure(example);
    if (!result.ok) return result;
    fail.push(result.value);
  }
  return { ok: true, value: replace(config, { ...proposal, examples: { pass, fail } }) };
}

function move(config: ProjectConfig, id: string, to: ProposalStatus, stamp: Stamp): Result<ProjectConfig, Refusal> {
  const proposal = config.proposals.find((item) => item.id === id);
  if (!proposal) return refuse("not-found", `there is no proposal "${id}"`);
  if (!NEXT[proposal.status].includes(to)) {
    const allowed = NEXT[proposal.status];
    return refuse("wrong-status", `proposal "${id}" is ${proposal.status}; ${allowed.length === 0 ? "it cannot change any more" : `it can only become ${allowed.join(" or ")}`}, not ${to}`);
  }
  return { ok: true, value: replace(config, stamped(proposal, to, stamp)) };
}

/** Approves an open proposal. A request for a new rule type is refused: approval is the step before adoption, which it can never reach. */
export function approve(config: ProjectConfig, id: string, stamp: Stamp): Result<ProjectConfig, Refusal> {
  const proposal = config.proposals.find((item) => item.id === id);
  if (proposal?.needsRuleType) return requestRefusal(proposal, "approved");
  return move(config, id, "approved", stamp);
}

export function decline(config: ProjectConfig, id: string, stamp: Stamp): Result<ProjectConfig, Refusal> {
  return move(config, id, "declined", stamp);
}

/** A prototype the caller already has, to see which would newly fail once the proposal is adopted. */
export type ExistingPrototype = { readonly name: string; readonly prototype: Prototype; readonly snapshots?: readonly RenderedSnapshot[] };

export type NewlyFailing = { readonly name: string; readonly rules: readonly string[]; readonly findings: readonly Finding[] };

export type ExampleRun = {
  readonly proposal: string;
  readonly example: string;
  readonly expect: "pass" | "fail";
  readonly ok: boolean;
  readonly detail: string;
  /**
   * Set on a failing example whose rule is no longer in force because an
   * adopted proposal removed it: the example has nothing left to prove, so it
   * is retired rather than broken, and `ok` is true.
   */
  readonly retiredBy?: string;
};

export type Adoption = {
  readonly config: ProjectConfig;
  readonly classification: Classification;
  /** Caller-supplied prototypes that fail a rule, or carry a finding, they did not before. */
  readonly newlyFailing: readonly NewlyFailing[];
  /**
   * Failing examples of earlier adopted proposals that this proposal retires:
   * it removes the rule they exist to prove. Any other earlier example that
   * stops behaving as it did makes `adopt` refuse.
   */
  readonly retiredExamples: readonly ExampleRun[];
};

function checkExample(config: ProjectConfig, example: PassingExample): CheckReport {
  return checkPrototype({ config, prototype: example.prototype, ...(example.snapshots ? { snapshots: example.snapshots } : {}) });
}

function quote(findings: readonly Finding[], limit = 3): string {
  const shown = findings.slice(0, limit).map((finding) => `${finding.rule}: ${finding.message}`);
  return shown.join(" | ") + (findings.length > limit ? ` (and ${findings.length - limit} more)` : "");
}

/** Whether a failing example is flagged by its rule, with the message it names. */
function flagged(report: CheckReport, example: FailingExample): { ok: true } | { ok: false; detail: string } {
  const { rule, message } = example.flaggedBy;
  const result = report.rules.find((item) => item.rule === rule);
  if (!result) return { ok: false, detail: `rule "${rule}" is not in force` };
  if (result.status === "not-run") return { ok: false, detail: `"${rule}" did not run: ${result.note ?? "no reason given"}` };
  if (result.status === "pass") return { ok: false, detail: `"${rule}" passed it` };
  if (message !== undefined && !result.findings.some((finding) => finding.message.includes(message))) {
    return { ok: false, detail: `"${rule}" flagged it, but no finding says "${message}"; it said: ${quote(result.findings)}` };
  }
  return { ok: true };
}

/**
 * One example of a proposal judged against the config with the proposal
 * applied: what `adopt` holds it to, and what happened. `refusal` is the
 * refusal `adopt` gives for this example when it does not behave, word for
 * word; `report` is core's whole report on it.
 */
export type ExampleResult = {
  readonly example: string;
  readonly expect: "pass" | "fail";
  readonly ok: boolean;
  readonly detail: string;
  readonly refusal?: Refusal;
  readonly report: CheckReport;
};

/** Every example of a proposal against `candidate` (the config with it applied): passing examples first, then failing, each in the proposal's order. */
function judgeExamples(candidate: ProjectConfig, proposal: Proposal): ExampleResult[] {
  const added = new Set(proposal.rules.add.map((rule) => rule.id));
  const results: ExampleResult[] = [];
  for (const example of proposal.examples.pass) {
    const report = checkExample(candidate, example);
    const base = { example: example.name, expect: "pass" as const, report };
    const failed = report.rules.filter((rule) => rule.status === "fail");
    if (failed.length > 0) {
      const findings = failed.flatMap((rule) => rule.findings);
      const message = `passing example "${example.name}" fails ${failed.map((rule) => `"${rule.rule}"`).join(", ")}: ${quote(findings)}`;
      results.push({ ...base, ok: false, detail: message, refusal: { code: "passing-example-fails", message, example: example.name, findings } });
      continue;
    }
    const unrun = report.rules.find((rule) => added.has(rule.rule) && rule.status === "not-run");
    if (unrun) {
      const message = `passing example "${example.name}" does not run the new rule "${unrun.rule}": ${unrun.note ?? "no reason given"}`;
      results.push({ ...base, ok: false, detail: message, refusal: { code: "unproven-rule", message, example: example.name } });
      continue;
    }
    results.push({ ...base, ok: true, detail: added.size > 0 ? "passes every rule in force, the new rules included" : "passes every rule in force" });
  }
  for (const example of proposal.examples.fail) {
    const report = checkExample(candidate, example);
    const base = { example: example.name, expect: "fail" as const, report };
    const result = flagged(report, example);
    if (!result.ok) {
      const ruleReport = report.rules.find((rule) => rule.rule === example.flaggedBy.rule);
      const message = `failing example "${example.name}" is not flagged as it must be: ${result.detail}`;
      results.push({ ...base, ok: false, detail: message, refusal: { code: "failing-example-passes", message, example: example.name, findings: ruleReport?.findings ?? [] } });
      continue;
    }
    const others = report.rules.filter((rule) => rule.status === "fail" && rule.rule !== example.flaggedBy.rule);
    if (others.length > 0) {
      const findings = others.flatMap((rule) => rule.findings);
      const message = `failing example "${example.name}" must fail for "${example.flaggedBy.rule}" alone, but it also fails ${others.map((rule) => `"${rule.rule}"`).join(", ")}: ${quote(findings)}`;
      results.push({ ...base, ok: false, detail: message, refusal: { code: "fails-for-another-reason", message, example: example.name, findings } });
      continue;
    }
    results.push({ ...base, ok: true, detail: `flagged by "${example.flaggedBy.rule}" and no other rule` });
  }
  return results;
}

/** The config with an open or approved proposal applied and still valid, or why not: the part of `adopt` that comes before its examples. */
function candidateFor(config: ProjectConfig, proposal: Proposal): Result<ProjectConfig, Refusal> {
  const applied = applyProposal(config, proposal);
  if (!applied.ok) return refuse("cannot-apply", `proposal "${proposal.id}" cannot apply: ${applied.error}`);
  const issues = configReferenceIssues(applied.value);
  if (issues.length > 0) return refuse("invalid-config", `adopting "${proposal.id}" would leave the config invalid: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  return applied;
}

/**
 * Judges every example of an open or approved proposal on its own, as
 * `adopt` would, without stopping at the first that does not behave: the
 * config with the proposal applied, and per example whether it behaves and
 * core's words for what happened. Examples use the snapshots stored with
 * them (`withExampleSnapshots`); without them rendered rules do not run.
 */
export function tryExamples(config: ProjectConfig, id: string): Result<{ readonly config: ProjectConfig; readonly results: readonly ExampleResult[] }, Refusal> {
  const proposal = config.proposals.find((item) => item.id === id);
  if (!proposal) return refuse("not-found", `there is no proposal "${id}"`);
  if (proposal.status !== "open" && proposal.status !== "approved") return refuse("wrong-status", `proposal "${id}" is ${proposal.status}; only an open or approved proposal's examples are tried this way, and an adopted one's are re-run with rerunExamples`);
  if (proposal.needsRuleType) return requestRefusal(proposal, "tried as a check");
  const candidate = candidateFor(config, proposal);
  if (!candidate.ok) return candidate;
  return { ok: true, value: { config: candidate.value, results: judgeExamples(candidate.value, proposal) } };
}

/**
 * Adopts an approved proposal: applies its changes and puts its rules in
 * force, but only once its examples prove the rules. Every passing example
 * must pass every rule of the new config; every failing example must fail
 * the rule it names, with the message it names, and no other rule; and every
 * rule the proposal adds must be named by a failing example, so each is
 * shown to fire. Every example of an earlier adopted proposal must still
 * behave as it did, unless the proposal removes the rule a failing example
 * exists to prove, which retires that example. The adopted proposal keeps
 * its classification. Pure: time and who are the caller's.
 */
export function adopt(config: ProjectConfig, id: string, stamp: Stamp, existing: readonly ExistingPrototype[] = []): Result<Adoption, Refusal> {
  const proposal = config.proposals.find((item) => item.id === id);
  if (!proposal) return refuse("not-found", `there is no proposal "${id}"`);
  // Before anything else: no state of a request for a new rule type, however it got there, is adoptable.
  if (proposal.needsRuleType) return requestRefusal(proposal, "adopted");
  if (proposal.status !== "approved") {
    return refuse("wrong-status", `proposal "${id}" is ${proposal.status}; ${proposal.status === "open" ? "it must be approved before it is adopted" : "only an approved proposal can be adopted"}`);
  }
  if (proposal.inventory.length === 0 && proposal.rules.add.length === 0 && proposal.rules.remove.length === 0) {
    return refuse("changes-nothing", `proposal "${id}" changes no inventory and no rule`);
  }
  const applied = candidateFor(config, proposal);
  if (!applied.ok) return applied;
  const candidate = applied.value;

  const { pass, fail } = proposal.examples;
  if (pass.length === 0 || fail.length === 0) {
    return refuse("missing-examples", `proposal "${id}" needs at least one passing and one failing example; it has ${pass.length} passing and ${fail.length} failing`);
  }
  const ruleIds = new Set(candidate.rules.map((rule) => rule.id));
  for (const example of fail) {
    if (!ruleIds.has(example.flaggedBy.rule)) {
      return refuse("unknown-rule", `failing example "${example.name}" names rule "${example.flaggedBy.rule}", which is not in force once "${id}" is adopted`, { example: example.name });
    }
  }
  for (const rule of proposal.rules.add) {
    if (!fail.some((example) => example.flaggedBy.rule === rule.id)) {
      return refuse("unproven-rule", `rule "${rule.id}" has no failing example that names it, so nothing shows it fires`);
    }
  }
  const misbehaving = judgeExamples(candidate, proposal).find((result) => !result.ok);
  if (misbehaving?.refusal) return { ok: false, error: misbehaving.refusal };

  const classification = classifyProposal(proposal, config);
  const adopted = replace(candidate, { ...stamped(proposal, "adopted", stamp), classification });
  const earlier = rerunExamples(adopted).filter((item) => item.proposal !== id);
  const broken = earlier.find((item) => !item.ok);
  if (broken) {
    return refuse(
      "breaks-adopted-example",
      `adopting "${id}" breaks ${broken.expect === "pass" ? "passing" : "failing"} example "${broken.example}" of adopted proposal "${broken.proposal}": ${broken.detail}`,
      { proposal: broken.proposal, example: broken.example },
    );
  }
  const newlyFailing = newlyFailingOf(config, adopted, existing);
  const retiredExamples = earlier.filter((item) => item.retiredBy === id);
  return { ok: true, value: { config: adopted, classification, newlyFailing, retiredExamples } };
}

/**
 * The caller's prototypes that fail a rule under `after` that they did not
 * fail under `before`, or carry a finding they did not carry, in name order:
 * what `adopt` reports as newly failing, for any two configs, such as the
 * config before a proposal and the config with it applied.
 */
export function newlyFailingOf(before: ProjectConfig, after: ProjectConfig, existing: readonly ExistingPrototype[]): NewlyFailing[] {
  const out: NewlyFailing[] = [];
  for (const item of [...existing].sort((a, b) => compareStrings(a.name, b.name))) {
    const snapshots = item.snapshots ? { snapshots: item.snapshots } : {};
    const was = checkPrototype({ config: before, prototype: item.prototype, ...snapshots });
    const now = checkPrototype({ config: after, prototype: item.prototype, ...snapshots });
    const failedBefore = new Set(was.rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule));
    const known = new Set(was.findings.map((finding) => JSON.stringify(finding)));
    const rules = now.rules.filter((rule) => rule.status === "fail" && !failedBefore.has(rule.rule)).map((rule) => rule.rule);
    const findings = now.findings.filter((finding) => !known.has(JSON.stringify(finding)));
    if (rules.length > 0 || findings.length > 0) out.push({ name: item.name, rules, findings });
  }
  return out;
}

/**
 * What adopting a proposal would do, changing nothing: an open proposal is
 * approved in memory and `adopt` runs on that copy, so the result is
 * `adopt`'s, refusal reasons included. The config passed in is returned
 * untouched by the caller; only `adopt` or the lifecycle steps change it.
 */
export function dryRunAdoption(config: ProjectConfig, id: string, stamp: Stamp, existing: readonly ExistingPrototype[] = []): Result<Adoption, Refusal> {
  const proposal = config.proposals.find((item) => item.id === id);
  if (!proposal) return refuse("not-found", `there is no proposal "${id}"`);
  if (proposal.status !== "open" && proposal.status !== "approved") return refuse("wrong-status", `proposal "${id}" is ${proposal.status}; only an open or approved proposal can be tried`);
  const approved = proposal.status === "open" ? approve(config, id, stamp) : { ok: true as const, value: config };
  if (!approved.ok) return approved;
  return adopt(approved.value, id, stamp, existing);
}

/**
 * Re-runs every adopted proposal's examples against the config as it is now:
 * passing examples must still pass every rule, and failing examples must
 * still be flagged by their rule. Later rules may add other reasons to fail,
 * so a failing example is not held to failing for its rule alone here. A
 * failing example whose rule is not in force because an adopted proposal
 * removed it is retired: `ok`, with `retiredBy` naming that proposal.
 */
export function rerunExamples(config: ProjectConfig): ExampleRun[] {
  const runs: ExampleRun[] = [];
  const adopted = config.proposals.filter((proposal) => proposal.status === "adopted").sort((a, b) => compareStrings(a.id, b.id));
  const inForce = new Set(config.rules.map((rule) => rule.id));
  const removedBy = (rule: string, owner: string): string | undefined =>
    inForce.has(rule) ? undefined : adopted.find((proposal) => proposal.id !== owner && proposal.rules.remove.includes(rule))?.id;
  for (const proposal of adopted) {
    for (const example of [...proposal.examples.pass].sort((a, b) => compareStrings(a.name, b.name))) {
      const failed = checkExample(config, example).rules.filter((rule) => rule.status === "fail");
      runs.push({
        proposal: proposal.id,
        example: example.name,
        expect: "pass",
        ok: failed.length === 0,
        detail: failed.length === 0 ? "passes every rule" : `fails ${quote(failed.flatMap((rule) => rule.findings))}`,
      });
    }
    for (const example of [...proposal.examples.fail].sort((a, b) => compareStrings(a.name, b.name))) {
      const retiredBy = removedBy(example.flaggedBy.rule, proposal.id);
      if (retiredBy !== undefined) {
        runs.push({ proposal: proposal.id, example: example.name, expect: "fail", ok: true, detail: `retired: proposal "${retiredBy}" removed rule "${example.flaggedBy.rule}", which it proves`, retiredBy });
        continue;
      }
      const result = flagged(checkExample(config, example), example);
      runs.push({ proposal: proposal.id, example: example.name, expect: "fail", ok: result.ok, detail: result.ok ? `flagged by "${example.flaggedBy.rule}"` : result.detail });
    }
  }
  return runs;
}
