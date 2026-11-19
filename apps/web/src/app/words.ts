import { describeRule, type Finding, type ProjectConfig, type RuleReport } from "@design-harness/core";

/**
 * Plain words for what the app shows a designer first. They lead; the exact
 * ids, messages and places core gives stay beside them or one step away, and
 * nothing here changes what core says.
 */

/** An id written as words: "lantern-held" is "Lantern held". */
export function humanize(id: string): string {
  const words = id.replace(/[-_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words ? `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}` : id;
}

/** A scenario's name on the board: its id in words. */
export function scenarioLabel(scenario: string): string {
  return humanize(scenario);
}

/** A view's name in words: "desktop" is "Desktop". */
export function viewLabel(view: string): string {
  return humanize(view);
}

/**
 * An artboard row's title, the way a designer names a screen: its page and
 * the state it shows, "Booking, room held". A state that says no more than
 * the page ("Rooms, rooms") is left out.
 */
export function screenTitle(scenario: { readonly page: string; readonly state: string }): string {
  const page = humanize(scenario.page);
  const state = humanize(scenario.state).toLowerCase();
  return state === page.toLowerCase() ? page : `${page}, ${state}`;
}

/** One artboard's name: "Booking, room held — phone". */
export function artboardLabel(scenario: { readonly page: string; readonly state: string }, view: string): string {
  return `${screenTitle(scenario)} — ${view.toLowerCase()}`;
}

/** One frame's name where only its scenario and view are known, as on a finding: "Lantern held — phone". */
export function frameLabel(scenario: string, view: string): string {
  return `${scenarioLabel(scenario)} — ${view.toLowerCase()}`;
}

/**
 * A rule's lead in plain words: its author's description, or core's words
 * for its data, with the project's caps written as their values
 * ("at most MAX_VISIBLE_QUESTIONS questions" reads "at most 3 questions").
 */
export function ruleLead(rule: RuleReport, config: ProjectConfig | undefined): string {
  const spec = config?.rules.find((item) => item.id === rule.rule);
  const said = rule.description ?? (spec && config ? describeRule(spec, config) : undefined) ?? humanize(rule.rule);
  const caps = config?.inputs.caps ?? {};
  return said.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, (name) => {
    const cap = caps[name];
    if (!cap) return name;
    return name.endsWith("_PX") ? `${cap.value} px` : String(cap.value);
  });
}

/** Where a finding is, in a few words: the frame it is in, or its file and line. */
export function findingPlace(finding: Finding): string {
  if (finding.scenario !== undefined && finding.view !== undefined) return frameLabel(finding.scenario, finding.view);
  if (finding.file !== undefined) return finding.line !== undefined ? `${finding.file}, line ${finding.line}` : finding.file;
  if (finding.page !== undefined) return `The ${humanize(finding.page).toLowerCase()} page`;
  if (finding.scenario !== undefined) return scenarioLabel(finding.scenario);
  return "The whole prototype";
}
