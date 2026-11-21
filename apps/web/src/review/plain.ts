import { classifyProposal, describeRule, type ChangeClass, type InventoryOp, type ProjectConfig, type Proposal, type Refusal, type RouteVsBudgetEvidence, type RuleSpec } from "@design-harness/core";
import { budgetLines, capMeter, ruleLines } from "../visual/project-model";
import { draftedBy } from "./timeline";

/**
 * A proposal in the words a designer decides on: what changes, one plain
 * sentence per change; where it stands; and why it cannot be accepted, when
 * core refuses it. Nothing here decides anything: every sentence is written
 * from the proposal's own data and core's words for a rule, and core's exact
 * words, ids and codes stay in the review page's details.
 */

/** An id written as words: "room-cards" is "Room cards". */
function words(id: string): string {
  const text = id.replace(/[-_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return text ? `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}` : id;
}

const plural = (count: number, noun: string) => `${count} ${count === 1 ? noun : `${noun}s`}`;

/** A sentence with the project's caps written as their values: "at most MAX_VISIBLE_QUESTIONS questions" reads "at most 3 questions". */
export function withCapValues(text: string, config: ProjectConfig): string {
  const caps = config.inputs.caps;
  return text
    .replace(/\s*\(([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\)/g, (whole, name: string) => (caps[name] ? "" : whole))
    .replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, (name) => {
      const cap = caps[name];
      if (!cap) return name;
      return name.endsWith("_PX") ? `${cap.value} px` : String(cap.value);
    });
}

/** An HTML element as people say it; any other is its own name. */
const ELEMENT_WORDS: Readonly<Record<string, string>> = { a: "link", img: "image", input: "field", select: "dropdown", textarea: "text box" };

/** A library part's name as a designer says it: "Toast.Root" is "Toast", "Card.Header" is "Card header", "<button>" is "button". */
export function partName(name: string): string {
  const element = /^<?([a-z][a-z0-9]*)>?$/.exec(name);
  if (element?.[1]) return ELEMENT_WORDS[element[1]] ?? element[1];
  const [part = name, ...rest] = name.split(".");
  const sub = rest.filter((item) => item !== "Root").map((item) => item.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase());
  return [part, ...sub].join(" ");
}

const pluralOf = (noun: string) => (/(?:s|x|ch|sh)$/.test(noun) ? `${noun}es` : `${noun}s`);

/**
 * Core's words for a rule with each part by its plain name, counted as a
 * noun: "at most 1 Toast.Root" reads "at most 1 Toast", "at most 2
 * Toast.Root" reads "at most 2 Toasts". Text a rule quotes is left as it is.
 */
export function withPartNames(text: string): string {
  return text
    .split(/("[^"]*")/)
    .map((piece, index) =>
      index % 2 === 1
        ? piece
        : piece.replace(/(?:\b(\d+|no|any number of) )?(\b[A-Z][A-Za-z0-9]*(?:\.[A-Z][A-Za-z0-9]*)+\b|<[a-z][a-z0-9]*>)/g, (_, count: string | undefined, name: string) => {
            const said = partName(name);
            return count === undefined ? said : `${count} ${count === "1" ? said : pluralOf(said)}`;
          }),
    )
    .join("");
}

const taskWords = (task: { readonly id: string; readonly description?: string | undefined }) => task.description ?? words(task.id);

/**
 * A rule as one sentence a designer reads, from its data: core's words, with
 * caps as their values and parts by their plain names. A step budget is said
 * by its tasks' own names. Core's exact words stay in the details.
 */
export function ruleSentence(rule: RuleSpec, config: ProjectConfig): string {
  if (rule.type === "flow" && rule.check === "step-budget") {
    const tasks = config.inputs.tasks.map((task) => `“${taskWords(task)}” in ${plural(task.maxSteps, "step")}`);
    return `Every way of finishing a task, not only the shortest, fits the steps the task allows${tasks.length > 0 ? ` (${tasks.join("; ")})` : ""}.`;
  }
  return withPartNames(withCapValues(describeRule(rule, config), config));
}

/**
 * A route that is over its step budget, as a sentence: the task by its own
 * name, the steps by theirs in order, and how far over. Core's message, with
 * its ids, stays in the details.
 */
export function routeSentence(evidence: Pick<RouteVsBudgetEvidence, "task" | "route" | "steps" | "budget">, config: ProjectConfig): string {
  const task = config.inputs.tasks.find((item) => item.id === evidence.task);
  const name = task ? taskWords(task) : words(evidence.task);
  const steps = evidence.route.map((step, index) => (index === 0 ? words(step.event) : words(step.event).toLowerCase()));
  const over = evidence.steps - evidence.budget;
  return `“${name}” can take ${plural(evidence.steps, "step")}${steps.length > 0 ? ` (${steps.join(", then ")})` : ""}${over > 0 ? `, ${over} more than the ${evidence.budget} allowed` : `, within the ${evidence.budget} allowed`}.`;
}

/** How many of the project's prototypes, as a sentence starts: "1 of 2 prototypes", "2 prototypes", "1 prototype". */
export function prototypesOf(some: number, all: number): string {
  return `${some === all ? "" : `${some} of `}${plural(all, "prototype")}`;
}

const unstopped = (text: string) => text.replace(/[.\s]+$/, "");

function opSentence(op: InventoryOp, proposal: Proposal, config: ProjectConfig): string {
  const adopted = proposal.status === "adopted";
  switch (op.op) {
    case "add-component":
      return `Add ${op.name} to the parts screens can use.`;
    case "remove-component":
      return `Take ${op.name} out of the parts screens can use.`;
    case "add-layout":
      return `Add a layout: ${words(op.id)}.`;
    case "remove-layout":
      return `Remove the ${words(op.id).toLowerCase()} layout.`;
    case "add-page-type":
      return `Add a kind of page: ${words(op.pageType.id)}.`;
    case "remove-page-type":
      return `Remove a kind of page: ${words(op.id)}.`;
    case "add-flow-state":
      return `Add a state screens can show: ${words(op.state)}.`;
    case "remove-flow-state":
      return `Remove a state screens can show: ${words(op.state)}.`;
    case "add-task":
      return `Add a task: “${op.task.description ?? words(op.task.id)}”, in at most ${plural(op.task.maxSteps, "step")}.`;
    case "remove-task":
      return `Remove a task: ${words(op.id)}.`;
    case "set-max-steps": {
      const line = budgetLines({ ...proposal, inventory: [op] }, config)[0];
      const name = line?.name ?? words(op.task);
      return `“${name}” takes at most ${plural(op.value, "step")}${line?.move ? ` (was ${line.move.before})` : ""}.`;
    }
    case "add-cap": {
      const meter = capMeter(op.name, op.cap);
      return `Add a limit: ${meter.title.toLowerCase()}, ${meter.words}.`;
    }
    case "set-cap": {
      const cap = config.inputs.caps[op.name];
      if (!cap) return `${words(op.name)}: ${op.value}.`;
      const after = capMeter(op.name, { ...cap, value: op.value });
      return `${after.title}: ${after.words}${adopted || cap.value === op.value ? "" : ` (was ${capMeter(op.name, cap).words})`}.`;
    }
    case "add-disclosed-section":
      return `Always keep “${op.section}” folded away until someone opens it.`;
    case "remove-disclosed-section":
      return `“${op.section}” no longer has to be folded away.`;
    case "set-ranking":
      return `Change which actions matter most: ${[...op.ranking].sort((a, b) => a.rank - b.rank).map((item) => item.action).join(", then ")}.`;
    case "set-role":
      return `Change which parts count as the ${words(op.role).toLowerCase()}: ${op.mapping.components.map(partName).join(", ") || "none"}.`;
  }
}

/** One change of a proposal as a designer reads it, with what it is about, so the page can put a picture beside it. */
export type PlainChange =
  | { readonly kind: "inventory"; readonly sentence: string; readonly op: InventoryOp }
  | { readonly kind: "rule-added" | "rule-changed"; readonly sentence: string; readonly rule: RuleSpec }
  | { readonly kind: "rule-removed"; readonly sentence: string; readonly rule: string }
  | { readonly kind: "request"; readonly sentence: string };

/**
 * Every change a proposal makes, one plain sentence each, in the order it
 * names them: what the project gains or loses first, then its rules. A rule
 * removed and added again under its id is one changed rule, said as it will
 * read with what its limit was.
 */
export function plainChanges(proposal: Proposal, config: ProjectConfig): readonly PlainChange[] {
  if (proposal.needsRuleType) return [{ kind: "request", sentence: "Asks for a kind of rule the app can't check yet. It needs a code change first." }];
  const lines = ruleLines(proposal, config);
  const changed = new Map(lines.filter((line) => line.kind === "changes").map((line) => [line.rule, line]));
  const out: PlainChange[] = proposal.inventory.map((op) => ({ kind: "inventory", sentence: opSentence(op, proposal, config), op }));
  for (const rule of proposal.rules.add) {
    const line = changed.get(rule.id);
    const sentence = ruleSentence(rule, config);
    if (!line) out.push({ kind: "rule-added", sentence: `New rule: ${sentence}`, rule });
    else out.push({ kind: "rule-changed", sentence: `Rule change: ${unstopped(sentence)}${line.moves.length > 0 ? ` (was ${line.moves.map((move) => move.before).join(", ")})` : ""}.`, rule });
  }
  for (const line of lines) {
    if (line.kind !== "removes") continue;
    const inForce = proposal.status === "adopted" ? undefined : config.rules.find((rule) => rule.id === line.rule);
    const said = inForce ? ruleSentence(inForce, config) : line.was !== undefined ? withPartNames(withCapValues(line.was, config)) : `${words(line.rule)}.`;
    out.push({ kind: "rule-removed", sentence: `Stop checking: ${said}`, rule: line.rule });
  }
  return out;
}

/** A proposal in one line, for a card: its first change, and how many more it makes. */
export function plainSentence(proposal: Proposal, config: ProjectConfig): string {
  const changes = plainChanges(proposal, config);
  const first = changes[0];
  if (!first) return "It changes nothing.";
  return changes.length === 1 ? first.sentence : `${first.sentence} And ${plural(changes.length - 1, "more change")}.`;
}

/** A day for people, without the time: "Nov 20, 2026"; the string itself when it is not a date. */
export function formatDay(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

/** Whether a proposal waits for the person: open, or approved before accepting became one step. */
export function waitsForYou(proposal: Pick<Proposal, "status">): boolean {
  return proposal.status === "open" || proposal.status === "approved";
}

/** Where a proposal stands, in words: "Waiting for you", "Accepted Nov 20, 2026", "Declined: not this quarter". */
export function standingWords(proposal: Pick<Proposal, "status" | "history">): string {
  const last = proposal.history.at(-1);
  switch (proposal.status) {
    case "open":
    case "approved":
      return "Waiting for you";
    case "adopted":
      return last?.at ? `Accepted ${formatDay(last.at)}` : "Accepted";
    case "declined":
      return last?.note ? `Declined: ${last.note}` : "Declined";
  }
}

/** Who a proposal is from, in words: "Suggested by the agent, Nov 20, 2026", "Started by you, Nov 20, 2026". */
export function fromWords(proposal: Proposal): string {
  const drafted = draftedBy(proposal);
  const who = drafted.by === "you" ? "Started by you" : drafted.by === "agent" ? "Suggested by the agent" : `Suggested by ${drafted.by}`;
  return drafted.at ? `${who}, ${formatDay(drafted.at)}` : who;
}

/** What a loosening proposal lets through, in a line each: a check that stops, a limit that is looser. Empty for one that only adds or tightens. */
export function loosensWords(proposal: Proposal, config: ProjectConfig): readonly string[] {
  const classified = proposal.classification ?? classifyProposal(proposal, config);
  const loose = classified.changes.filter((change) => change.class === ("loosens-or-removes" satisfies ChangeClass));
  if (loose.length === 0) return [];
  const removed = plainChanges(proposal, config).filter((change) => change.kind === "rule-removed");
  const out = removed.map((change) => `${change.sentence.replace(/^Stop checking: /, "This check stops running, on every prototype: ")}`);
  if (loose.length > removed.length) out.push("Something gets looser: a screen that is flagged for it today may pass afterwards.");
  return out;
}

/** Why core refuses a proposal, as a designer reads it. Core's own message and code stay in the details. */
export function plainRefusal(refusal: Pick<Refusal, "code" | "proposal">): string {
  switch (refusal.code) {
    case "failing-example-passes":
      return "Its “Not allowed” example isn't caught by the rule, so nothing shows the rule working.";
    case "passing-example-fails":
      return "Its “Allowed” example breaks one of the project's rules, so it can't show what is allowed.";
    case "fails-for-another-reason":
      return "Its “Not allowed” example breaks a different rule from the one it is there to show.";
    case "unproven-rule":
      return "A rule it adds has no “Not allowed” example, so nothing shows that rule working.";
    case "missing-examples":
      return "It needs one example of what is allowed and one of what is not.";
    case "unknown-rule":
      return "One of its examples points at a rule that would not exist after this change.";
    case "breaks-adopted-example":
      return "It goes against an example kept from a change you accepted earlier.";
    case "cannot-apply":
    case "invalid-config":
    case "invalid-proposal":
      return "It no longer fits the project as it is now.";
    case "changes-nothing":
      return "It doesn't change anything.";
    case "incomplete-measurement":
      return "One of its examples couldn't be drawn in every view, so it couldn't be checked.";
    case "needs-rule-type":
      return "It asks for a kind of rule the app can't check yet, which needs a code change first.";
    default:
      return "It can't be accepted as it is.";
  }
}
