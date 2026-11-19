import type { Confidence, ConfirmedExclusion, ConfirmedRole, PartDescription, RoleMapping } from "../config/types";

export type { Confidence, ConfirmedExclusion, ConfirmedRole };
import { ROLE_NAMES, type RoleName, type RuleSpec, type Selector } from "../rules/types";
import type { Issue, Result } from "../validate";

/**
 * Onboarding a component library's roles. Rules select elements by role
 * (`primary-action`, `disclosure`, ...), so a library is usable once each
 * role is mapped to its parts and prop values. `draftRoles` reads a library
 * description, the parts-and-props file `scripts/describe-library.mjs`
 * writes, and proposes a mapping from names, props and enum values, each
 * guess with a confidence and the evidence for it. The draft is never
 * applied by itself: `confirmRoles` turns a person's confirmation (which
 * guesses they accept, and each correction with why) into the `roles` a
 * config carries, and refuses a confirmation that leaves a role undecided.
 * It also proposes excluding the library's style props from specs
 * (`library.excludedProps`), which the confirmation decides too.
 * `missingRoleEffects` says, for a role the library has no part for, what
 * each rule that selects it will do.
 *
 * Pure and deterministic: the same description gives the same draft, in
 * the same order, whatever order its parts come in.
 */

/** A library's parts and props, as `scripts/describe-library.mjs` writes them. */
export type LibraryDescription = {
  readonly package: string;
  readonly version: string;
  readonly parts: Readonly<Record<string, PartDescription>>;
  /** The style props the describer recognised: `style`, `className`, `sx` and `css` by name, and every prop of a library's own style-prop sets (`sets`, such as MantineStyleProps). */
  readonly styleProps?: { readonly names: readonly string[]; readonly sets: readonly string[] };
};

/** The props the drafter proposes the config exclude (`library.excludedProps`), with its evidence. */
export type ExclusionGuess = { readonly props: readonly string[]; readonly confidence: Confidence; readonly evidence: readonly string[] };


/** One role the drafter could map: the mapping, how sure it is, and why, in words a reviewer checks against the library. */
export type RoleGuess = {
  readonly role: RoleName;
  readonly mapping: RoleMapping;
  readonly confidence: Confidence;
  readonly evidence: readonly string[];
};

/** A role the drafter found no part for, and why. */
export type MissingRole = { readonly role: RoleName; readonly why: string };

export type RoleDraft = {
  readonly package: string;
  readonly version: string;
  /** In `ROLE_NAMES` order. */
  readonly guesses: readonly RoleGuess[];
  readonly missing: readonly MissingRole[];
  /** Style props to exclude from specs, or null when the description names none. */
  readonly excludedProps: ExclusionGuess | null;
};

/**
 * What a person decided about a draft: the roles they accept as drafted, and
 * for every other role a mapping of their own with the reason. A role the
 * library has no part for is confirmed as a correction to `{ "components": [] }`,
 * saying so, and a project with such a role drops the rules that select it.
 */
export type RoleConfirmation = {
  readonly accept: readonly RoleName[];
  readonly corrections?: Readonly<Partial<Record<RoleName, { readonly mapping: RoleMapping; readonly why: string }>>>;
  /**
   * The style props to exclude: `"accept"` takes the draft's list, or a list
   * of names and `*` patterns of the person's own with why. Required when the
   * draft proposes some; an empty list with why keeps them all settable.
   */
  readonly excludedProps?: "accept" | { readonly props: readonly string[]; readonly why: string };
};

export type ConfirmedRoles = {
  readonly roles: Readonly<Record<RoleName, RoleMapping>>;
  /** What the config carries as `library.excludedProps`. */
  readonly excludedProps: readonly string[];
  readonly record: readonly ConfirmedRole[];
  readonly exclusion: ConfirmedExclusion;
};

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
const lower = (a: Confidence, b: Confidence): Confidence => (RANK[a] >= RANK[b] ? a : b);

/** A component family: every part named `<family>` or `<family>.<Member>`, and the part that stands for the whole (`X.Root`, else `X`). */
type Family = { readonly name: string; readonly parts: readonly string[]; readonly root: string | null };

