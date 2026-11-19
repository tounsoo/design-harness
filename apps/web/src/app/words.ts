import { describeRule, type Finding, type ProjectConfig, type RuleReport } from "@design-harness/core";
import type { FrameSpec, FrameState, SessionState } from "../runtime/session";
import type { OutlinePlan } from "../runtime/tags";

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

/** What a scenario is told by: the page it opens, the state it shows, and its id. */
type Scenario = { readonly id: string; readonly page: string; readonly state: string };

/**
 * A scenario's name wherever one is named outside its own row of the board,
 * in a picker or a sentence: its screen, then its own name, "Booking, room
 * held (Lantern held)". Its id stays in details and code.
 */
export function scenarioName(scenario: Scenario): string {
  const screen = screenTitle(scenario);
  const own = scenarioLabel(scenario.id);
  return own.toLowerCase() === screen.toLowerCase() ? screen : `${screen} (${own})`;
}

/** One frame's whole name, the way its artboard's Open button says it: "Booking, room held — phone (Lantern held)". */
export function frameName(scenario: Scenario, view: string): string {
  return `${artboardLabel(scenario, view)} (${scenarioLabel(scenario.id)})`;
}

/** A frame known only by its key, named from the frames in hand; its key when it is not among them. */
export function frameNameOf(key: string, frames: readonly FrameSpec[]): string {
  const spec = frames.find((frame) => frame.key === key);
  return spec ? frameName(spec.scenario, spec.view.name) : key;
}

/** A scenario known only by its id, named from the scenarios in hand; its id in words when it is not among them. */
export function scenarioNameOf(id: string, scenarios: readonly Scenario[]): string {
  const scenario = scenarios.find((item) => item.id === id);
  return scenario ? scenarioName(scenario) : scenarioLabel(id);
}

/** An example of a proposal, by the name its author gave it: "two-toasts" is "Two toasts". */
export function exampleLabel(name: string): string {
  return humanize(name);
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

/** Where a finding's elements are outlined, in words, for the line under a selected finding: scenarios by name, never by id. */
export function describeOutline(plan: OutlinePlan, frames: readonly FrameSpec[]): string {
  const specs = plan.frames.flatMap((item) => frames.find((frame) => frame.key === item.key) ?? []);
  const scenarios = frames.map((frame) => frame.scenario);
  const drawn = [...new Map(specs.map((spec) => [spec.scenario.id, scenarioName(spec.scenario)])).values()];
  const parts: string[] = [];
  if (drawn.length > 0) parts.push(`Outlined in ${plan.frames.length} ${plan.frames.length === 1 ? "frame" : "frames"}: ${drawn.join("; ")}.`);
  if (plan.missing.length > 0) parts.push(`Not drawn in ${plan.missing.map((id) => scenarioNameOf(id, scenarios)).join("; ")}.`);
  if (plan.unmeasured.length > 0) parts.push(`Not measured in ${plan.unmeasured.map((key) => frameNameOf(key, frames)).join("; ")}.`);
  if (parts.length === 0) parts.push("Not drawn in any scenario.");
  return parts.join(" ");
}

/**
 * What is still pending, plainly: how many frames have answered, how many
 * are being measured now and how many wait their turn (frames near the
 * screen go first, the rest are measured out of sight), or, once every
 * frame has answered, that core is checking them.
 */
export function pendingWords(state: SessionState): string {
  const count = (value: FrameState["state"]) => state.frames.filter((frame) => state.frameStates[frame.key]?.state === value).length;
  const frames = state.frames.length;
  const answered = count("measured") + count("failed");
  if (answered === frames) return `Every frame has answered; core is checking the ${frames} ${frames === 1 ? "snapshot" : "snapshots"}.`;
  const rendering = count("rendering");
  const waiting = count("waiting");
  return `Measuring the frames: ${answered} of ${frames} answered, ${rendering} measuring now, ${waiting} waiting their turn. Rules about the rendered page wait for every frame.`;
}
