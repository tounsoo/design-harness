import {
  boundValue,
  boundWords,
  checkPrototype,
  classifyProposal,
  describeRule,
  onlyRemovesRules,
  proposalImpact,
  propose,
  ruleBounds,
  slugOf,
  withRuleBound,
  type BoundKey,
  type ChangeClass,
  type ClassifiedChange,
  type ExistingPrototype,
  type FailingExample,
  type InventoryOp,
  type PassingExample,
  type ProjectConfig,
  type Proposal,
  type ProposalDraft,
  type ProposalImpact,
  type Refusal,
  type RenderedSnapshot,
  type Result,
  type RuleSpec,
} from "@design-harness/core";
import { humanize } from "../app/words";
import { prototypeEffect } from "./impact";
import { prototypesOf, routeSentence, ruleSentence } from "./plain";
import { REVIEWER } from "./timeline";

/**
 * A person's way to start a proposal that removes or changes a rule, from
 * its card in the Project view. Everything here is a draft and what core
 * says of it: the draft itself, core's classification, core's reading of
 * every prototype in the project with the draft applied, and which of the
 * project's own prototypes can stand as its examples. Nothing here edits
 * `config.rules`: the only way in is `propose`, and the rule changes when
 * the person approves and adopts the proposal on its review page.
 */

// ---- What a card can change in place ----------------------------------------------

/** One numeric limit of a rule, as the change form shows it. */
export type Limit = {
  readonly key: BoundKey;
  /** "At most", "At least", "Nested at most", "At least". */
  readonly label: string;
  /** What follows the number: "", "deep", "px". */
  readonly unit: string;
  /** The number in force: the rule's own, or its cap's. Absent when the rule sets no such limit. */
  readonly value?: number;
  /** The cap the limit reads, when it reads one: the number is then the cap's, and changing it changes the cap. */
  readonly cap?: string;
  readonly stricter: "lower" | "higher";
  /** A nesting depth and a target size cannot be left out. */
  readonly required: boolean;
};

const LIMIT_LABEL: Readonly<Record<BoundKey, { readonly label: string; readonly unit: string }>> = {
  min: { label: "At least", unit: "" },
  max: { label: "At most", unit: "" },
  depth: { label: "Nested at most", unit: "deep" },
  minPx: { label: "At least", unit: "px" },
};

/** The limits a rule's card can change, from core's reading of the rule. A rule with none changes only through the agent. */
export function limitsOf(rule: RuleSpec, config: ProjectConfig): readonly Limit[] {
  return ruleBounds(rule).map((bound) => {
    const value = bound.value === undefined ? undefined : boundValue(bound.value, config);
    return {
      key: bound.key,
      ...LIMIT_LABEL[bound.key],
      ...(value !== undefined ? { value } : {}),
      ...(typeof bound.value === "object" ? { cap: bound.value.cap } : {}),
      stricter: bound.stricter,
      required: bound.key === "depth" || bound.key === "minPx",
    };
  });
}

/** The other rules in force that read a cap: changing the cap changes them too. */
export function otherReaders(config: ProjectConfig, cap: string, rule: string): readonly RuleSpec[] {
  return config.rules.filter((item) => item.id !== rule && ruleBounds(item).some((bound) => typeof bound.value === "object" && bound.value.cap === cap));
}

/** Proposals still waiting that name a rule, or move a cap: the person should know before starting another. */
export function waitingOn(config: ProjectConfig, target: { readonly rule?: string; readonly caps?: readonly string[] }): readonly Proposal[] {
  return config.proposals.filter(
    (proposal) =>
      (proposal.status === "open" || proposal.status === "approved") &&
      ((target.rule !== undefined && (proposal.rules.remove.includes(target.rule) || proposal.rules.add.some((rule) => rule.id === target.rule))) ||
        proposal.inventory.some((op) => op.op === "set-cap" && (target.caps ?? []).includes(op.name))),
  );
}

/** What a waiting proposal does to a rule, in a few words. */
export function waitingWords(proposal: Proposal, rule: string): string {
  const removes = proposal.rules.remove.includes(rule);
  const adds = proposal.rules.add.some((item) => item.id === rule);
  return removes && adds ? "changes this rule" : removes ? "removes this rule" : adds ? "adds a rule of this id" : "moves a cap this rule reads";
}

