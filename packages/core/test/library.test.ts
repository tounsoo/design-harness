import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nook } from "../examples/nook/project";
import { describeLibrary, descriptionText, installedDir } from "../scripts/describe-library.mjs";
import { BUILT_IN_RULES } from "../src/builtins";
import { confirmRoles, draftRoles, missingRoleEffects, type LibraryDescription, type RoleConfirmation } from "../src/library/roles";
import { parseProjectConfig } from "../src/parse";

/**
 * Bringing a library: the describer reads any React library's declarations
 * into parts and props, the same way every time; the drafter proposes a role
 * mapping from them with its evidence; and nothing reaches a config until a
 * confirmation says so.
 */
const LIBRARIES = join(import.meta.dirname, "..", "libraries");
const FIXTURE = join(import.meta.dirname, "library-fixture", "fixture-ui");
const read = (file: string) => JSON.parse(readFileSync(join(LIBRARIES, file), "utf8")) as LibraryDescription;
const todae = read("todae-0.11.3.json");
const mantine = read("mantine-core-9.7.4.json");

describe("describing a library from its declarations", () => {
  const fixture = describeLibrary(FIXTURE);

  it("finds compound parts, plain components, namespace members and statics, and nothing else", () => {
    expect(Object.keys(fixture.parts)).toEqual(["Accordion", "Accordion.Item", "Accordion.Trigger", "Amount", "Badge", "Box", "Button.Icon", "Button.Root", "Callout.Root", "Callout.Text", "Measure", "Select"]);
    expect(fixture.package).toBe("fixture-ui");
    expect(fixture.version).toBe("1.2.3");
  });

  it("reads enums, booleans, numbers and text, and records what it cannot read as unknown", () => {
    expect(fixture.parts["Button.Root"]?.props).toEqual({
      "aria-label": { type: "string", required: false },
      count: { type: "number", required: false },
      extra: { type: "unknown", required: false },
      gap: { type: "enum", values: ["1", "2"], required: false },
      gradient: { type: "unknown", required: false },
      hint: { type: "string", required: false },
      id: { type: "string", required: false },
      label: { type: "string", required: false },
      loading: { type: "boolean", required: false },
      order: { type: "number", required: false },
      size: { type: "enum", values: ["md", "sm"], required: false },
      variant: { type: "enum", values: ["ghost", "primary", "secondary"], required: false },
      width: { type: "unknown", required: false },
    });
  });

  it("reads children, presses, bindings and what a spec cannot give", () => {
    expect(fixture.parts["Button.Root"]).toMatchObject({ content: "children", events: ["press"] });
    expect(fixture.parts["Button.Icon"]).toEqual({ props: { name: { type: "enum", values: ["check", "close"], required: true } }, content: "none" });
    expect(fixture.parts.Measure).toEqual({ props: {}, content: "none", needs: ["children"] });
    expect(fixture.parts.Select).toEqual({ props: { data: { type: "unknown", required: true }, value: { type: "string", required: false, bind: "onValueChange" } }, content: "none", needs: ["data"] });
    // onValueChange reports an object, not the string value takes: not a binding.
    expect(fixture.parts.Amount?.props.value).toEqual({ type: "string", required: false });
  });

  it("reads a polymorphic component as a tag instantiates it, with its default element", () => {
    expect(fixture.parts.Box).toEqual({
      props: {
        "aria-label": { type: "string", required: false },
        c: { type: "string", required: false },
        component: { type: "enum", values: ["div"], required: false },
        id: { type: "string", required: false },
        m: { type: "enum", values: ["md", "xs"], required: false },
        padding: { type: "enum", values: ["md", "xs"], required: false },
        sx: { type: "unknown", required: false },
      },
      content: "children",
      events: ["press"],
    });
  });

  it("marks style props: by name, and every prop of a library's own style-prop set", () => {
    expect(fixture.styleProps).toEqual({ names: ["c", "className", "m", "style", "sx"], sets: ["FixtureStyleProps"] });
    expect(todae.styleProps).toEqual({ names: ["className", "style"], sets: [] });
    expect(mantine.styleProps?.sets).toEqual(["MantineStyleProps"]);
    expect(mantine.styleProps?.names).toEqual(expect.arrayContaining(["bg", "c", "className", "fz", "m", "p", "style", "w"]));
  });

  it("is deterministic: the same package gives byte-identical text", () => {
    expect(descriptionText(describeLibrary(FIXTURE))).toBe(descriptionText(fixture));
  });

  it("writes Todae 0.11.3's description byte for byte as committed, from the copy in node_modules", { timeout: 300_000 }, () => {
    const dir = installedDir("@tounsoo/todae", "0.11.3");
    expect(dir).not.toBeNull();
    expect(descriptionText(describeLibrary(dir as string))).toBe(readFileSync(join(LIBRARIES, "todae-0.11.3.json"), "utf8"));
  });

  it("carries the description Nook uses, at its library's exact version", () => {
    expect([todae.package, todae.version]).toEqual([nook.library.package, nook.library.version]);
    expect(nook.library.parts).toEqual(todae.parts);
  });
});

