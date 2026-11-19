import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nook } from "../examples/nook/project";
import { tally } from "../examples/tally/project";
import { checkPrototype } from "../src/engine/check";
import {
  STARTER_LAYOUT,
  buildProject,
  confirmationFrom,
  defaultStarterRules,
  projectId,
  roleOptions,
  rolePreview,
  starterInventory,
  textParts,
  type LibrarySetup,
  type ProjectAnswers,
  type RoleChoice,
} from "../src/library/project";
import { draftRoles, type LibraryDescription } from "../src/library/roles";
import { parseLibraryDescription, parseProjectConfig, parsePrototype } from "../src/parse";
import { ROLE_NAMES, type RoleName } from "../src/rules/types";
import { readSpecs } from "../src/spec/read";

/**
 * Starting a project from a wizard's answers, on the two libraries the
 * repository describes: the config is one core's own validation accepts,
 * the starter prototype follows every rule that runs without a renderer
 * (the end-to-end tests measure the rendered ones in Chromium), and what a
 * person may not leave undecided or get wrong is refused by name.
 */
const read = (file: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "libraries", file), "utf8")) as LibraryDescription;
const todae = read("todae-0.11.3.json");
const mantine = read("mantine-core-9.7.4.json");
const TODAE: LibrarySetup = { react: "19.3.1", stylesheets: ["dist/todae.css"], schemeAttribute: "data-appearance", rules: nook.rules.filter((rule) => rule.id === "text-as-heading-or-paragraph") };
const MANTINE: LibrarySetup = { react: "19.3.1", stylesheets: ["styles.css"], root: { component: "MantineProvider", schemeProp: "forceColorScheme" }, rules: tally.rules.filter((rule) => rule.id === "title-order"), partProps: { Button: { color: "violet" } } };
const LIBRARIES = [
  ["Todae", todae, TODAE],
  ["Mantine", mantine, MANTINE],
] as const;

function drafted(description: LibraryDescription): Record<RoleName, RoleChoice> {
  return Object.fromEntries(draftRoles(description).guesses.map((guess) => [guess.role, { mapping: guess.mapping }])) as Record<RoleName, RoleChoice>;
}

function answers(description: LibraryDescription, setup: LibrarySetup, change: Partial<ProjectAnswers> = {}, choices: Partial<Record<RoleName, RoleChoice>> = {}): ProjectAnswers {
  return { name: "Ledger", takenIds: ["nook"], description, setup, confirmation: confirmationFrom(draftRoles(description), { ...drafted(description), ...choices }, "accept"), rules: defaultStarterRules(), ...change };
}

function built(input: ProjectAnswers) {
  const result = buildProject(input);
  if (!result.ok) throw new Error(result.error.map((issue) => `${issue.path} ${issue.message}`).join("\n"));
  return result.value;
}

const refusal = (input: ProjectAnswers) => {
  const result = buildProject(input);
  return result.ok ? [] : result.error.map((issue) => `${issue.path} ${issue.message}`);
};