// ---- The drafts --------------------------------------------------------------------

/** An id no proposal has yet: the base, or the base with the next number. */
export function freshId(config: ProjectConfig, base: string): string {
  const slug = slugOf(base) || "change";
  const taken = new Set(config.proposals.map((proposal) => proposal.id));
  if (!taken.has(slug)) return slug;
  for (let count = 2; ; count += 1) if (!taken.has(`${slug}-${count}`)) return `${slug}-${count}`;
}

/** A rule's lead as a card says it, without its full stop, for a title. */
function leadOf(rule: RuleSpec, config: ProjectConfig): string {
  return (rule.description ?? describeRule(rule, config)).trim().replace(/\.$/, "");
}

const NO_EXAMPLES: ProposalDraft["examples"] = { pass: [], fail: [] };

/** The draft that takes a rule out of force. */
export function removalDraft(config: ProjectConfig, rule: RuleSpec, why: string): ProposalDraft {
  return { id: freshId(config, `remove-${rule.id}`), title: `Remove the rule “${leadOf(rule, config)}”`, reason: why.trim(), states: [], inventory: [], rules: { add: [], remove: [rule.id] }, examples: NO_EXAMPLES };
}

/**
 * What the change form holds: each limit's number as the person left it. A
 * key that is absent is unchanged; `null` takes an optional limit away.
 * `description` is the rule's own sentence for the changed rule: the old
 * one usually names the old limit, so it is kept only when the person
 * writes it again.
 */
export type LimitEdit = { readonly limits: Readonly<Partial<Record<BoundKey, number | null>>>; readonly description?: string };

export type LimitMove = { readonly key: BoundKey; readonly cap?: string; readonly before: string; readonly after: string; readonly direction: "stricter" | "looser" | "unknown" };

export type ChangePreview =
  /** Nothing differs from the rule in force yet. */
  | { readonly state: "unchanged" }
  /** The edit is not a rule the vocabulary has, in words. */
  | { readonly state: "invalid"; readonly problem: string }
  | {
      readonly state: "changed";
      readonly draft: ProposalDraft;
      /** Each limit that moves, before and after in core's words. */
      readonly moves: readonly LimitMove[];
      /** Core's classification of the draft against the project as it is. */
      readonly class: ChangeClass;
      readonly changes: readonly ClassifiedChange[];
      /** The rule in core's words, as it is and as it would be. */
      readonly words: { readonly before: string; readonly after: string };
      /** Each cap the draft moves, with the other rules that read it. */
      readonly caps: readonly { readonly name: string; readonly before: number; readonly after: number; readonly others: readonly RuleSpec[] }[];
    };

const asProposal = (draft: ProposalDraft): Proposal => ({ ...draft, status: "open", history: [{ status: "open", at: "" }] });

/**
 * The draft a limit edit makes, and what core says of it. A limit that is
 * the rule's own number changes the rule: the proposal removes it and adds
 * it again under its id with the new number. A limit that reads a cap
 * changes the cap, with `set-cap`, and the rule is left alone.
 */
