import { applyProposal, checkPrototype, contentOf, onlyRemovesRules, revise, type ExistingPrototype, type FailingExample, type Finding, type PassingExample, type ProjectConfig, type Proposal, type ProposalDraft, type Refusal, type Result } from "@design-harness/core";
import { exampleLabel } from "../app/words";
import { REVIEWER } from "./timeline";

/**
 * When a proposal's own examples are why core refuses it, the person can fix
 * them on its review page, without the agent: take out an example that is
 * not needed, or put one of the project's own prototypes in its place. Each
 * fix is core's `revise`, by the reviewer, so the history keeps who changed
 * what and the version it replaced; core then judges the examples again, as
 * for any revision. Nothing here decides pass or fail: a prototype is
 * offered only where core's own check, with the proposal applied, says it
 * would do what the example has to do, and core still has the last word.
 */

/** Which example a fix is about, and which side it is on. */
export type ExampleSide = { readonly name: string; readonly expect: "pass" | "fail" };

/** One of the project's prototypes that could stand as the example, by its name. */
export type PrototypeChoice = { readonly name: string };

/**
 * What the person can do about the examples core refused, in its words. The
 * `target` is the example the refusal names (absent when one is missing);
 * `rule` the rule a Not allowed example has to show. `canRemove` is true
 * when taking the target out still leaves core what it asks for: an Allowed
 * and a Not allowed example, and a Not allowed one for every rule the
 * proposal adds, unless it only removes rules.
 */
export type ExampleFixes = {
  readonly target?: ExampleSide;
  readonly side: "pass" | "fail";
  readonly rule?: string;
  readonly canRemove: boolean;
  readonly choices: readonly PrototypeChoice[];
};

/** What the person chose. */
export type ExampleFix =
  | { readonly kind: "remove"; readonly example: ExampleSide }
  | { readonly kind: "use"; readonly prototype: string; readonly side: "pass" | "fail"; readonly rule?: string; readonly replaces?: ExampleSide };

type Examples = ProposalDraft["examples"];

/** Whether these examples give core what adoption asks for, before it judges them. */
function enough(proposal: Proposal, examples: Examples): boolean {
  if (onlyRemovesRules(proposal)) return true;
  if (examples.pass.length === 0 || examples.fail.length === 0) return false;
  return proposal.rules.add.every((rule) => examples.fail.some((example) => example.flaggedBy.rule === rule.id));
}

function without(examples: Examples, target: ExampleSide): Examples {
  return target.expect === "pass" ? { ...examples, pass: examples.pass.filter((item) => item.name !== target.name) } : { ...examples, fail: examples.fail.filter((item) => item.name !== target.name) };
}

/** What the refusal is about: the example it names when that is the proposal's own, and what an example in its place has to do. */
function aboutOf(proposal: Proposal, refusal: Refusal): { readonly target?: ExampleSide; readonly side: "pass" | "fail"; readonly rule?: string } | null {
  // An earlier proposal's example is not this one's to change.
  if (refusal.proposal !== undefined) return null;
  const pass = refusal.example !== undefined ? proposal.examples.pass.find((item) => item.name === refusal.example) : undefined;
  const fail = refusal.example !== undefined ? proposal.examples.fail.find((item) => item.name === refusal.example) : undefined;
  switch (refusal.code) {
    case "failing-example-passes":
    case "fails-for-another-reason":
    case "unknown-rule":
      return fail ? { target: { name: fail.name, expect: "fail" }, side: "fail", ...(refusal.code === "unknown-rule" ? {} : { rule: fail.flaggedBy.rule }) } : null;
    case "passing-example-fails":
      return pass ? { target: { name: pass.name, expect: "pass" }, side: "pass" } : null;
    case "unproven-rule": {
      if (pass) return { target: { name: pass.name, expect: "pass" }, side: "pass" };
      const missing = proposal.rules.add.find((rule) => !proposal.examples.fail.some((example) => example.flaggedBy.rule === rule.id));
      return missing ? { side: "fail", rule: missing.id } : null;
    }
    case "missing-examples": {
      if (proposal.examples.pass.length === 0) return { side: "pass" };
      const rule = proposal.rules.add[0];
      return rule ? { side: "fail", rule: rule.id } : null;
    }
    default:
      return null;
  }
}

/**
 * The project's prototypes that would do what the example has to, by core's
 * check with the proposal applied, on their measured snapshots: for a Not
 * allowed example, the rule fails it and no other rule does; for an Allowed
 * one, no rule fails it and every rule the proposal adds runs on it. These
 * are core's own conditions on an example. In the order given.
 */