function families(description: LibraryDescription): Map<string, Family> {
  const grouped = new Map<string, string[]>();
  for (const part of Object.keys(description.parts).sort(compare)) {
    const name = part.split(".")[0] as string;
    grouped.set(name, [...(grouped.get(name) ?? []), part]);
  }
  const out = new Map<string, Family>();
  for (const [name, parts] of grouped) out.set(name, { name, parts, root: parts.includes(`${name}.Root`) ? `${name}.Root` : parts.includes(name) ? name : null });
  return out;
}

/** The first family, in the order the names are given, that the library has, with a root part. */
function firstFamily(all: Map<string, Family>, names: readonly string[]): Family | null {
  for (const name of names) {
    const family = all.get(name);
    if (family?.root) return family;
  }
  return null;
}

const quote = (values: readonly string[]) => values.map((value) => JSON.stringify(value)).join(", ");

/** Props that name a button's emphasis, in the order they are tried. */
const EMPHASIS_PROPS = ["variant", "kind", "intent", "appearance", "emphasis", "priority", "color", "tone"] as const;
/** Values that mark the primary action, most telling first. */
const PRIMARY_VALUES: readonly (readonly [string, Confidence])[] = [
  ["primary", "high"],
  ["solid", "medium"],
  ["filled", "medium"],
  ["contained", "medium"],
  ["cta", "low"],
  ["accent", "low"],
];
/** Values that mark a secondary action, most telling first. */
const SECONDARY_VALUES: readonly (readonly [string, Confidence])[] = [
  ["secondary", "high"],
  ["outline", "medium"],
  ["outlined", "medium"],
  ["soft", "medium"],
  ["light", "low"],
  ["default", "low"],
  ["surface", "low"],
  ["tonal", "low"],
  ["subtle", "low"],
];

/** The first prop, in `EMPHASIS_PROPS` order, whose enum holds one of the values, and the most telling value it holds. */
function emphasis(part: PartDescription, values: readonly (readonly [string, Confidence])[]): { prop: string; value: string; confidence: Confidence; all: readonly string[] } | null {
  for (const [value, confidence] of values) {
    for (const prop of EMPHASIS_PROPS) {
      const schema = part.props[prop];
      if (schema?.type === "enum" && schema.values.includes(value)) return { prop, value, confidence, all: schema.values };
    }
  }
  return null;
}

const ACTION_FAMILIES = ["Button"] as const;
const DISCLOSURE_FAMILIES = ["Disclosure", "Details", "Collapsible", "Accordion", "Expandable", "Expander", "ExpansionPanel", "Collapse"] as const;
/** Members that are the part a person presses to open a disclosure, most telling first. */
const SUMMARY_MEMBERS: readonly (readonly [string, Confidence])[] = [
  ["Summary", "high"],
  ["Trigger", "high"],
  ["Control", "medium"],
  ["Header", "medium"],
  ["Button", "low"],
  ["Title", "low"],
];
const QUESTION_FAMILIES = ["Field", "FormField", "FormControl", "TextField", "TextInput"] as const;
/** Families that take an answer, offered as evidence when the drafter maps only one of them. */
const ANSWER_FAMILY = /(Input|Select|Textarea|TextArea|Checkbox|Radio|Switch|Slider|Combobox|Autocomplete|Picker)$/;

