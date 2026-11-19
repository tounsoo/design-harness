import type { PartDescription, ProjectConfig } from "@design-harness/core";
import todae0101 from "../../../../packages/core/libraries/todae-0.10.1.json";
import todae0113 from "../../../../packages/core/libraries/todae-0.11.3.json";

/**
 * Stored data from older versions of the app, brought up to date on load.
 *
 * Projects from before spec prototypes have no `library.parts`, the
 * description of the library's parts a spec is checked against. On load the
 * app adds the description bundled for exactly that package and version, if
 * there is one; otherwise it says plainly that spec prototypes cannot be
 * checked in that project, and leaves the config as it is.
 *
 * Projects from before core read specs only list rules core no longer has:
 * the TSX-only `isolation` and `style-props` rules and the `imports`
 * membership subject. `withoutTsxRules` takes them out of the config as
 * stored, before core reads it, with every proposal's rules and every
 * example written as TSX, and says what it took out, so the project loads
 * instead of failing whole.
 */

type Parts = Readonly<Record<string, PartDescription>>;

/**
 * The library descriptions this app ships, by `package@version`: written by
 * core's describe-library script. A project gets the one for exactly its
 * library's version, so a project stored on an older Todae keeps checking.
 */
export const BUNDLED_PARTS: Readonly<Record<string, Parts>> = Object.fromEntries(
  [todae0101, todae0113].map((description) => [`${description.package}@${description.version}`, description.parts as Parts]),
);