describe.each(LIBRARIES)("a project built on %s from the draft as it is", (_name, description, setup) => {
  const project = built(answers(description, setup));

  it("is a config core's validation accepts, as JSON", () => {
    const parsed = parseProjectConfig(JSON.parse(JSON.stringify(project.config)));
    expect(parsed.ok ? [] : parsed.error).toEqual([]);
    expect(project.config.id).toBe("ledger");
    expect(project.config.name).toBe("Ledger");
  });

  it("carries the confirmed roles, the excluded props, and the record of how each was decided", () => {
    const draft = draftRoles(description);
    expect(project.config.library.roles).toEqual(Object.fromEntries(draft.guesses.map((guess) => [guess.role, guess.mapping])));
    expect(project.config.library.excludedProps).toEqual(draft.excludedProps?.props);
    expect(project.config.library.confirmed?.roles.map((entry) => entry.decision)).toEqual(ROLE_NAMES.map(() => "accepted"));
    expect(project.config.library.confirmed?.exclusion.decision).toBe("accepted");
  });

  it("carries the description of exactly the components it inventories and its root", () => {
    const keep = new Set([...project.config.inventories.components, ...(setup.root ? [setup.root.component] : [])]);
    expect(Object.keys(project.config.library.parts ?? {})).toEqual(Object.keys(description.parts).filter((part) => keep.has(part.split(".")[0] as string)).sort());
    expect(project.config.inventories.components).toEqual(starterInventory(description, project.config.library.roles));
  });

  it("puts every built-in rule and the library's own in force, and drops none", () => {
    expect(project.dropped).toEqual([]);
    expect(project.unranked).toEqual([]);
    expect(project.config.rules.map((rule) => rule.id)).toEqual([...nook.rules.filter((rule) => rule.id !== "text-as-heading-or-paragraph").map((rule) => rule.id), ...(setup.rules ?? []).map((rule) => rule.id)]);
  });

  it("writes a starter prototype that validates and follows every rule that runs without a renderer", () => {
    if (!project.starter.ok) throw new Error(project.starter.error);
    const prototype = project.starter.value;
    expect(parsePrototype(JSON.parse(JSON.stringify(prototype))).ok).toBe(true);
    expect(readSpecs(prototype, project.config).issues).toEqual([]);
    const report = checkPrototype({ config: project.config, prototype });
    expect(report.findings).toEqual([]);
    expect(report.rules.filter((rule) => rule.status !== "pass").map((rule) => [rule.rule, rule.status])).toEqual(
      project.config.rules.filter((rule) => rule.type === "rendered").map((rule) => [rule.id, "not-run"]).sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
    );
    // One scenario per flow state, the start and each task done, and the starter layout registered.
    expect(prototype.scenarios.map((scenario) => scenario.state)).toEqual(project.config.inventories.flowStates);
    expect(prototype.layouts.map((layout) => layout.id)).toEqual([STARTER_LAYOUT]);
  });

  it("is the same project from the same answers", () => {
    expect(JSON.stringify(built(answers(description, setup)))).toBe(JSON.stringify(project));
  });

  it("draws every drafted role as a spec its own preview config reads without an issue", () => {
    const roles = project.config.library.roles;
    for (const role of ROLE_NAMES) {
      const preview = rolePreview(description, setup, role, roles, "dark");
      if (!preview.ok) throw new Error(`${role}: ${preview.why}`);
      expect(parseProjectConfig(JSON.parse(JSON.stringify(preview.config))).ok, role).toBe(true);
      expect(readSpecs(preview.prototype, preview.config).issues, role).toEqual([]);
      expect(preview.config.views.map((view) => view.scheme)).toEqual(["dark"]);
      expect(preview.config.rules).toEqual([]);
    }
  });
});