/** Proposes a role mapping from a library description: never applied until `confirmRoles`. */
export function draftRoles(description: LibraryDescription): RoleDraft {
  const all = families(description);
  const guesses: RoleGuess[] = [];
  const missing: MissingRole[] = [];
  const part = (name: string) => description.parts[name] as PartDescription;

  // action: the Button family's root, pressable and taking text.
  const button = firstFamily(all, ACTION_FAMILIES);
  const buttonPart = button?.root ?? null;
  if (!button || !buttonPart) {
    const pressable = [...all.values()].filter((family) => family.root && /Button$/.test(family.name)).map((family) => family.root as string);
    missing.push({ role: "action", why: `no part is named Button or Button.Root${pressable.length > 0 ? `; parts named like buttons: ${pressable.join(", ")}` : ""}` });
  } else {
    const described = part(buttonPart);
    const evidence = [`${buttonPart} is the Button family's ${buttonPart.endsWith(".Root") ? "root part" : "component"}`];
    let confidence: Confidence = "high";
    if (described.events?.includes("press")) evidence.push(`${buttonPart} takes onClick, so it can be pressed`);
    else {
      confidence = "medium";
      evidence.push(`${buttonPart} declares no onClick, so its declarations do not show it can be pressed`);
    }
    if (described.content === "children") evidence.push(`${buttonPart} takes children: its text is the action's name`);
    else {
      confidence = lower(confidence, "medium");
      evidence.push(`${buttonPart} takes no children, so its text cannot name the action`);
    }
    const others = [...all.values()].filter((family) => family !== button && family.root && /Button$/.test(family.name)).map((family) => family.root as string);
    if (others.length > 0) evidence.push(`not mapped, though named like buttons: ${others.join(", ")}; add any a page uses as an action`);
    guesses.push({ role: "action", mapping: { components: [buttonPart] }, confidence, evidence });

    // primary-action and secondary-action: the button's emphasis prop.
    const primary = emphasis(described, PRIMARY_VALUES);
    if (!primary) {
      const enums = Object.entries(described.props).filter(([, schema]) => schema.type === "enum").map(([name]) => name);
      missing.push({ role: "primary-action", why: `${buttonPart} has no ${EMPHASIS_PROPS.join(", ")} enum holding ${quote(PRIMARY_VALUES.map(([value]) => value))}${enums.length > 0 ? `; its enum props are ${enums.join(", ")}` : ""}` });
    } else {
      guesses.push({
        role: "primary-action",
        mapping: { components: [buttonPart], prop: { name: primary.prop, values: [primary.value], whenMissing: true } },
        // The declarations do not say which value a button without the prop draws, so whenMissing is a guess.
        confidence: lower(primary.confidence, "medium"),
        evidence: [
          `${buttonPart}'s ${primary.prop} is one of ${quote(primary.all)}, and ${JSON.stringify(primary.value)} ${primary.confidence === "high" ? "names the primary action" : "is the filled, strongest style"}`,
          `whenMissing is true: the declarations do not say which ${primary.prop} a ${buttonPart} without one draws, so one without it counts as primary, which the one-primary rules count against a page; confirm the library's default`,
        ],
      });
    }
    const secondary = primary ? emphasis(described, SECONDARY_VALUES.filter(([value]) => value !== primary.value)) : null;
    if (!primary) missing.push({ role: "secondary-action", why: `without a primary emphasis prop on ${buttonPart}, no value marks a secondary action` });
    else if (!secondary || secondary.prop !== primary.prop) missing.push({ role: "secondary-action", why: `${buttonPart}'s ${primary.prop} (${quote(primary.all)}) holds none of ${quote(SECONDARY_VALUES.map(([value]) => value))}` });
    else {
      const alternatives = SECONDARY_VALUES.map(([value]) => value).filter((value) => value !== secondary.value && value !== primary.value && secondary.all.includes(value));
      guesses.push({
        role: "secondary-action",
        mapping: { components: [buttonPart], prop: { name: secondary.prop, values: [secondary.value], whenMissing: false } },
        confidence: secondary.confidence,
        evidence: [
          `${buttonPart}'s ${secondary.prop} holds ${JSON.stringify(secondary.value)}, ${secondary.confidence === "high" ? "which names the secondary action" : "a quieter style than the primary"}`,
          ...(alternatives.length > 0 ? [`other quiet values it holds: ${quote(alternatives)}; add any the project uses for secondary actions`] : []),
        ],
      });
    }
  }

  // disclosure and disclosure-summary: one family that opens and closes.
  const disclosure = firstFamily(all, DISCLOSURE_FAMILIES);
  if (!disclosure) {
    missing.push({ role: "disclosure", why: `no part is named ${DISCLOSURE_FAMILIES.join(", ")}` });
    missing.push({ role: "disclosure-summary", why: "without a disclosure part, nothing summarises one" });
  } else {
    const item = disclosure.parts.includes(`${disclosure.name}.Item`) ? `${disclosure.name}.Item` : null;
    const opener = SUMMARY_MEMBERS.find(([member]) => disclosure.parts.includes(`${disclosure.name}.${member}`));
    const disclosurePart = item ?? (disclosure.root as string);
    const evidence = [`${disclosure.name} is a family that opens and closes`];
    let confidence: Confidence = opener ? "high" : "medium";
    if (item) {
      evidence.push(`${item} is one section of ${disclosure.name}, which opens and closes on its own, so each item is one disclosure`);
      confidence = "medium";
    } else evidence.push(`${disclosurePart} is the family's ${disclosurePart.endsWith(".Root") ? "root part" : "component"}`);
    if (!opener) evidence.push(`it has no ${SUMMARY_MEMBERS.map(([member]) => member).join(", ")} part to press`);
    const others = DISCLOSURE_FAMILIES.filter((name) => name !== disclosure.name && all.get(name)?.root);
    if (others.length > 0) evidence.push(`also open and close: ${others.join(", ")}; add any a page uses as a disclosure`);
    guesses.push({ role: "disclosure", mapping: { components: [disclosurePart] }, confidence, evidence });
    if (!opener) missing.push({ role: "disclosure-summary", why: `${disclosure.name} has no ${SUMMARY_MEMBERS.map(([member]) => member).join(", ")} part, so no element holds a disclosure's name` });
    else {
      const summary = `${disclosure.name}.${opener[0]}`;
      const takesText = part(summary).content === "children";
      guesses.push({
        role: "disclosure-summary",
        mapping: { components: [summary] },
        confidence: takesText ? opener[1] : "low",
        evidence: [`${summary} is the part a person presses to open ${disclosurePart}`, takesText ? `${summary} takes children: its text names the section` : `${summary} takes no children, so its text cannot name the section`],
      });
    }
  }

  // question: a field that takes one answer.
  const question = firstFamily(all, QUESTION_FAMILIES);
  if (!question) {
    missing.push({ role: "question", why: `no part is named ${QUESTION_FAMILIES.join(", ")}` });
  } else {
    const questionPart = question.root as string;
    const exact = question.name === "Field" || question.name === "FormField";
    const answers = [...all.values()].filter((family) => family !== question && family.root && ANSWER_FAMILY.test(family.name) && !family.name.startsWith("Unstyled")).map((family) => family.root as string);
    guesses.push({
      role: "question",
      mapping: { components: [questionPart] },
      confidence: exact ? "high" : "medium",
      evidence: [
        exact ? `${questionPart} is a field: it wraps one control and its label, so each is one question` : `${questionPart} is one labelled control, so each is one question`,
        ...(answers.length > 0 ? [`other parts that take an answer: ${answers.join(", ")}; add any a page uses as a question`] : []),
      ],
    });
  }

  const order = (role: RoleName) => ROLE_NAMES.indexOf(role);
  return {
    package: description.package,
    version: description.version,
    guesses: guesses.sort((a, b) => order(a.role) - order(b.role)),
    missing: missing.sort((a, b) => order(a.role) - order(b.role)),
    excludedProps: draftExclusion(description),
  };
}