export function prototypeChoices(config: ProjectConfig, proposal: Proposal, side: "pass" | "fail", rule: string | undefined, existing: readonly ExistingPrototype[]): readonly PrototypeChoice[] {
  const applied = applyProposal(config, proposal);
  if (!applied.ok) return [];
  const added = new Set(proposal.rules.add.map((item) => item.id));
  const out: PrototypeChoice[] = [];
  for (const item of existing) {
    const report = checkPrototype({ config: applied.value, prototype: item.prototype, ...(item.snapshots ? { snapshots: item.snapshots } : {}) });
    const failed = report.rules.filter((entry) => entry.status === "fail").map((entry) => entry.rule);
    const fits = side === "fail" ? rule !== undefined && failed.length === 1 && failed[0] === rule : failed.length === 0 && !report.rules.some((entry) => added.has(entry.rule) && entry.status === "not-run");
    if (fits) out.push({ name: item.name });
  }
  return out;
}

/**
 * What the rule catches in one of the project's prototypes, with the
 * proposal applied: core's own findings for that rule, on the prototype's
 * measured snapshots. They are what makes it a "Not allowed" example, so a
 * page can show where on the prototype that is. Nothing here decides.
 */
export function choiceFindings(config: ProjectConfig, proposal: Proposal, rule: string, item: ExistingPrototype): readonly Finding[] {
  const applied = applyProposal(config, proposal);
  if (!applied.ok) return [];
  const report = checkPrototype({ config: applied.value, prototype: item.prototype, ...(item.snapshots ? { snapshots: item.snapshots } : {}) });
  return report.rules.find((entry) => entry.rule === rule)?.findings ?? [];
}

/** What the person can fix themselves about why core refuses the proposal, or null when it is not its own examples. */
export function exampleFixes(config: ProjectConfig, proposal: Proposal, refusal: Refusal, existing: readonly ExistingPrototype[] | null): ExampleFixes | null {
  if (proposal.status !== "open") return null;
  const about = aboutOf(proposal, refusal);
  if (!about) return null;
  const canRemove = about.target !== undefined && enough(proposal, without(proposal.examples, about.target));
  const choices = existing && (about.side === "pass" || about.rule !== undefined) ? prototypeChoices(config, proposal, about.side, about.rule, existing) : [];
  if (!canRemove && choices.length === 0 && !about.target) return null;
  return { ...about, canRemove, choices };
}

/** A name for a new example from a prototype's name, unique among the examples it joins. */
function exampleName(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "example";
  let id = base;
  for (let count = 2; taken.includes(id); count += 1) id = `${base}-${count}`;
  return id;
}

/** The note the history keeps with the revision, in the person's terms. */
export function fixNote(fix: ExampleFix): string {
  const side = (expect: "pass" | "fail") => (expect === "pass" ? "Allowed" : "Not allowed");
  if (fix.kind === "remove") return `Took out the “${side(fix.example.expect)}” example “${exampleLabel(fix.example.name)}”, which wasn't needed.`;
  if (fix.replaces) return `Put the prototype “${fix.prototype}” in place of the “${side(fix.replaces.expect)}” example “${exampleLabel(fix.replaces.name)}”.`;
  return `Added the prototype “${fix.prototype}” as a “${side(fix.side)}” example.`;
}

/**
 * Applies the person's fix as core's `revise`, stamped by the reviewer with
 * the time and a note saying what changed. The new example is the prototype
 * as it is now, with no snapshots: the review page measures it before core
 * judges it, like every example. Refuses what core refuses, and a choice the
 * project no longer has.
 */
export function applyExampleFix(config: ProjectConfig, id: string, fix: ExampleFix, existing: readonly ExistingPrototype[], at: string): Result<ProjectConfig, Refusal> {
  const proposal = config.proposals.find((item) => item.id === id);
  if (!proposal) return { ok: false, error: { code: "not-found", message: `there is no proposal "${id}"` } };
  const content = contentOf(proposal);
  let examples: Examples = content.examples;
  if (fix.kind === "remove") examples = without(examples, fix.example);
  else {
    const source = existing.find((item) => item.name === fix.prototype);
    if (!source) return { ok: false, error: { code: "invalid-proposal", message: `the project has no prototype "${fix.prototype}" to use as an example` } };
    const kept = fix.replaces ? without(examples, fix.replaces) : examples;
    const name = exampleName(fix.prototype, [...kept.pass, ...kept.fail].map((item) => item.name));
    if (fix.side === "pass") {
      const added: PassingExample = { name, prototype: source.prototype };
      examples = { ...kept, pass: [...kept.pass, added] };
    } else {
      if (fix.rule === undefined) return { ok: false, error: { code: "invalid-proposal", message: "a Not allowed example needs the rule it shows" } };
      const added: FailingExample = { name, prototype: source.prototype, flaggedBy: { rule: fix.rule } };
      examples = { ...kept, fail: [...kept.fail, added] };
    }
  }
  return revise(config, id, { id, ...content, examples }, { at, by: REVIEWER, note: fixNote(fix) });
}