describe("the choices a person makes", () => {
  it("accepts a mapping that is the draft's and corrects any other, with its reason", () => {
    const draft = draftRoles(mantine);
    const confirmation = confirmationFrom(draft, { ...drafted(mantine), question: { mapping: { components: ["TextInput", "NumberInput"] }, why: "An amount is a question too." } }, "accept");
    expect(confirmation.accept).toEqual(["action", "primary-action", "secondary-action", "disclosure", "disclosure-summary"]);
    expect(confirmation.corrections).toEqual({ question: { mapping: { components: ["TextInput", "NumberInput"] }, why: "An amount is a question too." } });
    expect(confirmation.excludedProps).toBe("accept");
    // A list equal to the draft's is an acceptance, whatever order it comes in.
    expect(confirmationFrom(draft, drafted(mantine), { props: [...(draft.excludedProps?.props ?? [])].reverse(), why: "" }).excludedProps).toBe("accept");
  });

  it("builds Tally's roles from Tally's one correction, and keeps the reason in the config", () => {
    const why = "Tally asks for an amount, and NumberInput takes one answer as TextInput does.";
    const project = built(answers(mantine, MANTINE, {}, { question: { mapping: { components: ["NumberInput", "TextInput"] }, why } }));
    expect(project.config.library.roles).toEqual(tally.library.roles);
    expect(project.config.inventories.components).toContain("NumberInput");
    expect(project.config.library.confirmed?.roles.find((entry) => entry.role === "question")).toEqual({ role: "question", decision: "corrected", mapping: { components: ["NumberInput", "TextInput"] }, drafted: { components: ["TextInput"] }, why });
    if (!project.starter.ok) throw new Error(project.starter.error);
  });

  it("lists what each role could be, the draft first", () => {
    const roles = Object.fromEntries(draftRoles(mantine).guesses.map((guess) => [guess.role, guess.mapping]));
    expect(roleOptions(mantine, "primary-action", roles)).toEqual({ kind: "values", components: ["Button"], prop: "variant", values: ["default", "filled", "gradient", "light", "outline", "subtle", "transparent", "white"] });
    expect(roleOptions(mantine, "disclosure", roles)).toEqual({ kind: "parts", parts: ["Accordion.Item", "Accordion", "Collapse"] });
    expect(roleOptions(mantine, "disclosure-summary", roles)).toEqual({ kind: "parts", parts: ["Accordion.Control"] });
    const questions = roleOptions(mantine, "question", roles);
    expect(questions.kind === "parts" ? questions.parts.slice(0, 1) : []).toEqual(["TextInput"]);
    expect(questions.kind === "parts" ? questions.parts : []).toEqual(expect.arrayContaining(["NumberInput", "Select", "Checkbox"]));
    expect(roleOptions(todae, "action")).toEqual({ kind: "parts", parts: ["Button.Root"] });
    expect(roleOptions(todae, "secondary-action")).toEqual({ kind: "values", components: ["Button.Root"], prop: "variant", values: ["ghost", "primary", "secondary"] });
    expect(roleOptions({ package: "bare", version: "1.0.0", parts: {} }, "disclosure").kind).toBe("none");
  });

  it("reads which parts write a heading and plain text", () => {
    expect(textParts(todae)).toEqual({ heading: { part: "Text.Root", props: { as: "h1" } }, text: { part: "Text.Root", props: { as: "p" } } });
    expect(textParts(mantine).heading).toEqual({ part: "Title", props: { order: 1 } });
    expect(textParts(mantine).text?.part).toBe("Text");
    expect(textParts({ package: "bare", version: "1.0.0", parts: {} })).toEqual({ heading: null, text: null });
  });

  it("draws a primary action once per value and once with no prop, and a disclosure inside its family's root", () => {
    const roles = Object.fromEntries(draftRoles(mantine).guesses.map((guess) => [guess.role, guess.mapping]));
    const elements = (role: RoleName) => {
      const preview = rolePreview(mantine, MANTINE, role, roles);
      if (!preview.ok) throw new Error(preview.why);
      return Object.values((JSON.parse(preview.prototype.files["pages/preview.json"] as string) as { elements: Record<string, { type: string; props: Record<string, unknown> }> }).elements);
    };
    expect(elements("primary-action").filter((element) => element.type === "Button").map((element) => element.props)).toEqual([
      { color: "violet", variant: "filled", text: "variant: filled" },
      { color: "violet", text: "no variant" },
    ]);
    expect(elements("disclosure").map((element) => element.type)).toEqual(["Accordion.Panel", "Accordion.Control", "Accordion.Item", "Accordion", "Page"]);
    expect(rolePreview(mantine, MANTINE, "question", { question: { components: [] } })).toEqual({ ok: false, why: "No part is mapped, so there is nothing to draw." });
  });
});

describe("a description file a person imports", () => {
  it("is read when it is what the describer writes, and refused by name when it is not", () => {
    const parsed = parseLibraryDescription(JSON.parse(JSON.stringify(todae)));
    expect(parsed.ok && parsed.value.package).toBe("@tounsoo/todae");
    expect(parseLibraryDescription(JSON.parse(JSON.stringify(mantine))).ok).toBe(true);
    const refused = parseLibraryDescription({ package: "Todae", version: "^1.0.0", parts: { button: { props: {}, content: "text" } }, extra: 1 });
    expect(refused.ok ? [] : refused.error.map((issue) => issue.path)).toEqual(expect.arrayContaining(["$.package", "$.version"]));
    expect(refused.ok).toBe(false);
    expect(parseLibraryDescription([]).ok).toBe(false);
  });
});

describe("a role the library has no part for", () => {
  const none = { mapping: { components: [] }, why: "This product has no disclosures." };
  const project = built(answers(todae, TODAE, {}, { disclosure: none, "disclosure-summary": none }));

  it("drops the rules that select it, saying which, and the config still validates", () => {
    expect(project.dropped.map((effect) => [effect.role, effect.rules.map((rule) => rule.rule)])).toEqual([
      ["disclosure", ["counted-parts-reached", "disclosed-sections", "disclosure-depth", "disclosures-per-page", "primary-outside-disclosure", "visible-questions"]],
      ["disclosure-summary", ["disclosed-sections"]],
    ]);
    const ids = project.config.rules.map((rule) => rule.id);
    for (const rule of project.dropped.flatMap((effect) => effect.rules)) expect(ids).not.toContain(rule.rule);
    expect(parseProjectConfig(JSON.parse(JSON.stringify(project.config))).ok).toBe(true);
    expect(project.config.inventories.components).not.toContain("Disclosure");
    if (!project.starter.ok) throw new Error(project.starter.error);
    expect(checkPrototype({ config: project.config, prototype: project.starter.value }).findings).toEqual([]);
  });

  it("leaves out the rank-2 rule when the project ranks one action", () => {
    const one = built(answers(todae, TODAE, { rules: { ...defaultStarterRules(), secondaryAction: " " } }));
    expect(one.unranked).toEqual(["rank-2-secondary"]);
    expect(one.config.inputs.ranking).toEqual([{ action: "Continue", rank: 1, level: "primary" }]);
    expect(one.config.rules.map((rule) => rule.id)).not.toContain("rank-2-secondary");
    if (!one.starter.ok) throw new Error(one.starter.error);
    expect(Object.keys(JSON.parse(one.starter.value.files["pages/home.json"] as string).elements)).not.toContain("secondary");
  });
});