/** Style props by name: they style any element directly. */
const NAMED_STYLE_PROPS = ["className", "css", "style", "sx"];

function draftExclusion(description: LibraryDescription): ExclusionGuess | null {
  const style = description.styleProps;
  if (!style || style.names.length === 0) return null;
  const props = [...new Set(style.names)].sort(compare);
  const named = props.filter((name) => NAMED_STYLE_PROPS.includes(name));
  const fromSets = props.filter((name) => !NAMED_STYLE_PROPS.includes(name));
  const evidence: string[] = [];
  if (named.length > 0) evidence.push(`${quote(named)} style any element directly, by name`);
  if (fromSets.length > 0) evidence.push(`${fromSets.length} props come from ${description.package}'s own style-prop set${style.sets.length > 1 ? "s" : ""} ${style.sets.join(", ")}: ${quote(fromSets)}`);
  evidence.push("a spec that sets them would style a part around the library's variants and tokens, so the catalog leaves them out and a spec that sets one is refused");
  return { props, confidence: "high", evidence };
}

/** Whether two mappings name the same parts and prop values, whatever order they list them in. */
export const sameMapping = (a: RoleMapping, b: RoleMapping) => JSON.stringify(normal(a)) === JSON.stringify(normal(b));
function normal(mapping: RoleMapping): RoleMapping {
  return { components: [...mapping.components].sort(compare), ...(mapping.prop ? { prop: { name: mapping.prop.name, values: [...mapping.prop.values].sort((a, b) => compare(String(a), String(b))), whenMissing: mapping.prop.whenMissing } } : {}) };
}

