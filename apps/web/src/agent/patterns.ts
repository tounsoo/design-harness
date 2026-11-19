import { describeRule, type CheckReport, type ProjectConfig, type Proposal } from "@design-harness/core";
import type { Turn } from "./controller";

/**
 * The loop noticing what keeps coming up, so the person can ask the agent to
 * propose a rule for it. Detection is app code over stored history: the
 * chat's turns and their checks, what the person did on this prototype, and
 * the send-back notes of the project's proposals. No model judges it, and the
 * same history always gives the same patterns, in the same order.
 *
 * Three signals, each with a threshold of two, because one is an event and
 * two is a pattern:
 *
 * - A fixed rule: the agent fixed one rule's findings in `FIX_TURNS` separate
 *   turns. A turn fixed a rule when the rule failed at the turn's start or at
 *   any of its checks, and passed at its last check. An undone turn, or one
 *   that changed nothing, fixed nothing.
 * - An asked fix: the person pressed "Ask the agent to fix" for one rule
 *   `ASKS` times, with a message sent between the presses; presses with no
 *   message between them are the same ask.
 * - Repeated notes: `NOTES` notes, each from its own event (a variant
 *   rejected with a note, a proposal sent back), that share at least
 *   `SHARED_WORDS` content words: lowercase words of four letters or more,
 *   a trailing "s" dropped, common words left out.
 *
 * One rule's fixes and asks are one pattern, whichever signal found it, and
 * rules fixed in exactly the same turns are one pattern too: one change that
 * breaks three rules is one mistake, not three. The suggestion is quiet and
 * never acts on its own: the person accepts it, which sends the agent the
 * evidence, or dismisses it. Either answer keeps that pattern, and any
 * pattern about some of its rules, quiet until it has more evidence than
 * when it was answered.
 */

export const FIX_TURNS = 2;
export const ASKS = 2;
export const NOTES = 2;
export const SHARED_WORDS = 2;

/** What the person did that the loop reads, kept with the prototype's chat. */
export type LoopEvent =
  | { readonly kind: "fix-asked"; readonly at: string; readonly rule: string }
  | { readonly kind: "variant-rejected"; readonly at: string; readonly page: string; readonly variant: string; readonly note: string }
  | { readonly kind: "suggestion"; readonly at: string; readonly key: string; readonly answer: "accepted" | "dismissed"; readonly evidence: number };

/** A turn in which the agent fixed a rule's findings. */
export type FixEvidence = { readonly turn: string; readonly text: string; readonly at: string };

/** A note that repeats, and where it was written. */
export type NoteEvidence = { readonly at: string; readonly note: string; readonly where: string };

export type Pattern =
  | {
      readonly kind: "rule";
      readonly key: string;
      /** The rules, in id order: one, or several fixed in exactly the same turns. */
      readonly rules: readonly string[];
      readonly fixes: readonly FixEvidence[];
      readonly asks: readonly string[];
      readonly evidence: number;
      readonly last: string;
    }
  | { readonly kind: "notes"; readonly key: string; readonly words: readonly string[]; readonly notes: readonly NoteEvidence[]; readonly evidence: number; readonly last: string };

/** The rules a report fails, and those it could not run, by id. */
export function reportRules(report: CheckReport): { readonly failing: readonly string[]; readonly notRun: readonly string[] } {
  const ids = (status: string) => report.rules.filter((rule) => rule.status === status).map((rule) => rule.rule).sort();
  return { failing: ids("fail"), notRun: ids("not-run") };
}

/** The rules a turn fixed: failing at its start or at one of its checks, and passing at its last check. */
export function fixedIn(turn: Turn): readonly string[] {
  if (turn.undone || turn.before === null) return [];
  const checks = turn.items.flatMap((item) => (item.kind === "checks" && item.failing !== undefined ? [{ failing: item.failing, notRun: item.notRun ?? [] }] : []));
  const last = checks.at(-1);
  if (!last) return [];
  const seen = new Set([...(turn.failingAtStart ?? []), ...checks.flatMap((check) => check.failing)]);
  return [...seen].filter((rule) => !last.failing.includes(rule) && !last.notRun.includes(rule)).sort();
}

const before = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Presses for one rule that are separate asks: a message was sent between each and the one before. */
function separateAsks(presses: readonly string[], starts: readonly string[]): string[] {
  const out: string[] = [];
  for (const at of [...presses].sort(before)) {
    const previous = out.at(-1);
    if (previous === undefined || starts.some((start) => start > previous && start <= at)) out.push(at);
  }
  return out;
}