describe("drafting roles", () => {
  it("reproduces Nook's hand-written roles from Todae's description", () => {
    const draft = draftRoles(todae);
    expect(draft.missing).toEqual([]);
    expect(Object.fromEntries(draft.guesses.map((guess) => [guess.role, guess.mapping]))).toEqual(nook.library.roles);
    // Every guess is sure but one: Todae's declarations do not say a Button.Root with no variant is primary, which Nook's author knew.
    expect(draft.guesses.map((guess) => [guess.role, guess.confidence])).toEqual([
      ["action", "high"],
      ["primary-action", "medium"],
      ["secondary-action", "high"],
      ["disclosure", "high"],
      ["disclosure-summary", "high"],
      ["question", "high"],
    ]);
    expect(draft.guesses[1]?.evidence.join(" ")).toContain("whenMissing is true");
    expect(draft.excludedProps?.props).toEqual(nook.library.excludedProps);
  });

  it("proposes excluding a library's style props, with evidence", () => {
    const draft = draftRoles(mantine);
    expect(draft.excludedProps?.props).toEqual(mantine.styleProps?.names);
    expect(draft.excludedProps?.confidence).toBe("high");
    expect(draft.excludedProps?.evidence.join(" ")).toContain("MantineStyleProps");
    expect(draftRoles({ ...mantine, styleProps: undefined as never }).excludedProps).toBeNull();
  });

  it("drafts Mantine's roles from names, props and enum values, each with evidence", () => {
    const draft = draftRoles(mantine);
    expect(draft.missing).toEqual([]);
    expect(draft.guesses.map((guess) => [guess.role, guess.mapping, guess.confidence])).toEqual([
      ["action", { components: ["Button"] }, "high"],
      ["primary-action", { components: ["Button"], prop: { name: "variant", values: ["filled"], whenMissing: true } }, "medium"],
      ["secondary-action", { components: ["Button"], prop: { name: "variant", values: ["outline"], whenMissing: false } }, "medium"],
      ["disclosure", { components: ["Accordion.Item"] }, "medium"],
      ["disclosure-summary", { components: ["Accordion.Control"] }, "medium"],
      ["question", { components: ["TextInput"] }, "medium"],
    ]);
    for (const guess of draft.guesses) expect(guess.evidence.length).toBeGreaterThan(0);
    expect(draft.guesses.find((guess) => guess.role === "question")?.evidence.join(" ")).toContain("NumberInput");
  });

  it("lists the roles it cannot find, and what each rule that needs them will do", () => {
    const draft = draftRoles(describeLibrary(FIXTURE));
    expect(draft.guesses.map((guess) => [guess.role, guess.mapping])).toEqual([
      ["action", { components: ["Button.Root"] }],
      ["primary-action", { components: ["Button.Root"], prop: { name: "variant", values: ["primary"], whenMissing: true } }],
      ["secondary-action", { components: ["Button.Root"], prop: { name: "variant", values: ["secondary"], whenMissing: false } }],
      ["disclosure", { components: ["Accordion.Item"] }],
      ["disclosure-summary", { components: ["Accordion.Trigger"] }],
    ]);
    expect(draft.missing).toEqual([{ role: "question", why: "no part is named Field, FormField, FormControl, TextField, TextInput" }]);
    const effects = missingRoleEffects(BUILT_IN_RULES, ["question"]);
    expect(effects.map((effect) => [effect.role, effect.rules.map((rule) => rule.rule)])).toEqual([["question", ["counted-parts-reached", "visible-questions"]]]);
    expect(effects[0]?.rules[0]?.effect).toContain("the config is refused until the rule is removed");
  });

  it("gives the same draft whatever order the parts come in", () => {
    const reversed = { ...mantine, parts: Object.fromEntries(Object.entries(mantine.parts).reverse()) };
    expect(draftRoles(reversed)).toEqual(draftRoles(mantine));
  });
});

