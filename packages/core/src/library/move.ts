import type { ComponentLibrary, LibrarySource, PartDescription, ProjectConfig, RoleMapping } from "../config/types";
import { checkPrototype } from "../engine/check";
import { compareStrings, type CheckStatus, type Finding } from "../engine/report";
import { parseProjectConfig } from "../parse";
import type { Prototype } from "../prototype/types";
import { ROLE_NAMES, type RoleName } from "../rules/types";
import type { Result } from "../validate";
import { isExcluded } from "./project";
import { draftRoles, mappingProblems, sameMapping, type LibraryDescription } from "./roles";

/**
 * Moving a project to another exact version of its component library.
 *
 * `planLibraryMove` is the dry run: what the two versions' descriptions say
 * differently, whether each role the project mapped still names parts the
 * new version has, which inventoried components it lacks, and, for every
 * prototype given, how core's report would change. `moveLibrary` applies the
 * same move to the config and records it in `library.history`, and refuses
 * whatever the plan refuses. Both are pure and deterministic, and core reads
 * no clock: the caller stamps the move.
 *
 * This is not a proposal. A proposal changes the inventories or the rules
 * and proves the rule it carries on examples that must pass and fail; a
 * version move changes neither inventories nor rules, so it has no rule to
 * prove. What it can change is how the same prototypes are read, and the dry
 * run shows exactly that, before a person confirms it.
 */

/** One part both versions have, described differently. */
export type PartChange = {
  readonly part: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** Props both declare, with a different type, values or requiredness. */
  readonly changed: readonly string[];
  /** What else changed, in words: its content or its events. */
  readonly other: readonly string[];
};

export type LibraryDiff = {
  readonly package: string;
  readonly from: string;
  readonly to: string;
  /** Parts only the new version has, sorted; renamed parts are left out. */
  readonly added: readonly string[];
  /** Parts only the old version has, sorted; renamed parts are left out. */
  readonly removed: readonly string[];
  /** A removed part and an added one described exactly alike, each the only match of the other: most likely the same part renamed. */
  readonly renamed: readonly { readonly from: string; readonly to: string }[];
  readonly changed: readonly PartChange[];
  /** How many parts both have, described the same. */
  readonly unchanged: number;
};

/** One role the project maps, read against the new version. */
export type RoleCheck = {
  readonly role: RoleName;
  readonly mapping: RoleMapping;
  /** What the mapping names that the new version lacks; empty when it still holds. */
  readonly problems: readonly string[];
  /** What core drafts for the role from the new version, or null when it finds no part. */
  readonly drafted: RoleMapping | null;
};

/** How one prototype's report changes, checked without snapshots on both sides. */
export type PrototypeChange = {
  readonly id: string;
  readonly name: string;
  readonly before: CheckStatus;
  readonly after: CheckStatus;
  /** Rules whose status changes, sorted by rule id. */
  readonly rules: readonly { readonly rule: string; readonly before: string; readonly after: string }[];
  readonly added: readonly Finding[];
  readonly removed: readonly Finding[];
};

export type LibraryMovePlan = {
  readonly diff: LibraryDiff;
  readonly roles: readonly RoleCheck[];
  /** Inventoried components the new version has no part of. */
  readonly missingComponents: readonly string[];
  /** Style props core drafts for the new version that the project's `excludedProps` does not exclude. */
  readonly styleProps: readonly string[];
  /** Why the move cannot be made, in words; empty when it can. */
  readonly refusals: readonly string[];
  /** The config after the move, before it is stamped, or null when refused. */
  readonly config: ProjectConfig | null;
  /** Every prototype given, by id, whether its report changes or not. */
  readonly prototypes: readonly PrototypeChange[];
};

export type MoveOptions = {
  /** The stylesheets the new version is loaded with; the project's own when absent. */
  readonly stylesheets?: readonly string[];
  /** Where frames load the new version from; absent, what the deployment serves. */
  readonly source?: LibrarySource;
};

export type ProjectPrototype = { readonly id: string; readonly name: string; readonly prototype: Prototype };

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sortedKeys = (record: Readonly<Record<string, unknown>>) => Object.keys(record).sort(compareStrings);

/** A part description with its keys in order, so two descriptions compare by what they say. */
function normalPart(part: PartDescription): unknown {
  return { props: Object.fromEntries(sortedKeys(part.props).map((name) => [name, part.props[name]])), content: part.content, events: [...(part.events ?? [])].sort(compareStrings), needs: [...(part.needs ?? [])].sort(compareStrings) };
}