export function previewChange(config: ProjectConfig, rule: RuleSpec, edit: LimitEdit, why: string): ChangePreview {
  const limits = limitsOf(rule, config);
  let next: RuleSpec = rule;
  const ops: InventoryOp[] = [];
  const moves: LimitMove[] = [];
  for (const limit of limits) {
    const wanted = edit.limits[limit.key];
    if (wanted === undefined || (wanted ?? undefined) === limit.value) continue;
    if (wanted !== null && (!Number.isInteger(wanted) || wanted < 0)) return { state: "invalid", problem: "A limit is a whole number, 0 or more." };
    if (limit.cap !== undefined) {
      if (wanted === null) return { state: "invalid", problem: `This limit reads the cap ${limit.cap}; it can move, and it cannot be left out here.` };
      ops.push({ op: "set-cap", name: limit.cap, value: wanted });
      continue;
    }
    if (wanted === null && limit.required) return { state: "invalid", problem: "This rule needs its limit." };
    const changed = withRuleBound(next, limit.key, wanted ?? undefined);
    if (!changed) return { state: "invalid", problem: "This rule has no such limit." };
    next = changed;
  }
  if (next !== rule && (rule.type === "count" || rule.type === "slot") && ruleBounds(next).every((bound) => bound.value === undefined)) {
    return { state: "invalid", problem: "With no limit at all the rule would check nothing. Remove the rule instead." };
  }
  const ruleChanged = next !== rule;
  if (!ruleChanged && ops.length === 0) return { state: "unchanged" };
  if (ruleChanged) {
    const { description: _was, ...bare } = next;
    void _was;
    const said = edit.description?.trim() ?? "";
    next = (said === "" ? bare : { ...bare, description: said }) as RuleSpec;
  }
  const after = (limit: Limit): string => {
    const wanted = edit.limits[limit.key];
    return boundWords(limit.key, wanted === null ? undefined : wanted === undefined ? limit.value : wanted, config);
  };
  const scratch: ProposalDraft = { id: "scratch", title: "", reason: why.trim(), states: [], inventory: ops, rules: ruleChanged ? { remove: [rule.id], add: [next] } : { add: [], remove: [] }, examples: NO_EXAMPLES };
  const classified = classifyProposal(asProposal(scratch), config);
  for (const limit of limits) {
    const wanted = edit.limits[limit.key];
    if (wanted === undefined || (wanted ?? undefined) === limit.value) continue;
    const direction = wanted === null ? "looser" : limit.value === undefined ? "stricter" : (limit.stricter === "lower") === (wanted < limit.value) ? "stricter" : "looser";
    moves.push({ key: limit.key, ...(limit.cap !== undefined ? { cap: limit.cap } : {}), before: boundWords(limit.key, limit.value, config), after: after(limit), direction });
  }
  const said = moves.map((move) => move.after).join(" and ");
  const cap = ops[0]?.op === "set-cap" ? ops[0] : undefined;
  const draft: ProposalDraft = {
    ...scratch,
    id: freshId(config, ruleChanged ? `change-${rule.id}` : `set-${cap?.name ?? rule.id}`),
    title: ruleChanged || !cap ? `Change “${leadOf(rule, config)}” to ${said}` : `Move the cap ${cap.name} from ${config.inputs.caps[cap.name]?.value ?? "unset"} to ${cap.value}`,
  };
  const applied = proposalImpact(config, draft);
  const candidate = applied.ok ? applied.value.config : config;
  return {
    state: "changed",
    draft,
    moves,
    class: classified.class,
    changes: classified.changes,
    words: { before: describeRule(rule, config), after: describeRule(ruleChanged ? next : rule, candidate) },
    caps: ops.flatMap((op) => (op.op === "set-cap" ? [{ name: op.name, before: config.inputs.caps[op.name]?.value ?? 0, after: op.value, others: otherReaders(config, op.name, rule.id) }] : [])),
  };
}

// ---- Core's reading of the project with a draft applied ---------------------------

export type ImpactRow = {
  readonly name: string;
  /** Findings the prototype has now from the rules the draft is about. */
  readonly now: number;
  /** `clears`: it stops failing altogether. `still-fails`: its findings change, and it still fails. `fails`: it would need fixing for something it does not today. `same`: nothing changes. */
  readonly effect: "clears" | "still-fails" | "fails" | "same";
  /** What that means for the prototype, as a designer reads it: no rule id, and core's message only as its plain sentence. */
  readonly text: string;
};

export type ImpactView =
  | { readonly ok: false; readonly refusal: Refusal }
  | {
      readonly ok: true;
      readonly rows: readonly ImpactRow[];
      /** In the review page's voice: "1 of 2 prototypes would need fixing.", "Nothing that works today would stop working. 1 of 2 prototypes would start passing." */
      readonly summary: string;
      /** Failing examples adopted proposals keep that the draft retires, each by its name and its proposal's title. */
      readonly retired: readonly string[];
      /** Examples adopted proposals keep that the draft's change supersedes, which adopting it retires, named the same way; core's own words are in `impact.retired`, with `changed` set. */
      readonly replaced: readonly string[];
      /** Kept examples that would stop behaving, named the same way: core refuses to adopt until they do, and its own words for each are in `impact.broken`. */
      readonly broken: readonly string[];
      readonly impact: ProposalImpact;
    };

const count = (value: number, one: string, many = `${one}s`) => `${value} ${value === 1 ? one : many}`;