/** True for a rule only TSX had: core's vocabulary no longer has its type, or the imports subject. */
export function isTsxRule(rule: unknown): boolean {
  if (typeof rule !== "object" || rule === null) return false;
  const { type, of } = rule as { type?: unknown; of?: unknown };
  return type === "isolation" || type === "style-props" || (type === "membership" && of === "imports");
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const idOf = (value: unknown) => (isObject(value) && typeof value.id === "string" ? value.id : "?");
const nameOf = (value: unknown) => (isObject(value) && typeof value.name === "string" ? value.name : "?");
/** A stored prototype that says it is TSX: `format` "tsx", or none, which meant TSX. */
const isTsxPrototype = (value: unknown) => isObject(value) && (value.format === undefined || value.format === "tsx");

/** Why an example goes with the TSX-only rules, or null when it stays: written as TSX, or flagged by a rule only TSX had. */
function tsxExample(example: unknown, retired: ReadonlySet<string>): string | null {
  if (!isObject(example)) return null;
  if (isTsxPrototype(example.prototype)) return "written as TSX, which core no longer reads";
  const flagged = isObject(example.flaggedBy) ? example.flaggedBy.rule : undefined;
  return typeof flagged === "string" && retired.has(flagged) ? `flagged by "${flagged}", a rule only TSX had` : null;
}

/** A proposal's content (its own, or a revision's earlier one) without TSX-only rules and TSX examples; what it took out goes in `out`. */
function contentWithoutTsx(content: Record<string, unknown>, where: string, retired: ReadonlySet<string>, out: string[]): Record<string, unknown> {
  let next = content;
  const rules = content.rules;
  if (isObject(rules) && Array.isArray(rules.add) && rules.add.some(isTsxRule)) {
    for (const rule of rules.add.filter(isTsxRule)) out.push(`${where} added rule "${idOf(rule)}", which only TSX had`);
    next = { ...next, rules: { ...rules, add: rules.add.filter((rule) => !isTsxRule(rule)) } };
  }
  const examples = content.examples;
  if (isObject(examples)) {
    const kept: Record<string, unknown> = { ...examples };
    let changed = false;
    for (const [kind, words] of [["pass", "passing"], ["fail", "failing"]] as const) {
      const list = examples[kind];
      if (!Array.isArray(list)) continue;
      for (const example of list) {
        const why = tsxExample(example, retired);
        if (why !== null) out.push(`${where}'s ${words} example "${nameOf(example)}", ${why}`);
      }
      const left = list.filter((example) => tsxExample(example, retired) === null);
      if (left.length !== list.length) {
        kept[kind] = left;
        changed = true;
      }
    }
    if (changed) next = { ...next, examples: kept };
  }
  return next;
}

export type TsxRulesRemoved = { readonly json: unknown; readonly removed: readonly string[] };

/**
 * A stored project config, as JSON, without the rules core no longer has: in
 * `rules`, and in each proposal (its rules, its examples written as TSX or
 * flagged by such a rule, and its revisions' earlier content). `removed`
 * says what went, one line each; empty when nothing did, and then `json` is
 * the value given. Pure: run it before `parseProjectConfig`.
 */
export function withoutTsxRules(json: unknown): TsxRulesRemoved {
  if (!isObject(json)) return { json, removed: [] };
  const removed: string[] = [];
  let next: Record<string, unknown> = json;
  const rules = Array.isArray(json.rules) ? json.rules : [];
  const proposed = Array.isArray(json.proposals) ? json.proposals.flatMap((proposal) => (isObject(proposal) && isObject(proposal.rules) && Array.isArray(proposal.rules.add) ? proposal.rules.add : [])) : [];
  const retired = new Set([...rules, ...proposed].filter(isTsxRule).map(idOf));
  if (rules.some(isTsxRule)) {
    for (const rule of rules.filter(isTsxRule)) removed.push(`rule "${idOf(rule)}", which only TSX had`);
    next = { ...next, rules: rules.filter((rule) => !isTsxRule(rule)) };
  }
  if (Array.isArray(json.proposals)) {
    const before = removed.length;
    const proposals = json.proposals.map((proposal) => {
      if (!isObject(proposal)) return proposal;
      const where = `proposal "${idOf(proposal)}"`;
      const mark = removed.length;
      let out = contentWithoutTsx(proposal, where, retired, removed);
      if (Array.isArray(proposal.events)) out = { ...out, events: proposal.events.map((event) => (isObject(event) && isObject(event.previous) ? { ...event, previous: contentWithoutTsx(event.previous, `${where}'s earlier version`, retired, removed) } : event)) };
      return removed.length > mark ? out : proposal;
    });
    if (removed.length > before) next = { ...next, proposals };
  }
  return { json: removed.length > 0 ? next : json, removed };
}

/** The note a project whose TSX-only rules were taken out gets on load or import. */
export function tsxRulesNote(name: string, removed: readonly string[]): LoadNote {
  return {
    tone: "info",
    title: "Rules that only applied to TSX were taken out",
    text: `Project "${name}" listed rules core no longer has: every prototype is a spec now, so they had nothing left to check. The app took out ${removed.join("; ")}.`,
  };
}

/** Something the app changed or found about stored data on load, said once. */
export type LoadNote = { readonly tone: "info" | "warning"; readonly title: string; readonly text: string };

export type Migration =
  | { readonly kind: "unchanged"; readonly config: ProjectConfig }
  | { readonly kind: "added-parts"; readonly config: ProjectConfig; readonly note: string }
  | { readonly kind: "no-parts"; readonly config: ProjectConfig; readonly note: string };

export function withLibraryParts(config: ProjectConfig, bundled: Readonly<Record<string, Parts>> = BUNDLED_PARTS): Migration {
  if (config.library.parts) return { kind: "unchanged", config };
  const { package: name, version } = config.library;
  const parts = bundled[`${name}@${version}`];
  if (!parts) {
    return {
      kind: "no-parts",
      config,
      note: `Project "${config.name}" uses ${name} ${version}, and this app has no description of that library's parts, so no prototype can be made or edited in it, and its spec prototypes cannot be checked. Import a project file whose config has library.parts for ${name} ${version} to use specs.`,
    };
  }
  return {
    kind: "added-parts",
    config: { ...config, library: { ...config.library, parts } },
    note: `Project "${config.name}" was stored before spec prototypes, without a description of its library's parts. The app added the one it ships for ${name} ${version} (${Object.keys(parts).length} parts), so spec prototypes can be checked in it.`,
  };
}
