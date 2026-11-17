import { configReferenceIssues } from "../config/references";
import type { ProjectConfig } from "../config/types";
import { checkPrototype } from "../engine/check";
import { compareStrings, type CheckReport, type Finding } from "../engine/report";
import { prototypeIssues } from "../parse";
import type { Prototype } from "../prototype/types";
import type { RenderedSnapshot } from "../rendered/types";
import { run, type Result } from "../validate";
import { applyProposal } from "./apply";
import { classifyProposal, type Classification } from "./classify";
import { proposalSchema } from "./schema";
import type { FailingExample, PassingExample, Proposal, ProposalStatus } from "./types";

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
  | "fails-for-another-reason";

/** Why a step was refused, precisely enough to fix: which example, and what happened instead. */
export type Refusal = { readonly code: RefusalCode; readonly message: string; readonly example?: string; readonly findings?: readonly Finding[] };

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

/** Adds a proposal to the config as `open`. Time and who are the caller's. */
export function propose(config: ProjectConfig, draft: ProposalDraft, stamp: Stamp): Result<ProjectConfig, Refusal> {
  const proposal: Proposal = { ...draft, status: "open", history: [{ status: "open", ...stamp }] };
  const checked = run(proposalSchema, proposal, "proposal");
  if (!checked.ok) return refuse("invalid-proposal", checked.error.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
  if (config.proposals.some((item) => item.id === draft.id)) return refuse("duplicate-id", `a proposal "${draft.id}" already exists`);
  const names = [...draft.examples.pass, ...draft.examples.fail].map((example) => example.name);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined) return refuse("invalid-proposal", `two examples are named "${repeated}"; each example needs its own name`, { example: repeated });
  for (const example of [...draft.examples.pass, ...draft.examples.fail]) {
    const issues = prototypeIssues(example.prototype, `example "${example.name}"`);
    if (issues.length > 0) return refuse("invalid-proposal", issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"), { example: example.name });
  }
  return { ok: true, value: { ...config, proposals: [...config.proposals, checked.value] } };
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

export function approve(config: ProjectConfig, id: string, stamp: Stamp): Result<ProjectConfig, Refusal> {
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
};

export type Adoption = {
  readonly config: ProjectConfig;
  readonly classification: Classification;
  /** Caller-supplied prototypes that fail a rule, or carry a finding, they did not before. */
  readonly newlyFailing: readonly NewlyFailing[];
  /** Examples of earlier adopted proposals that no longer behave as they did. */
  readonly brokenExamples: readonly ExampleRun[];
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
 * Adopts an approved proposal: applies its changes and puts its rules in
 * force, but only once its examples prove the rules. Every passing example
 * must pass every rule of the new config; every failing example must fail
 * the rule it names, with the message it names, and no other rule; and every
 * rule the proposal adds must be named by a failing example, so each is
 * shown to fire. Pure: time and who are the caller's.
 */
export function adopt(config: ProjectConfig, id: string, stamp: Stamp, existing: readonly ExistingPrototype[] = []): Result<Adoption, Refusal> {
  const proposal = config.proposals.find((item) => item.id === id);
  if (!proposal) return refuse("not-found", `there is no proposal "${id}"`);
  if (proposal.status !== "approved") {
    return refuse("wrong-status", `proposal "${id}" is ${proposal.status}; ${proposal.status === "open" ? "it must be approved before it is adopted" : "only an approved proposal can be adopted"}`);
  }
  if (proposal.inventory.length === 0 && proposal.rules.add.length === 0 && proposal.rules.remove.length === 0) {
    return refuse("changes-nothing", `proposal "${id}" changes no inventory and no rule`);
  }
  const applied = applyProposal(config, proposal);
  if (!applied.ok) return refuse("cannot-apply", `proposal "${id}" cannot apply: ${applied.error}`);
  const candidate = applied.value;
  const issues = configReferenceIssues(candidate);
  if (issues.length > 0) return refuse("invalid-config", `adopting "${id}" would leave the config invalid: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);

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
  const added = new Set(proposal.rules.add.map((rule) => rule.id));

  for (const example of pass) {
    const report = checkExample(candidate, example);
    const failed = report.rules.filter((rule) => rule.status === "fail");
    if (failed.length > 0) {
      const findings = failed.flatMap((rule) => rule.findings);
      return refuse("passing-example-fails", `passing example "${example.name}" fails ${failed.map((rule) => `"${rule.rule}"`).join(", ")}: ${quote(findings)}`, { example: example.name, findings });
    }
    const unrun = report.rules.find((rule) => added.has(rule.rule) && rule.status === "not-run");
    if (unrun) {
      return refuse("unproven-rule", `passing example "${example.name}" does not run the new rule "${unrun.rule}": ${unrun.note ?? "no reason given"}`, { example: example.name });
    }
  }
  for (const example of fail) {
    const report = checkExample(candidate, example);
    const result = flagged(report, example);
    if (!result.ok) {
      const ruleReport = report.rules.find((rule) => rule.rule === example.flaggedBy.rule);
      return refuse("failing-example-passes", `failing example "${example.name}" is not flagged as it must be: ${result.detail}`, { example: example.name, findings: ruleReport?.findings ?? [] });
    }
    const others = report.rules.filter((rule) => rule.status === "fail" && rule.rule !== example.flaggedBy.rule);
    if (others.length > 0) {
      const findings = others.flatMap((rule) => rule.findings);
      return refuse("fails-for-another-reason", `failing example "${example.name}" must fail for "${example.flaggedBy.rule}" alone, but it also fails ${others.map((rule) => `"${rule.rule}"`).join(", ")}: ${quote(findings)}`, { example: example.name, findings });
    }
  }

  const adopted = replace(candidate, stamped(proposal, "adopted", stamp));
  const newlyFailing: NewlyFailing[] = [];
  for (const item of [...existing].sort((a, b) => compareStrings(a.name, b.name))) {
    const snapshots = item.snapshots ? { snapshots: item.snapshots } : {};
    const before = checkPrototype({ config, prototype: item.prototype, ...snapshots });
    const after = checkPrototype({ config: adopted, prototype: item.prototype, ...snapshots });
    const failedBefore = new Set(before.rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule));
    const known = new Set(before.findings.map((finding) => JSON.stringify(finding)));
    const rules = after.rules.filter((rule) => rule.status === "fail" && !failedBefore.has(rule.rule)).map((rule) => rule.rule);
    const findings = after.findings.filter((finding) => !known.has(JSON.stringify(finding)));
    if (rules.length > 0 || findings.length > 0) newlyFailing.push({ name: item.name, rules, findings });
  }
  const brokenExamples = rerunExamples(adopted).filter((item) => !item.ok && item.proposal !== id);
  return { ok: true, value: { config: adopted, classification: classifyProposal(proposal, config), newlyFailing, brokenExamples } };
}

/**
 * Re-runs every adopted proposal's examples against the config as it is now:
 * passing examples must still pass every rule, and failing examples must
 * still be flagged by their rule. Later rules may add other reasons to fail,
 * so a failing example is not held to failing for its rule alone here.
 */
export function rerunExamples(config: ProjectConfig): ExampleRun[] {
  const runs: ExampleRun[] = [];
  const adopted = config.proposals.filter((proposal) => proposal.status === "adopted").sort((a, b) => compareStrings(a.id, b.id));
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
      const result = flagged(checkExample(config, example), example);
      runs.push({ proposal: proposal.id, example: example.name, expect: "fail", ok: result.ok, detail: result.ok ? `flagged by "${example.flaggedBy.rule}"` : result.detail });
    }
  }
  return runs;
}