/**
 * What a draft would do to every prototype in the project, from core's
 * `proposalImpact`, which checks each as it is now and with the draft
 * applied. `rules` are the rules the draft is about: the one removed or
 * changed, or the readers of a cap it moves, or the rules that read a step
 * budget it moves. Every sentence is in the words of the review page's "What
 * it affects": which prototypes would need fixing and which would start
 * passing, with each rule as its plain sentence and never its id.
 */
export function impactOf(config: ProjectConfig, draft: ProposalDraft, existing: readonly ExistingPrototype[], rules: readonly string[]): ImpactView {
  const impact = proposalImpact(config, draft, existing);
  if (!impact.ok) return { ok: false, refusal: impact.error };
  const about = new Set(rules);
  const candidate = impact.value.config;
  const sentenceOf = (id: string) => {
    const rule = candidate.rules.find((item) => item.id === id) ?? config.rules.find((item) => item.id === id);
    return rule ? [ruleSentence(rule, candidate)] : [];
  };
  // An earlier proposal by its title, as the Proposals view lists it.
  const from = (id: string) => `“${config.proposals.find((proposal) => proposal.id === id)?.title ?? humanize(id)}”`;
  const rows = impact.value.prototypes.map((item): ImpactRow => {
    const record = existing.find((entry) => entry.name === item.name);
    const report = record ? checkPrototype({ config, prototype: record.prototype, ...(record.snapshots ? { snapshots: record.snapshots } : {}) }) : null;
    const now = report?.findings.filter((finding) => about.has(finding.rule)).length ?? 0;
    const effect = prototypeEffect(item);
    if (effect.state === "needs-fixing") {
      // A route over its budget is said by its task and steps; any other rule by its own sentence.
      const route = effect.added.flatMap((finding) => (effect.breaks.includes(finding.rule) && finding.evidence?.kind === "route-vs-budget" ? [finding.evidence] : []))[0];
      const against = effect.breaks.flatMap(sentenceOf);
      const why = route ? routeSentence(route, candidate) : against.length > 0 ? `It would go against: ${against.join(" ")}` : "It would have more to fix than it does today.";
      return { name: item.name, now, effect: "fails", text: `Would need fixing. ${why}` };
    }
    if (item.removed.length === 0 && item.added.length === 0) return { name: item.name, now, effect: "same", text: effect.stillFails ? "No change: it needs fixing today, and still would." : "No change." };
    if (!effect.stillFails) return { name: item.name, now, effect: "clears", text: "Would start passing." };
    return { name: item.name, now, effect: "still-fails", text: effect.fixes.length > 0 ? "Would stop failing this check, and still need fixing for other reasons." : "Still needs fixing, as it does today." };
  });
  const clears = rows.filter((row) => row.effect === "clears").length;
  const fails = rows.filter((row) => row.effect === "fails").length;
  const parts = [fails > 0 ? `${prototypesOf(fails, rows.length)} would need fixing.` : "Nothing that works today would stop working.", ...(clears > 0 ? [`${prototypesOf(clears, rows.length)} would start passing.`] : [])];
  return {
    ok: true,
    rows,
    summary: rows.length === 0 ? "The project has no prototype to read." : parts.join(" "),
    retired: impact.value.retired.filter((run) => run.changed === undefined).map((run) => `“${humanize(run.example)}”, from ${from(run.proposal)}`),
    replaced: impact.value.retired.filter((run) => run.changed !== undefined).map((run) => `“${humanize(run.example)}”, from ${from(run.proposal)}`),
    broken: impact.value.broken.map((run) => `the ${run.expect === "pass" ? "“Allowed”" : "“Not allowed”"} example “${humanize(run.example)}”, from ${from(run.proposal)}`),
    impact: impact.value,
  };
}

// ---- Examples, from what the project already has ----------------------------------

/** Where a chosen example comes from, for the person to read before they confirm. */
export type PickedExample = { readonly name: string; readonly expect: "pass" | "fail"; readonly from: string; readonly rule?: string };

export type ExampleChoice = {
  readonly examples: ProposalDraft["examples"];
  readonly picked: readonly PickedExample[];
  /** What core's adoption still needs that the project does not have, each in words. Empty when the examples are enough. */
  readonly needs: readonly string[];
};