const STOP = new Set(
  "about above after again also always back been before being below both could does doing down each even every from have here into just keep like make more most much must need only other over please really same should some still such than that their them then there these they thing this those through very want were what when where which while will with would your".split(" "),
);

/** A note's content words: lowercase, four letters or more, a trailing "s" dropped, common words left out. */
export function contentWords(note: string): readonly string[] {
  const words = new Set<string>();
  for (const raw of note.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (raw.length < 4 || STOP.has(raw)) continue;
    words.add(raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return [...words].sort();
}

/** Every note the loop reads: variants the person rejected with a note on this prototype, and the project's send-backs. */
export function notesOf(log: readonly LoopEvent[], proposals: readonly Proposal[]): NoteEvidence[] {
  const notes: NoteEvidence[] = [];
  for (const event of log) if (event.kind === "variant-rejected" && event.note.trim() !== "") notes.push({ at: event.at, note: event.note.trim(), where: `rejecting variant ${event.variant.toUpperCase()} of page "${event.page}"` });
  for (const proposal of proposals) for (const event of proposal.events ?? []) if (event.kind === "sent-back") notes.push({ at: event.at, note: event.note, where: `sending back proposal "${proposal.id}"` });
  return notes.sort((a, b) => before(a.at, b.at) || before(a.where, b.where) || before(a.note, b.note));
}

/** Groups of notes that repeat: every note holding all of a pair's shared words, with groups inside a larger one left out. */
function repeatedNotes(notes: readonly NoteEvidence[]): Pattern[] {
  const words = notes.map((item) => new Set(contentWords(item.note)));
  const groups = new Map<string, { words: string[]; members: number[] }>();
  for (let i = 0; i < notes.length; i += 1) {
    for (let j = i + 1; j < notes.length; j += 1) {
      const shared = [...(words[i] as Set<string>)].filter((word) => (words[j] as Set<string>).has(word)).sort();
      if (shared.length < SHARED_WORDS) continue;
      const key = shared.join(" ");
      if (groups.has(key)) continue;
      groups.set(key, { words: shared, members: notes.flatMap((_, index) => (shared.every((word) => (words[index] as Set<string>).has(word)) ? [index] : [])) });
    }
  }
  const all = [...groups.values()];
  const inside = (a: { words: string[]; members: number[] }, b: { words: string[]; members: number[] }) =>
    a !== b && a.members.every((member) => b.members.includes(member)) && (b.members.length > a.members.length || b.words.length > a.words.length);
  return all
    .filter((group) => group.members.length >= NOTES && !all.some((other) => inside(group, other)))
    .map((group): Pattern => {
      const members = group.members.map((index) => notes[index] as NoteEvidence);
      return { kind: "notes", key: `notes:${group.words.join(" ")}`, words: group.words, notes: members, evidence: members.length, last: members.at(-1)?.at ?? "" };
    });
}

/** Every pattern in a prototype's history, newest evidence first. */
export function detectPatterns(history: { readonly turns: readonly Turn[]; readonly log: readonly LoopEvent[]; readonly proposals: readonly Proposal[] }): Pattern[] {
  const fixes = new Map<string, FixEvidence[]>();
  for (const turn of history.turns) for (const rule of fixedIn(turn)) fixes.set(rule, [...(fixes.get(rule) ?? []), { turn: turn.id, text: turn.text, at: turn.at }]);
  const starts = history.turns.map((turn) => turn.at);
  const presses = new Map<string, string[]>();
  for (const event of history.log) if (event.kind === "fix-asked") presses.set(event.rule, [...(presses.get(event.rule) ?? []), event.at]);

  // Rules fixed in exactly the same turns are one group; a rule only asked about is a group of its own.
  const groups = new Map<string, string[]>();
  for (const rule of [...new Set([...fixes.keys(), ...presses.keys()])].sort(before)) {
    const turns = (fixes.get(rule) ?? []).map((fix) => fix.turn).join(" ");
    const group = turns === "" ? `asked ${rule}` : `fixed ${turns}`;
    groups.set(group, [...(groups.get(group) ?? []), rule]);
  }
  const patterns: Pattern[] = [];
  for (const rules of groups.values()) {
    const fixed = fixes.get(rules[0] as string) ?? [];
    const asks = separateAsks(rules.flatMap((rule) => presses.get(rule) ?? []), starts);
    if (fixed.length < FIX_TURNS && asks.length < ASKS) continue;
    const last = [...fixed.map((item) => item.at), ...asks].sort(before).at(-1) ?? "";
    patterns.push({ kind: "rule", key: `rule:${rules.join("+")}`, rules, fixes: fixed, asks, evidence: fixed.length + asks.length, last });
  }
  patterns.push(...repeatedNotes(notesOf(history.log, history.proposals)));
  return patterns.sort((a, b) => before(b.last, a.last) || before(a.key, b.key));
}

/** The rules a rule pattern's key names. */
const keyRules = (key: string): readonly string[] => (key.startsWith("rule:") ? key.slice("rule:".length).split("+") : []);

/**
 * The pattern to suggest now: the newest one the person has not answered at
 * its present evidence. An answer about some rules also answers a pattern
 * about fewer of them, at the same evidence.
 */
export function suggestion(patterns: readonly Pattern[], log: readonly LoopEvent[]): Pattern | undefined {
  const answers = log.filter((event): event is Extract<LoopEvent, { kind: "suggestion" }> => event.kind === "suggestion");
  const answeredAt = (pattern: Pattern) =>
    Math.max(
      0,
      ...answers
        .filter((event) => event.key === pattern.key || (pattern.kind === "rule" && pattern.rules.every((rule) => keyRules(event.key).includes(rule))))
        .map((event) => event.evidence),
    );
  return patterns.find((pattern) => pattern.evidence > answeredAt(pattern));
}

const quoted = (rules: readonly string[]) => {
  const names = rules.map((rule) => `"${rule}"`);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};

const short = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
};

const times = (count: number) => (count === 1 ? "once" : count === 2 ? "twice" : `${count} times`);

/** What the suggestion says it noticed, in a line or two. */
export function patternSummary(pattern: Pattern): string {
  if (pattern.kind === "notes") return `${pattern.evidence} of your notes say much the same thing (${pattern.words.map((word) => `"${word}"`).join(", ")}).`;
  const rules = quoted(pattern.rules);
  const parts = [
    pattern.fixes.length > 0 ? `The agent fixed ${rules} in ${pattern.fixes.length} separate ${pattern.fixes.length === 1 ? "turn" : "turns"}` : null,
    pattern.asks.length > 0 ? `you asked it to fix ${pattern.fixes.length > 0 ? (pattern.rules.length === 1 ? "it" : "them") : rules} ${times(pattern.asks.length)}` : null,
  ].filter((part): part is string => part !== null);
  const text = parts.join(", and ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** The evidence, one line each, as the agent reads it; the suggestion passes `time` to show each time in the person's words. */
export function evidenceLines(pattern: Pattern, time: (at: string) => string = (at) => at): string[] {
  if (pattern.kind === "notes") return pattern.notes.map((item) => `${time(item.at)}, ${item.where}: "${item.note}"`);
  const rules = quoted(pattern.rules);
  const verb = pattern.rules.length === 1 ? "failed, and passed" : "failed, and all passed";
  return [
    ...pattern.fixes.map((fix) => `${time(fix.at)}, turn "${short(fix.text)}": ${rules} ${verb} by the turn's end.`),
    ...pattern.asks.map((at) => `${time(at)}: "Ask the agent to fix" pressed for ${rules}.`),
  ];
}

/** The message accepting a suggestion sends: the evidence, and what to propose. */
export function patternMessage(pattern: Pattern, config: ProjectConfig): string {
  const evidence = evidenceLines(pattern).map((line) => `- ${line}`).join("\n");
  const ask = `Draft a proposal with draft_proposal for a rule that would catch this from now on: in core's rule vocabulary where it can say it, with passing and failing examples that prove it, and the inventory change if one is needed. If the vocabulary truly cannot express it, file it with needs_rule_type instead. If no new rule would help, say so and draft nothing. Only I approve or adopt it.`;
  if (pattern.kind === "notes") {
    return `This keeps coming up. ${pattern.evidence} notes say much the same thing; they share ${pattern.words.map((word) => `"${word}"`).join(", ")}:\n${evidence}\n\nPropose a rule that holds what these notes ask for. ${ask}`;
  }
  const words = pattern.rules.flatMap((id) => {
    const rule = config.rules.find((item) => item.id === id);
    return rule ? [`"${id}" says: ${describeRule(rule, config)}`] : [];
  });
  const named = `${pattern.rules.length === 1 ? "the rule" : "the rules"} ${quoted(pattern.rules)}`;
  return `This keeps coming up with ${named}.${words.length > 0 ? ` ${words.join(" ")}` : ""}\n${evidence}\n\nLook at what made ${pattern.rules.length === 1 ? "it" : "them"} fail each time and what you changed. Propose a rule that would catch it earlier or make it impossible to write, such as a narrower selector, a slot or a required prop. ${ask}`;
}