describe("what buildProject refuses", () => {
  it("a name with nothing to make an id from", () => {
    expect(refusal(answers(todae, TODAE, { name: " ?! " }))).toEqual(["$.name the product needs a name with a letter or a digit"]);
  });

  it("a role left undecided, a correction without a reason, and a part the library lacks", () => {
    const draft = draftRoles(todae);
    const { question: _question, ...rest } = drafted(todae);
    expect(refusal(answers(todae, TODAE, { confirmation: confirmationFrom(draft, rest, "accept") }))).toEqual(['$.confirmation role "question" is not confirmed: accept the draft (Field.Root) or correct it']);
    expect(refusal(answers(todae, TODAE, {}, { question: { mapping: { components: ["Switch.Root"] } } }))).toEqual(['$.confirmation.corrections.question.why the correction of "question" gives no reason']);
    expect(refusal(answers(todae, TODAE, {}, { question: { mapping: { components: ["Dropdown"] }, why: "It asks." } }))).toEqual(["$.confirmation.corrections.question.mapping.components names Dropdown, which @tounsoo/todae 0.11.3 has no part of"]);
  });

  it("style props left undecided", () => {
    expect(refusal(answers(mantine, MANTINE, { confirmation: confirmationFrom(draftRoles(mantine), drafted(mantine)) }))[0]).toMatch(/^\$\.confirmation\.excludedProps the excluded props are not confirmed/);
  });

  it("tasks, actions and caps that no rule could read", () => {
    const rules = defaultStarterRules();
    expect(
      refusal(answers(todae, TODAE, { components: ["Button", "Carousel"], rules: { tasks: [{ name: "Pay", maxSteps: 0 }, { name: "pay!", maxSteps: 2 }, { name: "", maxSteps: 1.5 }], primaryAction: "", secondaryAction: "", caps: { ...rules.caps, TARGET_MIN_PX: 0, MAX_VISIBLE_QUESTIONS: 1.5 } } })),
    ).toEqual([
      "$.components names Carousel, which @tounsoo/todae 0.11.3 has no part of",
      "$.rules.tasks[0].maxSteps a task takes at least one step, as a whole number",
      '$.rules.tasks[1].name two tasks are named "pay!"',
      "$.rules.tasks[2].name the task needs a name with a letter or a digit",
      "$.rules.tasks[2].maxSteps a task takes at least one step, as a whole number",
      "$.rules.primaryAction the primary action needs its text: the rules find it by what it says",
      "$.rules.caps.MAX_VISIBLE_QUESTIONS is 1.5; it is a whole number, 1 or more",
      "$.rules.caps.TARGET_MIN_PX is 0; it is a whole number, 1 or more",
    ]);
    expect(refusal(answers(todae, TODAE, { rules: { ...rules, tasks: [] } }))).toEqual(["$.rules.tasks a project needs at least one task: the step budget rule reads it"]);
    expect(refusal(answers(todae, TODAE, { rules: { ...rules, secondaryAction: "Continue" } }))).toEqual(["$.rules.secondaryAction the secondary action has the primary action's text; the rules tell them apart by what they say"]);
  });

  it("writes no starter, and says why, when the inventory has no part to write a heading with", () => {
    const project = built(answers(mantine, MANTINE, { components: ["Text"] }));
    expect(project.starter).toEqual({ ok: false, error: expect.stringContaining("has no part this app can tell writes a heading") });
    expect(parseProjectConfig(JSON.parse(JSON.stringify(project.config))).ok).toBe(true);
  });

  it("gives a second project of one name its own id", () => {
    expect(projectId("Nook", ["nook", "nook-2"])).toBe("nook-3");
    expect(built(answers(todae, TODAE, { name: "Nook" })).config.id).toBe("nook-2");
  });
});