/** What two descriptions of one library say differently, part by part. */
export function compareLibraries(from: LibraryDescription, to: LibraryDescription): LibraryDiff {
  const before = sortedKeys(from.parts);
  const after = sortedKeys(to.parts);
  let removed = before.filter((part) => !Object.hasOwn(to.parts, part));
  let added = after.filter((part) => !Object.hasOwn(from.parts, part));
  const key = (description: LibraryDescription, part: string) => JSON.stringify(normalPart(description.parts[part] as PartDescription));
  const renamed: { from: string; to: string }[] = [];
  for (const old of removed) {
    const matches = added.filter((part) => key(to, part) === key(from, old));
    const back = removed.filter((part) => matches.length === 1 && key(from, part) === key(to, matches[0] as string));
    if (matches.length === 1 && back.length === 1) renamed.push({ from: old, to: matches[0] as string });
  }
  removed = removed.filter((part) => !renamed.some((pair) => pair.from === part));
  added = added.filter((part) => !renamed.some((pair) => pair.to === part));
  const changed: PartChange[] = [];
  let unchanged = 0;
  for (const part of before.filter((name) => Object.hasOwn(to.parts, name))) {
    const a = from.parts[part] as PartDescription;
    const b = to.parts[part] as PartDescription;
    if (sameJson(normalPart(a), normalPart(b))) {
      unchanged += 1;
      continue;
    }
    const other: string[] = [];
    if (a.content !== b.content) other.push(`content ${a.content} → ${b.content}`);
    if (!sameJson([...(a.events ?? [])].sort(compareStrings), [...(b.events ?? [])].sort(compareStrings))) other.push(`events ${(a.events ?? []).join(", ") || "none"} → ${(b.events ?? []).join(", ") || "none"}`);
    if (!sameJson([...(a.needs ?? [])].sort(compareStrings), [...(b.needs ?? [])].sort(compareStrings))) other.push(`needs ${(a.needs ?? []).join(", ") || "nothing"} → ${(b.needs ?? []).join(", ") || "nothing"}`);
    changed.push({
      part,
      added: sortedKeys(b.props).filter((prop) => !Object.hasOwn(a.props, prop)),
      removed: sortedKeys(a.props).filter((prop) => !Object.hasOwn(b.props, prop)),
      changed: sortedKeys(a.props).filter((prop) => Object.hasOwn(b.props, prop) && !sameJson(a.props[prop], b.props[prop])),
      other,
    });
  }
  return { package: to.package, from: from.version, to: to.version, added, removed, renamed, changed, unchanged };
}

const familyOf = (part: string) => part.split(".")[0] as string;

/**
 * The new version's parts a project carries: all of them when the project
 * carried every family of the old version (or no parts at all), else only
 * the families it carried, as a project New project built carries only what
 * it inventories.
 */
function movedParts(library: ComponentLibrary, from: LibraryDescription, to: LibraryDescription): Readonly<Record<string, PartDescription>> {
  if (!library.parts) return to.parts;
  const carried = new Set(Object.keys(library.parts).map(familyOf));
  if (Object.keys(from.parts).every((part) => carried.has(familyOf(part)))) return to.parts;
  return Object.fromEntries(Object.keys(to.parts).sort(compareStrings).filter((part) => carried.has(familyOf(part))).map((part) => [part, to.parts[part] as PartDescription]));
}

/** The library as it would be on the new version. */
function movedLibrary(library: ComponentLibrary, from: LibraryDescription, to: LibraryDescription, options: MoveOptions): ComponentLibrary {
  const { source: _source, ...rest } = library;
  void _source;
  return { ...rest, version: to.version, parts: movedParts(library, from, to), ...(options.stylesheets ? { stylesheets: options.stylesheets } : {}), ...(options.source ? { source: options.source } : {}) };
}

function findingKey(finding: Finding): string {
  return JSON.stringify(finding);
}

/**
 * The dry run of moving `config` to the version `to` describes, for every
 * prototype given. `from` is the whole description of the version the
 * project is on now, as the caller ships it (or the project's own
 * `library.parts` when the caller has none). The moved project carries the
 * new version's parts of the families it carried. Nothing is changed.
 */
