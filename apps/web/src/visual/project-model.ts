import { classifyProposal, type BoundChange, type Bound, type Cap, type ChangeClass, type InventoryOp, type PageType, type ProjectConfig, type Proposal, type ProposalStatus, type RuleSpec, type Task, type TaskFacts } from "@design-harness/core";
import { humanize } from "../app/words";

/**
 * What the Project and Proposals views draw, worked out from the project
 * config and core's facts: which group a rule belongs to, which figure it
 * gets, what a page type's slots are, a cap and a task's budget in words,
 * where a proposal stands and what it leads with. Pure functions of
 * data core already decided; nothing here passes or fails anything, and
 * every number is the config's or core's own.
 */

// ---- Rules in force, grouped by what a rule looks at ------------------------------

export const RULE_GROUPS = [
  { id: "count", title: "How many on a page", about: "rules that count" },
  { id: "where", title: "What sits where", about: "rules about slots and nesting" },
  { id: "rendered", title: "As rendered", about: "rules measured on the drawn page" },
  { id: "inventory", title: "From the inventory", about: "rules that hold a prototype to the project's lists" },
  { id: "flow", title: "The flow", about: "rules about tasks and states" },
  { id: "code", title: "In the code", about: "rules with no picture: their place is a line of code" },
] as const;
export type RuleGroupId = (typeof RULE_GROUPS)[number]["id"];

/**
 * The group a rule is listed under, from its type and check alone, so a
 * rule a proposal adds lands in a group the day it is adopted. A rule type
 * core adds fails to compile here until it has a group.
 */
export function ruleGroup(rule: RuleSpec): RuleGroupId {
  switch (rule.type) {
    case "count":
      return rule.scope === "source" ? "code" : "count";
    case "slot":
      return rule.min !== undefined || rule.max !== undefined ? "count" : "where";
    case "containment":
      return rule.must === "nest-at-most" ? "count" : "where";
    case "requires":
    case "page-structure":
      return "where";
    case "rendered":
      return "rendered";
    case "membership":
      return "inventory";
    case "prop-values":
      return "inventory";
    case "flow":
      return "flow";
    case "reachable":
      return "code";
  }
}

/** The rules in force by group, in the groups' order, each group's rules in the config's order. Empty groups are left out. */
export function groupRules(rules: readonly RuleSpec[]): readonly { readonly group: (typeof RULE_GROUPS)[number]; readonly rules: readonly RuleSpec[] }[] {
  return RULE_GROUPS.map((group) => ({ group, rules: rules.filter((rule) => ruleGroup(rule) === group.id) })).filter((item) => item.rules.length > 0);
}

/**
 * The glyph a rule card draws, for a rule about how a rendered page looks:
 * a control's size, text on its ground, the heading outline, where the
 * first view ends, a page wider than its view. Every other rule has none
 * (`null`): a count, a place, a list, a flow or a rule about code reads
 * whole in its sentence, and a generic picture beside it would only repeat it.
 */
export type RuleGlyph = "target-size" | "contrast" | "headings" | "first-view" | "sideways";

export function ruleGlyph(rule: RuleSpec): RuleGlyph | null {
  if (rule.type !== "rendered") return null;
  switch (rule.check) {
    case "target-size":
      return "target-size";
    case "contrast":
      return "contrast";
    case "headings":
      return "headings";
    case "first-view":
      return "first-view";
    case "no-sideways-scroll":
      return "sideways";
    case "accessible-names":
      return null;
  }
}

/** A rule's limit in a few words, with a cap read as its value now: "at most 1", "exactly 1". Absent for a rule with no number. */
export function ruleBound(rule: RuleSpec, config: ProjectConfig): string | undefined {
  const value = (bound: Bound | undefined) => (bound === undefined ? undefined : typeof bound === "number" ? bound : config.inputs.caps[bound.cap]?.value);
  const words = (min: number | undefined, max: number | undefined) => (min !== undefined && min === max ? `exactly ${min}` : [min !== undefined ? `at least ${min}` : "", max !== undefined ? (max === 0 ? "none" : `at most ${max}`) : ""].filter(Boolean).join(", ") || undefined);
  switch (rule.type) {
    case "count":
    case "slot":
      return words(value(rule.min), value(rule.max));
    case "containment":
      return rule.must === "nest-at-most" ? words(undefined, value(rule.depth)) : undefined;
    case "rendered":
      return rule.check === "target-size" && value(rule.minPx) !== undefined ? `at least ${value(rule.minPx)} px` : undefined;
    default:
      return undefined;
  }
}

const capOf = (bound: Bound | undefined): string[] => (typeof bound === "object" ? [bound.cap] : []);