/** The rules in force that hold each task's routes to its step budget. Usually one, `step-budget`; none when a project removed it. */
export function stepBudgetRules(config: ProjectConfig): readonly RuleSpec[] {
  return config.rules.filter((rule) => rule.type === "flow" && rule.check === "step-budget");
}

/** A task's step budget a draft lowers, with a rule in force that reads it: what a failing example has to show. */
type LoweredBudget = { readonly rule: string; readonly task: string; readonly before: number; readonly after: number };

function loweredBudgets(config: ProjectConfig, candidate: ProjectConfig, draft: ProposalDraft): readonly LoweredBudget[] {
  const rule = stepBudgetRules(candidate)[0];
  if (!rule) return [];
  return config.inputs.tasks.flatMap((task) => {
    const after = candidate.inputs.tasks.find((item) => item.id === task.id)?.maxSteps;
    return draft.inventory.some((op) => op.op === "set-max-steps" && op.task === task.id) && after !== undefined && after < task.maxSteps ? [{ rule: rule.id, task: task.id, before: task.maxSteps, after }] : [];
  });
}

type Source = { readonly label: string; readonly from: string; readonly prototype: ExistingPrototype["prototype"]; readonly snapshots?: readonly RenderedSnapshot[]; readonly cleared: boolean };

/**
 * The examples core's adoption needs, taken from what the project already
 * has and never written here: one prototype that passes every rule with the
 * draft applied, and for each rule the draft adds (a changed rule is one),
 * a prototype that rule flags and no other does; a draft that adds no rule
 * needs any one prototype a single rule still in force flags, except that
 * a draft that lowers a task's step budget is proven like a changed rule:
 * by a prototype whose route the new budget flags. The project's
 * prototypes come first, one the draft clears before the rest, then the
 * examples adopted proposals keep. Each is read by `checkPrototype` under
 * the draft's config, on the snapshots it has, as `adopt` will read it.
 * What is missing is named in `needs`: the agent writes those. A draft
 * that only removes rules needs none (core's `onlyRemovesRules`), so none
 * are taken.
 */
