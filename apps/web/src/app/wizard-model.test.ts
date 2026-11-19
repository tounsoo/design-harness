import { describe, expect, it } from "vitest";
import { buildProject, confirmRoles, defaultStarterRules, draftRoles, roleOptions, type LibraryDescription } from "@design-harness/core";
import todaeJson from "../../../../packages/core/libraries/todae-0.11.3.json";
import { SHIPPED_LIBRARIES } from "../libraries/registry";
import { recallProject, rememberProject } from "./projects";
import { STEP, answersOf, choicesOf, componentsOf, exclusionOf, initialExclusion, initialRoles, mappingsOf, roleStanding, routeIssue, togglePart, toggleValue, type WizardState } from "./wizard-model";

const todae = todaeJson as unknown as LibraryDescription;
const draft = draftRoles(todae);
const shipped = SHIPPED_LIBRARIES[0];
if (!shipped) throw new Error("no shipped library");
const library = { source: "shipped:todae", name: "Todae", description: todae, setup: shipped.setup, notes: [] };
const fresh: WizardState = { name: "Ledger", library, roles: initialRoles(draft), exclusion: initialExclusion(draft), components: null, rules: defaultStarterRules() };
const accepted = (state: WizardState): WizardState => ({ ...state, roles: Object.fromEntries(Object.entries(state.roles ?? {}).map(([role, value]) => [role, { ...value, accepted: true }])) as WizardState["roles"], exclusion: { ...state.exclusion, accepted: true } });

/** What core says of a wizard state, by step. */
function refusals(state: WizardState) {
  const answers = answersOf(state, draft, ["nook"]);
  if (!answers) throw new Error("no answers");
  const built = buildProject(answers);
  return built.ok ? [] : built.error.map(routeIssue).map((issue) => [issue.step, issue.role ?? null, issue.message]);
}

describe("the wizard's state as core's answers", () => {
  it("starts with every drafted role undecided, which core refuses role by role, on the roles step, and the style props on theirs", () => {
    expect(Object.values(fresh.roles ?? {}).every((role) => !role.accepted)).toBe(true);
    const found = refusals(fresh);
    expect(found.filter(([step]) => step === STEP.roles).map(([, role]) => role)).toEqual(["action", "primary-action", "secondary-action", "disclosure", "disclosure-summary", "question"]);
    expect(found.filter(([step]) => step === STEP.exclusion)).toHaveLength(1);
    expect(found.every(([step]) => step === STEP.roles || step === STEP.exclusion)).toBe(true);
  });

  it("builds once every role and the style props are accepted, with core's starting inventory", () => {
    const state = accepted(fresh);
    expect(refusals(state)).toEqual([]);
    expect(componentsOf(state)).toEqual(["Alert", "Badge", "Button", "Card", "Disclosure", "EmptyState", "Field", "Label", "Stack", "Table", "Text"]);
    expect(exclusionOf(draft, state.exclusion)).toBe("accept");
  });

  it("makes a changed role a correction, which needs its reason, and adds its part to the inventory", () => {
    const base = accepted(fresh);
    const options = roleOptions(todae, "question", mappingsOf(base.roles ?? initialRoles(draft)));
    const mapping = togglePart(options, { components: ["Field.Root"] }, "Switch.Root", true);
    expect(mapping).toEqual({ components: ["Field.Root", "Switch.Root"] });
    const changed: WizardState = { ...base, roles: { ...(base.roles ?? initialRoles(draft)), question: { mapping, why: "", accepted: false } } };
    expect(roleStanding(draft, "question", changed.roles?.question ?? { mapping, why: "", accepted: false })).toBe("corrected");
    expect(refusals(changed)).toEqual([[STEP.roles, "question", 'the correction of "question" gives no reason']]);
    const reasoned: WizardState = { ...changed, roles: { ...(changed.roles ?? initialRoles(draft)), question: { mapping, why: "A switch asks too.", accepted: false } } };
    expect(refusals(reasoned)).toEqual([]);
    expect(componentsOf(reasoned)).toContain("Switch");
    const confirmed = confirmRoles(todae, answersOf(reasoned, draft, [])?.confirmation ?? { accept: [] });
    expect(confirmed.ok && confirmed.value.record.find((entry) => entry.role === "question")).toMatchObject({ decision: "corrected", why: "A switch asks too." });
    // Unchecking it again is the draft once more, not accepted yet.
    const back = togglePart(options, mapping, "Switch.Root", false);
    expect(roleStanding(draft, "question", { mapping: back, why: "", accepted: false })).toBe("drafted");
    expect(choicesOf(draft, { ...(base.roles ?? initialRoles(draft)), question: { mapping: back, why: "", accepted: false } }).question).toBeUndefined();
  });

  it("keeps a prop role's values in the library's order, and leaves the role with no part when none is checked", () => {
    const options = roleOptions(todae, "primary-action", mappingsOf(fresh.roles ?? initialRoles(draft)));
    const primary = { components: ["Button.Root"], prop: { name: "variant", values: ["primary"], whenMissing: true } };
    expect(toggleValue(options, primary, "ghost", true)).toEqual({ components: ["Button.Root"], prop: { name: "variant", values: ["ghost", "primary"], whenMissing: true } });
    const none = toggleValue(options, primary, "primary", false);
    expect(none).toEqual({ components: [] });
    expect(roleStanding(draft, "primary-action", { mapping: none, why: "", accepted: false })).toBe("none");
    expect(toggleValue(options, none, "secondary", true)).toEqual({ components: ["Button.Root"], prop: { name: "variant", values: ["secondary"], whenMissing: false } });
  });

  it("sends a changed list of style props to core with its reason, and core's refusal of rule inputs to their step", () => {
    const state = accepted(fresh);
    const changed: WizardState = { ...state, exclusion: { props: ["style"], why: "", accepted: false } };
    expect(exclusionOf(draft, changed.exclusion)).toEqual({ props: ["style"], why: "" });
    expect(refusals(changed)).toEqual([[STEP.exclusion, null, "the excluded props give no reason"]]);
    expect(refusals({ ...state, name: "!", rules: { ...state.rules, primaryAction: "" } }).map(([step]) => step)).toEqual([STEP.name, STEP.rules]);
    expect(routeIssue({ path: "$.config.rules[3]", message: "x" }).step).toBe(STEP.create);
  });

  it("has no answers before a library is picked", () => {
    expect(answersOf({ ...fresh, library: null, roles: null }, null, [])).toBeNull();
    expect(componentsOf({ ...fresh, library: null, roles: null })).toEqual([]);
  });
});

describe("the project last open", () => {
  it("is remembered and recalled, and blocked storage only means it is not", () => {
    const held = new Map<string, string>();
    const storage = { getItem: (key: string) => held.get(key) ?? null, setItem: (key: string, value: string) => void held.set(key, value) };
    expect(recallProject(storage)).toBeNull();
    rememberProject("ledger", storage);
    expect(recallProject(storage)).toBe("ledger");
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(recallProject(blocked)).toBeNull();
    expect(() => rememberProject("ledger", blocked)).not.toThrow();
  });
});