/**
 * The roles a config carries, from the description's draft and a person's
 * confirmation, with how each role was decided. Refuses (every problem, in
 * role order) a role neither accepted nor corrected, one both, an accepted
 * role the draft has no guess for, a correction without a reason or equal to
 * the draft, and a mapping that names a part the library lacks or a prop
 * value its enum does not hold.
 */
export function confirmRoles(description: LibraryDescription, confirmation: RoleConfirmation): Result<ConfirmedRoles> {
  const draft = draftRoles(description);
  const issues: Issue[] = [];
  const roles: Partial<Record<RoleName, RoleMapping>> = {};
  const record: ConfirmedRole[] = [];
  const corrections = confirmation.corrections ?? {};
  for (const role of Object.keys(corrections)) if (!(ROLE_NAMES as readonly string[]).includes(role)) issues.push({ path: `$.corrections.${role}`, message: `"${role}" is not a role; the roles are ${ROLE_NAMES.join(", ")}` });
  for (const role of confirmation.accept) if (!(ROLE_NAMES as readonly string[]).includes(role)) issues.push({ path: "$.accept", message: `"${role}" is not a role; the roles are ${ROLE_NAMES.join(", ")}` });
  for (const role of ROLE_NAMES) {
    const guess = draft.guesses.find((item) => item.role === role);
    const accepted = confirmation.accept.includes(role);
    const correction = corrections[role];
    const path = `$.corrections.${role}`;
    if (accepted && correction) {
      issues.push({ path, message: `role "${role}" is both accepted and corrected` });
      continue;
    }
    if (!accepted && !correction) {
      issues.push({ path: "$", message: guess ? `role "${role}" is not confirmed: accept the draft (${describeMapping(guess.mapping)}) or correct it` : `role "${role}" is not confirmed: the draft found no part (${draft.missing.find((item) => item.role === role)?.why ?? "none"}); correct it with a mapping, or with { "components": [] } to say the library has none` });
      continue;
    }
    if (accepted) {
      if (!guess) {
        issues.push({ path: "$.accept", message: `role "${role}" is accepted, but the draft has no guess for it: correct it instead` });
        continue;
      }
      roles[role] = guess.mapping;
      record.push({ role, decision: "accepted", mapping: guess.mapping, confidence: guess.confidence });
      continue;
    }
    const { mapping, why } = correction as { mapping: RoleMapping; why: string };
    if (why.trim() === "") issues.push({ path: `${path}.why`, message: `the correction of "${role}" gives no reason` });
    if (guess && sameMapping(guess.mapping, mapping)) issues.push({ path, message: `the correction of "${role}" is the draft itself: accept it instead` });
    for (const problem of mappingProblems(description, mapping)) issues.push({ path: `${path}.mapping.${problem.at}`, message: problem.message });
    roles[role] = mapping;
    record.push({ role, decision: "corrected", mapping, drafted: guess?.mapping ?? null, why });
  }
  const drafted = draft.excludedProps?.props ?? [];
  let exclusion: ConfirmedExclusion = { decision: "none", props: [] };
  const decided = confirmation.excludedProps;
  if (decided === undefined) {
    if (draft.excludedProps) issues.push({ path: "$.excludedProps", message: `the excluded props are not confirmed: accept the draft (${drafted.length} style props, ${quote(drafted.slice(0, 6))}${drafted.length > 6 ? ", ..." : ""}) or give a list with why` });
  } else if (decided === "accept") {
    if (!draft.excludedProps) issues.push({ path: "$.excludedProps", message: "the excluded props are accepted, but the draft proposes none: give a list with why instead" });
    else exclusion = { decision: "accepted", props: drafted };
  } else {
    if (decided.why.trim() === "") issues.push({ path: "$.excludedProps.why", message: "the excluded props give no reason" });
    const props = [...new Set(decided.props)].sort(compare);
    for (const prop of props) if (!/^[A-Za-z_$*][\w$*-]*$/.test(prop)) issues.push({ path: "$.excludedProps.props", message: `${JSON.stringify(prop)} is not a prop name or a pattern with *` });
    if (JSON.stringify(props) === JSON.stringify(drafted)) issues.push({ path: "$.excludedProps", message: "the excluded props are the draft's: accept them instead" });
    exclusion = { decision: "corrected", props, drafted, why: decided.why };
  }
  if (issues.length > 0) return { ok: false, error: issues };
  return { ok: true, value: { roles: roles as Record<RoleName, RoleMapping>, excludedProps: exclusion.props, record, exclusion } };
}

