import {
  ROLE_NAMES,
  confirmationFrom,
  roleComponents,
  sameMapping,
  starterInventory,
  type ExclusionChoice,
  type Issue,
  type LibraryDescription,
  type LibrarySetup,
  type ProjectAnswers,
  type RoleChoice,
  type RoleDraft,
  type RoleMapping,
  type RoleName,
  type RoleOptions,
  type StarterRules,
} from "@design-harness/core";

/**
 * The New project wizard's state and the plain functions over it: what a
 * person has decided so far, as the answers core's `buildProject` takes, and
 * which step each of core's refusals belongs to. Nothing here decides
 * whether an answer is valid: core does, and the wizard shows what it says.
 */

export const STEPS = ["Name", "Library", "Roles", "Style props", "Starting rules", "Create"] as const;
export const STEP = { name: 0, library: 1, roles: 2, exclusion: 3, rules: 4, create: 5 } as const;

/** Each role in a designer's words: what it is, and what the rules do with it. */
export const ROLE_WORDS: Readonly<Record<RoleName, { readonly title: string; readonly about: string }>> = {
  action: { title: "Action", about: "Anything a person presses to do something. The rules find every action on a page." },
  "primary-action": { title: "Primary action", about: "The one thing a page is for. The rules allow one per page, and it must be the top-ranked action." },
  "secondary-action": { title: "Secondary action", about: "A quieter choice beside the primary action. The second-ranked action must look like this." },
  disclosure: { title: "Disclosure", about: "A section that stays closed until a person opens it. The rules cap how many a page has and how deep they nest." },
  "disclosure-summary": { title: "Disclosure summary", about: "The line a person presses to open a disclosure. Its text names the section." },
  question: { title: "Question", about: "One thing a page asks a person to answer. The rules cap how many a page asks at once." },
};

/** The library a person picked, ready to draft: its description and how a project loads it. */
export type WizardLibrary = {
  /** `shipped:<id>` or `imported`. */
  readonly source: string;
  readonly name: string;
  readonly description: LibraryDescription;
  readonly setup: LibrarySetup;
  readonly notes: readonly string[];
};

/** One role as the person has it now: the mapping, the reason when it is not the draft's, and whether they accepted the draft. */
export type RoleState = { readonly mapping: RoleMapping; readonly why: string; readonly accepted: boolean };
export type RolesState = Readonly<Record<RoleName, RoleState>>;
export type ExclusionState = { readonly props: readonly string[]; readonly why: string; readonly accepted: boolean };

export type WizardState = {
  readonly name: string;
  readonly library: WizardLibrary | null;
  readonly roles: RolesState | null;
  readonly exclusion: ExclusionState;
  /** The components a prototype may use, or null for core's starting inventory. */
  readonly components: readonly string[] | null;
  readonly rules: StarterRules;
};

const NONE: RoleMapping = { components: [] };

/** Where the roles start: each drafted role as drafted, each role the draft found no part for as having none; nothing accepted yet. */
export function initialRoles(draft: RoleDraft): RolesState {
  return Object.fromEntries(ROLE_NAMES.map((role) => [role, { mapping: draft.guesses.find((guess) => guess.role === role)?.mapping ?? NONE, why: "", accepted: false }])) as unknown as RolesState;
}

export function initialExclusion(draft: RoleDraft): ExclusionState {
  return { props: draft.excludedProps?.props ?? [], why: "", accepted: false };
}

/** How a role stands: still the draft (accepted or not), changed by the person, or left with no part. */
export type RoleStanding = "drafted" | "accepted" | "corrected" | "none";

export function roleStanding(draft: RoleDraft, role: RoleName, state: RoleState): RoleStanding {
  const guess = draft.guesses.find((item) => item.role === role);
  if (guess && sameMapping(guess.mapping, state.mapping)) return state.accepted ? "accepted" : "drafted";
  return state.mapping.components.length === 0 ? "none" : "corrected";
}

/** The mapping of every role as it stands, for the previews and the starting inventory. */
export function mappingsOf(roles: RolesState): Record<RoleName, RoleMapping> {
  return Object.fromEntries(ROLE_NAMES.map((role) => [role, roles[role].mapping])) as Record<RoleName, RoleMapping>;
}