describe("confirming roles", () => {
  const accept: RoleConfirmation["accept"] = ["action", "primary-action", "secondary-action", "disclosure", "disclosure-summary", "question"];

  it("applies nothing on its own: a role neither accepted nor corrected is refused", () => {
    const confirmed = confirmRoles(todae, { accept: accept.filter((role) => role !== "question"), excludedProps: "accept" });
    expect(confirmed.ok).toBe(false);
    expect(confirmed.ok ? [] : confirmed.error.map((issue) => issue.message)).toEqual(['role "question" is not confirmed: accept the draft (Field.Root) or correct it']);
  });

  it("refuses leaving the excluded style props undecided, and records how they were decided", () => {
    const undecided = confirmRoles(todae, { accept });
    expect(undecided.ok ? [] : undecided.error.map((issue) => issue.message)).toEqual(['the excluded props are not confirmed: accept the draft (2 style props, "className", "style") or give a list with why']);
    const narrower = confirmRoles(mantine, { accept: ["action", "primary-action", "secondary-action", "disclosure", "disclosure-summary", "question"], excludedProps: { props: ["style", "className", "bg"], why: "Only these." } });
    expect(narrower.ok && narrower.value.exclusion).toEqual({ decision: "corrected", props: ["bg", "className", "style"], drafted: mantine.styleProps?.names, why: "Only these." });
    const noReason = confirmRoles(mantine, { accept: ["action", "primary-action", "secondary-action", "disclosure", "disclosure-summary", "question"], excludedProps: { props: [], why: " " } });
    expect(noReason.ok ? [] : noReason.error.map((issue) => issue.message)).toEqual(["the excluded props give no reason"]);
  });

  it("turns an accepted draft into the roles and excluded props a valid config carries", () => {
    const confirmed = confirmRoles(todae, { accept, excludedProps: "accept" });
    if (!confirmed.ok) throw new Error(JSON.stringify(confirmed.error));
    expect(confirmed.value.roles).toEqual(nook.library.roles);
    expect(confirmed.value.excludedProps).toEqual(nook.library.excludedProps);
    expect(parseProjectConfig(JSON.parse(JSON.stringify({ ...nook, library: { ...nook.library, roles: confirmed.value.roles } }))).ok).toBe(true);
  });

  it("records each correction with the draft it replaced and why, and refuses one without a reason, a part the library lacks, or a value its enum lacks", () => {
    const corrected = confirmRoles(mantine, {
      accept: accept.filter((role) => role !== "secondary-action"),
      excludedProps: "accept",
      corrections: { "secondary-action": { mapping: { components: ["Button"], prop: { name: "variant", values: ["default", "outline"], whenMissing: false } }, why: "Both quiet styles are secondary here." } },
    });
    if (!corrected.ok) throw new Error(JSON.stringify(corrected.error));
    expect(corrected.value.record.find((entry) => entry.role === "secondary-action")).toEqual({
      role: "secondary-action",
      decision: "corrected",
      mapping: { components: ["Button"], prop: { name: "variant", values: ["default", "outline"], whenMissing: false } },
      drafted: { components: ["Button"], prop: { name: "variant", values: ["outline"], whenMissing: false } },
      why: "Both quiet styles are secondary here.",
    });
    const refused = confirmRoles(mantine, {
      accept: accept.filter((role) => role !== "secondary-action" && role !== "question"),
      excludedProps: "accept",
      corrections: {
        "secondary-action": { mapping: { components: ["Button"], prop: { name: "variant", values: ["secondary"], whenMissing: false } }, why: "" },
        question: { mapping: { components: ["Field.Root"] }, why: "Mantine has a field." },
      },
    });
    expect(refused.ok ? [] : refused.error.map((issue) => issue.message)).toEqual([
      "the correction of \"secondary-action\" gives no reason",
      'names "secondary", which Button\'s variant does not hold ("default", "filled", "gradient", "light", "outline", "subtle", "transparent", "white")',
      "names Field.Root, which @mantine/core 9.7.4 has no part of",
    ]);
  });

  it("refuses accepting a role the draft could not find; the library having none is a correction saying so", () => {
    const fixture = describeLibrary(FIXTURE);
    const refused = confirmRoles(fixture, { accept, excludedProps: "accept" });
    expect(refused.ok ? [] : refused.error.map((issue) => issue.message)).toEqual(['role "question" is accepted, but the draft has no guess for it: correct it instead']);
    const none = confirmRoles(fixture, { accept: accept.filter((role) => role !== "question"), excludedProps: "accept", corrections: { question: { mapping: { components: [] }, why: "This library has no form controls." } } });
    expect(none.ok && none.value.roles.question).toEqual({ components: [] });
  });
});