/** The caps a rule reads by name. */
export function capsRead(rule: RuleSpec): readonly string[] {
  switch (rule.type) {
    case "count":
    case "slot":
      return [...capOf(rule.min), ...capOf(rule.max)];
    case "containment":
      return rule.must === "nest-at-most" ? capOf(rule.depth) : [];
    case "rendered":
      return rule.check === "target-size" ? capOf(rule.minPx) : [];
    default:
      return [];
  }
}

/** The rules in force that read a cap, in the config's order. */
export function capReaders(config: ProjectConfig, name: string): readonly RuleSpec[] {
  return config.rules.filter((rule) => capsRead(rule).includes(name));
}

/** The adopted proposal that brought a rule into force, when one did. */
export function ruleSource(config: ProjectConfig, rule: string): Proposal | undefined {
  return config.proposals.find((proposal) => proposal.status === "adopted" && proposal.rules.add.some((item) => item.id === rule));
}

// ---- Page types, caps and budgets -------------------------------------------------

export type SlotRow = { readonly slot: string; readonly kind: "chrome" | "primary" | "body" };

/** A page type's slots in the order the project lists them, each as chrome, the primary slot or body. */
export function slotRows(type: PageType): readonly SlotRow[] {
  return type.slots.map((slot) => ({ slot, kind: type.kind === "action" && type.primarySlot === slot ? "primary" : type.chrome.includes(slot) ? "chrome" : "body" }));
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** A page type in words, beside its diagram. */
export function pageTypeWords(type: PageType): { readonly kind: string; readonly slots: string } {
  const kind = type.kind === "action" ? "An action page: it ends in one primary action." : type.kind === "collection" ? "A collection page: a list to pick from, with no primary action." : "A content page: it shows information, with no primary action.";
  const chrome = type.chrome.filter((slot) => type.slots.includes(slot)).length;
  return { kind, slots: `${plural(type.slots.length, "slot")}, ${chrome} of them chrome. ${type.kind === "action" ? `Primary slot: ${type.primarySlot}.` : "No primary slot."}` };
}

export type CapMeter = {
  /** `size`: a length in CSS px, drawn at its actual size, which words cannot show. `number`: a count, which reads whole in its words and draws nothing. */
  readonly kind: "size" | "number";
  readonly value: number;
  /** "at most 1", "at least 24 px". */
  readonly words: string;
  /** "stricter when lower". */
  readonly direction: string;
  /** The cap's name in words, with the constant beside it in code. */
  readonly title: string;
};

/** A cap's limit from the config, and which way is stricter. It says nothing about how much of it a prototype uses. */
export function capMeter(name: string, cap: Cap): CapMeter {
  const px = name.endsWith("_PX");
  const bound = cap.stricter === "lower" ? "at most" : "at least";
  return {
    kind: px ? "size" : "number",
    value: cap.value,
    words: `${bound} ${cap.value}${px ? " px" : ""}`,
    direction: `stricter when ${cap.stricter}`,
    title: humanize(name.replace(/_PX$/, "").replace(/(^|_)(MAX|MIN)(?=_|$)/g, "$1").replace(/^_+|_+$/g, "")),
  };
}

/** Which way a cap moved, in words: toward its stricter side or away from it. */
export function capDirection(cap: Pick<Cap, "stricter">, before: number, after: number): "stricter" | "looser" | "the same" {
  if (before === after) return "the same";
  return (cap.stricter === "lower") === (after < before) ? "stricter" : "looser";
}

export type BudgetMeter = {
  /** "at most 3 steps". */
  readonly words: string;
  /** What core's flow facts say of the open prototype's routes; absent when no prototype is open. */
  readonly today?: { readonly text: string; readonly over: boolean };
};

/**
 * A task's step budget in words, and, with core's facts for the open
 * prototype (`flowFacts`), what its longest route takes today against it.
 * Two small numbers read whole in a sentence; the route itself is drawn by
 * the flow map.
 */
export function budgetMeter(task: Task, facts: TaskFacts | undefined, prototype: string | undefined): BudgetMeter {
  const steps = facts?.longest?.length;
  const words = `at most ${plural(task.maxSteps, "step")}`;
  if (!facts || prototype === undefined) return { words };
  const today =
    facts.status === "fits" || facts.status === "over"
      ? { text: `${prototype}'s longest route today: ${plural(steps ?? 0, "step")}${facts.status === "over" ? `, ${(steps ?? 0) - task.maxSteps} over the limit` : steps === task.maxSteps ? ", at the limit" : ""}.`, over: facts.status === "over" }
      : facts.status === "no-route"
        ? { text: `${prototype} has no route to ${humanize(task.successState).toLowerCase()} today.`, over: false }
        : facts.status === "too-many"
          ? { text: `${prototype} has more routes than can be walked.`, over: false }
          : { text: `${prototype} does not model this task.`, over: false };
  return { words, today };
}

// ---- Proposals --------------------------------------------------------------------

export const CLASS_STOPS: readonly { readonly value: ChangeClass; readonly title: string; readonly about: string }[] = [
  { value: "adds", title: "Only adds", about: "nothing that passed can fail" },
  { value: "tightens", title: "Tightens", about: "more can fail, nothing is let through" },
  { value: "loosens-or-removes", title: "Loosens or removes", about: "something stops being checked" },
];

export type TrackStep = { readonly id: "drafted" | ProposalStatus; readonly title: string; readonly state: "done" | "current" | "upcoming" };

/**
 * Where a proposal stands: drafted, open, approved, adopted, with the
 * current step marked. A declined proposal's track ends at Declined, after
 * the steps it reached.
 */
export function proposalTrack(proposal: Pick<Proposal, "status" | "history">): readonly TrackStep[] {
  const { status } = proposal;
  if (status === "declined") {
    const approved = proposal.history.some((change) => change.status === "approved");
    return [
      { id: "drafted", title: "Drafted", state: "done" },
      { id: "open", title: "Open", state: "done" },
      ...(approved ? [{ id: "approved" as const, title: "Approved", state: "done" as const }] : []),
      { id: "declined", title: "Declined", state: "current" },
    ];
  }
  const order = ["open", "approved", "adopted"] as const;
  const at = order.indexOf(status);
  return [
    { id: "drafted", title: "Drafted", state: "done" },
    ...order.map((id, index) => ({ id, title: id === "open" ? "Open" : id === "approved" ? "Approved" : "Adopted", state: index < at ? ("done" as const) : index === at ? ("current" as const) : ("upcoming" as const) })),
  ];
}

/**
 * One rule in force a proposal removes or changes, as a line to read:
 * "Removes rule one-toast-per-page", or "Changes rule one-primary-per-page:
 * at most 1 → at most 2, looser". A proposal changes a rule by removing it
 * and adding it again under its id; core's classification says which limits
 * moved and which way, and keeps the rule's words as it was, since an
 * adopted removal or change leaves no trace of the old rule in the config.
 */
export type RuleLine = {
  readonly kind: "removes" | "changes";
  readonly rule: string;
  readonly words: string;
  /** The limits that moved, when only limits did. */
  readonly moves: readonly BoundChange[];
  /** What the change comes to, for a change: every limit stricter, or not. */
  readonly direction?: "stricter" | "looser" | "the same";
  /** The rule in core's words as it was when the proposal was classified. */
  readonly was?: string;
  /** For a change that is not a move of limits, what it is instead, in a few words. */
  readonly detail?: string;
};

const directionWords = (direction: BoundChange["direction"]) => (direction === "unknown" ? "not provably stricter" : direction);

/** A moved limit as it is read: "at most 1 → at most 2, looser". */
export function moveWords(move: BoundChange): string {
  return `${move.before} → ${move.after}, ${directionWords(move.direction)}`;
}

/** The rules in force a proposal removes or changes, in the order it names them. Core's kept classification, or its classification against the project now. */
export function ruleLines(proposal: Proposal, config: ProjectConfig): readonly RuleLine[] {
  const classified = proposal.classification ?? classifyProposal(proposal, config);
  return proposal.rules.remove.map((id): RuleLine => {
    const entry = classified.changes.find((change) => change.rule === id);
    const changed = entry ? entry.change.startsWith("change rule") : proposal.rules.add.some((rule) => rule.id === id);
    const was = entry?.was !== undefined ? { was: entry.was } : {};
    if (!changed) return { kind: "removes", rule: id, words: `Removes rule ${id}`, moves: [], ...was };
    const moves = entry?.bounds ?? [];
    const direction = entry === undefined ? undefined : entry.class === "tightens" ? "stricter" : entry.class === "adds" ? "the same" : "looser";
    const detail = entry?.class === "adds" ? "only its own sentence; it checks the same thing" : "more than its limits, which is not provably stricter";
    return { kind: "changes", rule: id, words: `Changes rule ${id}: ${moves.length > 0 ? moves.map(moveWords).join("; ") : detail}`, moves, ...(direction ? { direction } : {}), ...was, ...(moves.length === 0 ? { detail } : {}) };
  });
}

/** How many separate changes a proposal makes: a rule removed and added again under its id is one. */
export function changeCount(proposal: Proposal): number {
  const changed = proposal.rules.remove.filter((id) => proposal.rules.add.some((rule) => rule.id === id)).length;
  return proposal.inventory.length + proposal.rules.add.length + proposal.rules.remove.length - changed;
}

/** What a proposal's card leads with: its first inventory change, else a rule it changes, its first added rule, or a rule it removes. */
export type ProposalPreview =
  | { readonly kind: "component"; readonly name: string; readonly removed: boolean }
  | { readonly kind: "cap"; readonly name: string; readonly cap: Cap; readonly before?: number; readonly moved: "stricter" | "looser" | "the same" | "new" }
  | { readonly kind: "budget"; readonly task: string; readonly before?: number; readonly after: number }
  | { readonly kind: "page-type"; readonly pageType: PageType }
  | { readonly kind: "flow-state"; readonly state: string; readonly removed: boolean }
  | { readonly kind: "words"; readonly label: string; readonly text: string }
  | { readonly kind: "rule"; readonly rule: RuleSpec }
  | { readonly kind: "rule-line"; readonly line: RuleLine }
  | { readonly kind: "request" }
  | { readonly kind: "none" };

const OP_LABEL: Readonly<Record<InventoryOp["op"], string>> = {
  "add-component": "+ component",
  "remove-component": "− component",
  "add-layout": "+ layout",
  "remove-layout": "− layout",
  "add-page-type": "+ page type",
  "remove-page-type": "− page type",
  "add-flow-state": "+ flow state",
  "remove-flow-state": "− flow state",
  "add-task": "+ task",
  "remove-task": "− task",
  "set-max-steps": "step budget",
  "add-cap": "+ cap",
  "set-cap": "cap",
  "add-disclosed-section": "+ disclosed section",
  "remove-disclosed-section": "− disclosed section",
  "set-ranking": "ranking",
  "set-role": "role",
};

/** A short label for the kind of change a preview shows: "+ component", "cap", "+ rule". */
export function previewLabel(proposal: Proposal): string {
  if (proposal.needsRuleType) return "needs a new rule type";
  const first = proposal.inventory[0];
  if (first) return OP_LABEL[first.op];
  // A rule removed and added again under its id is a changed rule, named like a changed cap.
  if (proposal.rules.remove.some((id) => proposal.rules.add.some((rule) => rule.id === id))) return "rule";
  return proposal.rules.add.length > 0 ? "+ rule" : proposal.rules.remove.length > 0 ? "− rule" : "no change";
}

export function proposalPreview(proposal: Proposal, config: ProjectConfig): ProposalPreview {
  if (proposal.needsRuleType) return { kind: "request" };
  const op = proposal.inventory[0];
  if (!op) {
    const lines = ruleLines(proposal, config);
    const changed = lines.find((line) => line.kind === "changes");
    if (changed) return { kind: "rule-line", line: changed };
    if (proposal.rules.add[0]) return { kind: "rule", rule: proposal.rules.add[0] };
    return lines[0] ? { kind: "rule-line", line: lines[0] } : { kind: "none" };
  }
  switch (op.op) {
    case "add-component":
    case "remove-component":
      return { kind: "component", name: op.name, removed: op.op === "remove-component" };
    case "add-cap":
      return { kind: "cap", name: op.name, cap: op.cap, moved: "new" };
    case "set-cap": {
      const cap = config.inputs.caps[op.name];
      // An adopted proposal's cap is already at its value: there is no before to show.
      if (!cap) return { kind: "words", label: "Cap", text: `${op.name}: ${op.value}` };
      const adopted = proposal.status === "adopted";
      return { kind: "cap", name: op.name, cap: { ...cap, value: op.value }, ...(adopted ? {} : { before: cap.value }), moved: adopted ? "the same" : capDirection(cap, cap.value, op.value) };
    }
    case "set-max-steps": {
      const task = config.inputs.tasks.find((item) => item.id === op.task);
      return { kind: "budget", task: task?.description ?? humanize(op.task), ...(task && proposal.status !== "adopted" ? { before: task.maxSteps } : {}), after: op.value };
    }
    case "add-task":
      return { kind: "budget", task: op.task.description ?? humanize(op.task.id), after: op.task.maxSteps };
    case "add-page-type":
      return { kind: "page-type", pageType: op.pageType };
    case "add-flow-state":
    case "remove-flow-state":
      return { kind: "flow-state", state: op.state, removed: op.op === "remove-flow-state" };
    case "add-layout":
    case "remove-layout":
      return { kind: "words", label: op.op === "add-layout" ? "New layout" : "Removes a layout", text: humanize(op.id) };
    case "remove-page-type":
      return { kind: "words", label: "Removes a page type", text: humanize(op.id) };
    case "remove-task":
      return { kind: "words", label: "Removes a task", text: humanize(op.id) };
    case "add-disclosed-section":
    case "remove-disclosed-section":
      return { kind: "words", label: op.op === "add-disclosed-section" ? "Always behind a disclosure" : "No longer behind a disclosure", text: op.section };
    case "set-ranking":
      return { kind: "words", label: "Actions, in rank order", text: [...op.ranking].sort((a, b) => a.rank - b.rank).map((item) => `${item.rank}. ${item.action} (${item.level})`).join("  ") };
    case "set-role":
      return { kind: "words", label: `The ${humanize(op.role).toLowerCase()} role`, text: op.mapping.components.join(", ") || "no part" };
  }
}

/** What a proposal changes, in a line: "Adds 1 component and 1 rule." */
export function changeLine(proposal: Proposal): string {
  if (proposal.needsRuleType) return "Asks for a new rule type: a code change.";
  const counts = new Map<string, number>();
  const count = (verb: string, noun: string) => counts.set(`${verb} ${noun}`, (counts.get(`${verb} ${noun}`) ?? 0) + 1);
  for (const op of proposal.inventory) {
    const [verb, ...rest] = op.op.split("-");
    const noun = rest.join(" ");
    if (verb === "add") count("Adds", noun);
    else if (verb === "remove") count("Removes", noun);
    else count("Changes", op.op === "set-max-steps" ? "step budget" : op.op === "set-cap" ? "cap" : op.op === "set-ranking" ? "ranking" : "role");
  }
  const changed = new Set(proposal.rules.remove.filter((id) => proposal.rules.add.some((rule) => rule.id === id)));
  for (const rule of proposal.rules.add) if (!changed.has(rule.id)) count("Adds", "rule");
  for (const id of proposal.rules.remove) count(changed.has(id) ? "Changes" : "Removes", "rule");
  if (counts.size === 0) return "Changes nothing.";
  const verbs = new Map<string, string[]>();
  for (const [key, value] of counts) {
    const [verb, ...rest] = key.split(" ");
    const noun = rest.join(" ");
    verbs.set(verb as string, [...(verbs.get(verb as string) ?? []), `${value} ${value === 1 ? noun : noun.endsWith("y") ? `${noun.slice(0, -1)}ies` : `${noun}s`}`]);
  }
  const list = (items: readonly string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
  const parts = [...verbs].map(([verb, items], index) => `${index === 0 ? verb : verb.toLowerCase()} ${list(items)}`);
  return `${list(parts)}.`;
}

/** The proposals in the list's order: open first, then approved, adopted and declined, newest first in each. */
export function sortProposals(proposals: readonly Proposal[], statuses: readonly ProposalStatus[]): readonly Proposal[] {
  const drafted = (proposal: Proposal) => proposal.history[0]?.at ?? "";
  return [...proposals].sort((a, b) => statuses.indexOf(a.status) - statuses.indexOf(b.status) || (drafted(b) < drafted(a) ? -1 : drafted(b) > drafted(a) ? 1 : 0));
}

export type HistoryItem = { readonly id: string; readonly title: string; readonly status: ProposalStatus; readonly at: string; readonly what: string; readonly waiting: boolean };

/** The project's history in a few lines: the newest proposals by their last status change, open ones marked as waiting. */
export function projectTimeline(config: ProjectConfig, most = 5): { readonly items: readonly HistoryItem[]; readonly more: number } {
  const all = config.proposals
    .map((proposal, index) => ({ proposal, index, at: proposal.history.at(-1)?.at ?? "" }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.index - b.index))
    .map(({ proposal, at }) => ({ id: proposal.id, title: proposal.title, status: proposal.status, at, what: changeLine(proposal), waiting: proposal.status === "open" || proposal.status === "approved" }));
  return { items: all.slice(0, most), more: Math.max(0, all.length - most) };
}

/**
 * The examples shown under a rule a proposal adds: the first failing
 * example the rule must flag and the first passing example. They are two
 * examples, not a before and after: nothing pairs them.
 */
export function proofPair(proposal: Pick<Proposal, "examples">, rule: string): { readonly pass?: string; readonly fail?: string } {
  const fail = proposal.examples.fail.find((example) => example.flaggedBy.rule === rule)?.name;
  const pass = proposal.examples.pass[0]?.name;
  return { ...(pass !== undefined ? { pass } : {}), ...(fail !== undefined ? { fail } : {}) };
}