/** The choices core confirms: a drafted role only once accepted, any other with its reason (core refuses an empty one). */
export function choicesOf(draft: RoleDraft, roles: RolesState): Partial<Record<RoleName, RoleChoice>> {
  const choices: Partial<Record<RoleName, RoleChoice>> = {};
  for (const role of ROLE_NAMES) {
    const state = roles[role];
    if (roleStanding(draft, role, state) !== "drafted") choices[role] = { mapping: state.mapping, why: state.why };
  }
  return choices;
}

const sorted = (values: readonly string[]) => [...new Set(values)].sort();

/** Whether the excluded props are the draft's own list. */
export function exclusionIsDraft(draft: RoleDraft, exclusion: ExclusionState): boolean {
  return JSON.stringify(sorted(exclusion.props)) === JSON.stringify(draft.excludedProps?.props ?? []);
}

/** The exclusion core confirms: the draft's once accepted, the person's own list with its reason, or nothing when there is nothing to decide. */
export function exclusionOf(draft: RoleDraft, exclusion: ExclusionState): ExclusionChoice | undefined {
  if (exclusionIsDraft(draft, exclusion)) return draft.excludedProps && exclusion.accepted ? "accept" : undefined;
  return { props: sorted(exclusion.props), why: exclusion.why };
}

/** The components the project starts with: the person's list, or core's, always with the ones the roles map to. */
export function componentsOf(state: WizardState): string[] {
  if (!state.library || !state.roles) return [];
  const mappings = mappingsOf(state.roles);
  return sorted([...(state.components ?? starterInventory(state.library.description, mappings)), ...roleComponents(mappings)]);
}

/** The wizard's state as the answers `buildProject` takes, or null before a library is picked. */
export function answersOf(state: WizardState, draft: RoleDraft | null, takenIds: readonly string[]): ProjectAnswers | null {
  if (!state.library || !state.roles || !draft) return null;
  return {
    name: state.name,
    takenIds,
    description: state.library.description,
    setup: state.library.setup,
    confirmation: confirmationFrom(draft, choicesOf(draft, state.roles), exclusionOf(draft, state.exclusion)),
    components: componentsOf(state),
    rules: state.rules,
  };
}

/** One of core's refusals, sent to the step that asks for what it is about, and to the role when it names one. */
export type StepIssue = { readonly step: number; readonly role?: RoleName; readonly path: string; readonly message: string };

export function routeIssue(issue: Issue): StepIssue {
  const { path, message } = issue;
  const at = (step: number, role?: RoleName): StepIssue => ({ step, path, message, ...(role ? { role } : {}) });
  if (path.startsWith("$.name")) return at(STEP.name);
  if (path.startsWith("$.confirmation.excludedProps")) return at(STEP.exclusion);
  if (path.startsWith("$.confirmation")) {
    const named = ROLE_NAMES.find((role) => path.startsWith(`$.confirmation.corrections.${role}`)) ?? ROLE_NAMES.find((role) => message.includes(`role "${role}"`));
    return at(STEP.roles, named);
  }
  if (path.startsWith("$.components") || path.startsWith("$.rules")) return at(STEP.rules);
  return at(STEP.create);
}

/** A role's mapping after a part is checked or unchecked, kept in the order the options list them. */
export function togglePart(options: RoleOptions, mapping: RoleMapping, part: string, on: boolean): RoleMapping {
  if (options.kind !== "parts") return mapping;
  const chosen = new Set(mapping.components);
  if (on) chosen.add(part);
  else chosen.delete(part);
  return { components: [...options.parts.filter((name) => chosen.has(name)), ...mapping.components.filter((name) => chosen.has(name) && !options.parts.includes(name))] };
}

/** A role's mapping after a prop value is checked or unchecked: no value left means the role has no part. */
export function toggleValue(options: RoleOptions, mapping: RoleMapping, value: string, on: boolean): RoleMapping {
  if (options.kind !== "values") return mapping;
  const chosen = new Set((mapping.prop?.name === options.prop ? mapping.prop.values : []).map(String));
  if (on) chosen.add(value);
  else chosen.delete(value);
  const values = options.values.filter((name) => chosen.has(name));
  if (values.length === 0) return NONE;
  return { components: options.components, prop: { name: options.prop, values, whenMissing: mapping.prop?.whenMissing ?? false } };
}