export function chooseExamples(config: ProjectConfig, draft: ProposalDraft, existing: readonly ExistingPrototype[]): ExampleChoice {
  if (onlyRemovesRules(draft)) return { examples: NO_EXAMPLES, picked: [], needs: [] };
  const impact = proposalImpact(config, draft, existing);
  if (!impact.ok) return { examples: NO_EXAMPLES, picked: [], needs: [] };
  const candidate = impact.value.config;
  const cleared = new Set(impact.value.prototypes.filter((item) => item.removed.length > 0 && item.added.length === 0).map((item) => item.name));
  const own = [...existing].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((item): Source => ({ label: item.name, from: `the prototype ${item.name}`, prototype: item.prototype, ...(item.snapshots ? { snapshots: item.snapshots } : {}), cleared: cleared.has(item.name) }));
  const kept = config.proposals
    .filter((proposal) => proposal.status === "adopted")
    .flatMap((proposal) => [...proposal.examples.pass, ...proposal.examples.fail].map((example): Source => ({ label: example.name, from: `the example ${example.name} that ${proposal.id} keeps`, prototype: example.prototype, ...(example.snapshots ? { snapshots: example.snapshots } : {}), cleared: false })));
  const sources = [...own.filter((item) => item.cleared), ...own.filter((item) => !item.cleared), ...kept];
  const inForce = new Set(candidate.rules.map((rule) => rule.id));
  const added = draft.rules.add.map((rule) => rule.id);
  const read = sources.map((source) => {
    const report = checkPrototype({ config: candidate, prototype: source.prototype, ...(source.snapshots ? { snapshots: source.snapshots } : {}) });
    return { source, findings: report.findings, failing: report.rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule), unrun: report.rules.filter((rule) => rule.status === "not-run").map((rule) => rule.rule) };
  });

  const names = new Set<string>();
  const nameFor = (label: string, expect: "pass" | "fail") => {
    const base = slugOf(label) || "example";
    const first = names.has(base) ? `${base}-${expect === "pass" ? "passes" : "fails"}` : base;
    let name = first;
    for (let index = 2; names.has(name); index += 1) name = `${first}-${index}`;
    names.add(name);
    return name;
  };
  const pass: PassingExample[] = [];
  const fail: FailingExample[] = [];
  const picked: PickedExample[] = [];
  const needs: string[] = [];

  const passing = read.find((item) => item.failing.length === 0 && added.every((rule) => !item.unrun.includes(rule)));
  if (passing) {
    const name = nameFor(passing.source.label, "pass");
    pass.push({ name, prototype: passing.source.prototype });
    picked.push({ name, expect: "pass", from: passing.source.from });
  } else {
    needs.push("a prototype that passes every rule once this is adopted");
  }
  const flaggedBy = (rule: string | null) => read.find((item) => item !== passing && item.failing.length === 1 && (rule === null ? inForce.has(item.failing[0] ?? "") : item.failing[0] === rule));
  // A route over the new budget and within the old one shows the change itself; one already over both still shows the budget fires.
  const overBudget = (want: LoweredBudget) => {
    const over = read.flatMap((item) => {
      if (item === passing || item.failing.length !== 1 || item.failing[0] !== want.rule) return [];
      const steps = item.findings.flatMap((finding) => (finding.rule === want.rule && finding.evidence?.kind === "route-vs-budget" && finding.evidence.task === want.task ? [finding.evidence.steps] : []));
      return steps.length > 0 ? [{ item, newly: steps.every((count) => count <= want.before) }] : [];
    });
    return (over.find((entry) => entry.newly) ?? over[0])?.item;
  };
  const wanted: readonly (string | LoweredBudget | null)[] = [...added, ...loweredBudgets(config, candidate, draft)];
  for (const rule of wanted.length > 0 ? wanted : [null]) {
    const found = rule !== null && typeof rule === "object" ? overBudget(rule) : flaggedBy(rule);
    const by = found?.failing[0];
    if (found && by !== undefined) {
      const name = nameFor(found.source.label, "fail");
      fail.push({ name, prototype: found.source.prototype, flaggedBy: { rule: by } });
      picked.push({ name, expect: "fail", from: found.source.from, rule: by });
    } else {
      needs.push(
        rule === null
          ? "a prototype that one rule still in force flags, and no other rule does"
          : typeof rule === "object"
            ? `a prototype whose longest route for ${rule.task} takes more than ${count(rule.after, "step")}, so that ${rule.rule} flags it, and no other rule does`
            : `a prototype that ${rule} flags as changed, and no other rule does`,
      );
    }
  }
  return { examples: { pass, fail }, picked, needs };
}

// ---- Proposing, and asking the agent ----------------------------------------------

/** Saves the draft as an open proposal by the person, through core's `propose`. */
export function proposeByPerson(config: ProjectConfig, draft: ProposalDraft, examples: ProposalDraft["examples"], at: string): Result<ProjectConfig, Refusal> {
  if (draft.reason.trim() === "") return { ok: false, error: { code: "missing-note", message: "Say why: the reason is what the reviewer reads first, and what the proposal's history keeps." } };
  return propose(config, { ...draft, examples }, { at, by: REVIEWER });
}

/** The chat message that asks the agent for the examples a person's proposal still needs. The person edits and sends it. */
export function examplesMessage(draft: Pick<ProposalDraft, "id" | "title">, needs: readonly string[]): string {
  return `I opened proposal "${draft.id}" (${draft.title}). Core adopts a proposal only on examples, and the project has none for part of it. It still needs:\n\n${needs.map((need) => `- ${need}`).join("\n")}\n\nRevise it with revise_proposal, keeping its id, and give only examples (both lists, since they are replaced together): leave its title, reason, rules and inventory as they are.`;
}

/** The chat message that asks the agent to draft a change the card cannot make in place. The person edits and sends it. */
export function changeMessage(rule: RuleSpec, config: ProjectConfig, wish: string): string {
  const said = wish.trim();
  return `Draft a proposal that changes the rule "${rule.id}". In core's words it says: ${describeRule(rule, config)}\n\nWhat I want changed: ${said === "" ? "(say here what the rule should check instead)" : said}\n\nChange it in one proposal: put "${rule.id}" in rules.remove and the changed rule, under the same id, in rules.add, with a passing example and a failing example the changed rule flags and no other rule does.`;
}