/**
 * What a role mapping names that a library does not have: a part it lacks,
 * a prop a part does not declare, or a prop value its enum does not hold.
 * `at` is where in the mapping, for an issue path. Empty when the library
 * has everything the mapping names.
 */
export function mappingProblems(description: LibraryDescription, mapping: RoleMapping): { readonly at: "components" | "prop" | "prop.values"; readonly message: string }[] {
  const problems: { at: "components" | "prop" | "prop.values"; message: string }[] = [];
  for (const component of mapping.components) {
    if (!(component in description.parts)) problems.push({ at: "components", message: `names ${component}, which ${description.package} ${description.version} has no part of` });
  }
  if (mapping.prop) {
    for (const component of mapping.components) {
      const schema = description.parts[component]?.props[mapping.prop.name];
      if (!(component in description.parts)) continue;
      if (!schema) problems.push({ at: "prop", message: `names prop "${mapping.prop.name}", which ${component} does not declare` });
      else if (schema.type === "enum") {
        for (const value of mapping.prop.values) if (!schema.values.includes(String(value))) problems.push({ at: "prop.values", message: `names ${JSON.stringify(value)}, which ${component}'s ${mapping.prop.name} does not hold (${quote(schema.values)})` });
      }
    }
  }
  return problems;
}

/** A mapping in words: "Button with variant \"filled\" (or no variant)". */
export function describeMapping(mapping: RoleMapping): string {
  const parts = mapping.components.join(" or ") || "no part";
  if (!mapping.prop) return parts;
  return `${parts} with ${mapping.prop.name} ${mapping.prop.values.map((value) => JSON.stringify(value)).join(" or ")}${mapping.prop.whenMissing ? ` (or no ${mapping.prop.name})` : ""}`;
}

/** What a rule that selects a role the library has no part for will do. */
export type MissingRoleEffect = { readonly role: RoleName; readonly rules: readonly { readonly rule: string; readonly description?: string; readonly effect: string }[] };

function selectsRole(selector: Selector, role: RoleName): boolean {
  if (selector.role === role) return true;
  if ([selector.inside, selector.notInside, selector.not].some((nested) => nested !== undefined && selectsRole(nested, role))) return true;
  return (selector.anyOf ?? []).some((option) => selectsRole(option, role));
}

function selectorsOf(rule: RuleSpec): readonly Selector[] {
  switch (rule.type) {
    case "count":
    case "reachable":
    case "prop-values":
      return [rule.select];
    case "containment":
      return rule.must === "nest-at-most" ? [rule.select] : [rule.select, rule.of];
    case "requires":
      return [rule.select, rule.must];
    case "slot":
      return [rule.holds, rule.only].filter((selector): selector is Selector => selector !== undefined);
    default:
      return [];
  }
}

/**
 * For each role in `missing`, every rule in `rules` that selects it, and what
 * it will do. A rule that selects a role mapped to no part could never fire,
 * and a config with one is refused (`configReferenceIssues`), so each such
 * rule must leave the project, or a part be mapped, before the project can be
 * checked. That holds for a rule that names the role among others in `anyOf`
 * too, such as `counted-parts-reached`.
 */
export function missingRoleEffects(rules: readonly RuleSpec[], missing: readonly RoleName[]): readonly MissingRoleEffect[] {
  return [...new Set(missing)]
    .sort((a, b) => ROLE_NAMES.indexOf(a) - ROLE_NAMES.indexOf(b))
    .map((role) => ({
      role,
      rules: rules
        .filter((rule) => selectorsOf(rule).some((selector) => selectsRole(selector, role)))
        .map((rule) => ({
          rule: rule.id,
          ...(rule.description ? { description: rule.description } : {}),
          effect: `selects role "${role}", which maps to no part, so it could never fire: the config is refused until the rule is removed from the project or a part is mapped to "${role}"`,
        }))
        .sort((a, b) => compare(a.rule, b.rule)),
    }));
}