export function planLibraryMove(config: ProjectConfig, from: LibraryDescription, to: LibraryDescription, prototypes: readonly ProjectPrototype[], options: MoveOptions = {}): LibraryMovePlan {
  const library = config.library;
  const refusals: string[] = [];
  if (from.package !== library.package || from.version !== library.version) refusals.push(`the description of the current version is of ${from.package} ${from.version}, but the project is on ${library.package} ${library.version}`);
  if (to.package !== library.package) refusals.push(`the project uses ${library.package}; ${to.package} is another library, which takes a new project`);
  if (to.version === library.version) refusals.push(`the project is already on ${library.package} ${library.version}`);
  const diff = compareLibraries(from, to);
  const draft = draftRoles(to);
  const roles: RoleCheck[] = ROLE_NAMES.map((role) => {
    const mapping = library.roles[role];
    const problems = mappingProblems(to, mapping).map((problem) => problem.message);
    return { role, mapping, problems, drafted: draft.guesses.find((guess) => guess.role === role)?.mapping ?? null };
  });
  for (const check of roles) for (const problem of check.problems) refusals.push(`role "${check.role}" ${problem}${check.drafted && !sameMapping(check.drafted, check.mapping) ? `; core drafts it as ${check.drafted.components.join(" or ") || "no part"} on ${to.version}` : ""}`);
  const families = new Set(Object.keys(to.parts).map((part) => part.split(".")[0] as string));
  const missingComponents = [...config.inventories.components].filter((component) => !families.has(component)).sort(compareStrings);
  for (const component of missingComponents) refusals.push(`${component} is an inventoried component, and ${to.package} ${to.version} has no part of it: remove it with a proposal first`);
  const excluded = library.excludedProps ?? [];
  const styleProps = (draft.excludedProps?.props ?? []).filter((prop) => !isExcluded(excluded, prop));

  let moved: ProjectConfig | null = null;
  if (refusals.length === 0) {
    const parsed = parseProjectConfig({ ...config, library: movedLibrary(library, from, to, options) });
    if (parsed.ok) moved = parsed.value;
    else for (const issue of parsed.error) refusals.push(`the moved config does not validate: ${issue.path} ${issue.message}`);
  }

  const changes: PrototypeChange[] = [];
  if (moved) {
    for (const item of [...prototypes].sort((a, b) => compareStrings(a.id, b.id))) {
      const was = checkPrototype({ config, prototype: item.prototype });
      const now = checkPrototype({ config: moved, prototype: item.prototype });
      const statusOf = (report: typeof was, rule: string) => report.rules.find((entry) => entry.rule === rule)?.status ?? "not in force";
      const ruleIds = [...new Set([...was.rules, ...now.rules].map((entry) => entry.rule))].sort(compareStrings);
      const known = new Set(was.findings.map(findingKey));
      const kept = new Set(now.findings.map(findingKey));
      changes.push({
        id: item.id,
        name: item.name,
        before: was.status,
        after: now.status,
        rules: ruleIds.filter((rule) => statusOf(was, rule) !== statusOf(now, rule)).map((rule) => ({ rule, before: statusOf(was, rule), after: statusOf(now, rule) })),
        added: now.findings.filter((finding) => !known.has(findingKey(finding))),
        removed: was.findings.filter((finding) => !kept.has(findingKey(finding))),
      });
    }
  }
  return { diff, roles, missingComponents, styleProps, refusals, config: moved, prototypes: changes };
}

/** Whether a prototype's report changes in a plan. */
export function reportChanges(change: PrototypeChange): boolean {
  return change.before !== change.after || change.rules.length > 0 || change.added.length > 0 || change.removed.length > 0;
}

/**
 * Moves the project to the version `to` describes, as `planLibraryMove`
 * would, and records the move in `library.history` with the caller's stamp.
 * Refuses, with the plan's reasons, what the plan refuses.
 */
export function moveLibrary(config: ProjectConfig, from: LibraryDescription, to: LibraryDescription, stamp: { readonly at: string; readonly by?: string; readonly note?: string }, options: MoveOptions = {}): Result<ProjectConfig, readonly string[]> {
  const plan = planLibraryMove(config, from, to, [], options);
  if (!plan.config) return { ok: false, error: plan.refusals };
  const entry = { kind: "moved" as const, from: config.library.version, to: to.version, at: stamp.at, ...(stamp.by ? { by: stamp.by } : {}), ...(stamp.note ? { note: stamp.note } : {}) };
  return { ok: true, value: { ...plan.config, library: { ...plan.config.library, history: [...(config.library.history ?? []), entry] } } };
}

/**
 * Sets where frames load the project's library from: `esm.sh`, for a
 * version this deployment does not serve, or back to the deployment's own
 * packages. Recorded in `library.history`.
 */
export function chooseLibrarySource(config: ProjectConfig, source: LibrarySource | "deployment", stamp: { readonly at: string; readonly by?: string }): ProjectConfig {
  const { source: _old, ...library } = config.library;
  void _old;
  const entry = { kind: "source" as const, source, version: library.version, at: stamp.at, ...(stamp.by ? { by: stamp.by } : {}) };
  return { ...config, library: { ...library, ...(source === "deployment" ? {} : { source }), history: [...(library.history ?? []), entry] } };
}
