import { formatIssues, parseProjectConfig, parsePrototype, parseVariantState, type ProjectConfig, type Prototype, type TsxPrototype, type VariantState } from "@design-harness/core";
import { parsePinState, type PinState } from "../pins/model";
import { withoutTsxRules } from "./migrate";

/**
 * A project and its prototypes as one JSON file, for export and import.
 * Import trusts nothing in the file: the config and every prototype go
 * through core's validation, and the file is refused whole on any problem,
 * with every problem listed.
 */

export const PROJECT_FILE_FORMAT = "design-harness/project";
export const PROJECT_FILE_VERSION = 1;

/**
 * What a stored prototype holds: a spec, which core reads, or a TSX
 * prototype from before every prototype was a spec, which core refuses and
 * hands back as it was stored. The app keeps a TSX one to show its files and
 * export them, and never checks, renders or edits it.
 */
export type StoredPrototype = Prototype | TsxPrototype;

/** The spec a stored prototype is, or null for a TSX one, which nothing checks or renders. */
export const specOf = (prototype: StoredPrototype): Prototype | null => (prototype.format === "spec" ? prototype : null);

/**
 * A stored prototype. `variants` holds the variants of its pages and the
 * picks applied from them, apart from its files; absent when it has none.
 * `pins` holds the notes a person pinned on its frames, with their history
 * (`pins/model.ts`): beside the prototype, never in it, so no check reads
 * them; absent when it has none.
 */
export type PrototypeRecord = { readonly projectId: string; readonly id: string; readonly name: string; readonly prototype: StoredPrototype; readonly variants?: VariantState; readonly pins?: PinState };

/** A stored prototype that is a spec: what everything that checks, renders or changes a prototype takes. */
export type SpecRecord = PrototypeRecord & { readonly prototype: Prototype };

export const isSpecRecord = (record: PrototypeRecord): record is SpecRecord => record.prototype.format === "spec";

export type ProjectFile = {
  readonly format: typeof PROJECT_FILE_FORMAT;
  readonly version: typeof PROJECT_FILE_VERSION;
  readonly project: ProjectConfig;
  readonly prototypes: readonly { readonly id: string; readonly name: string; readonly prototype: StoredPrototype; readonly variants?: VariantState; readonly pins?: PinState }[];
};

/** An imported project. `removed` lists the rules only TSX had, which the import took out of the config (`store/migrate.ts`); empty when there were none. */
export type Imported = { readonly config: ProjectConfig; readonly prototypes: readonly PrototypeRecord[]; readonly removed: readonly string[] };

/** A stored prototype read back: a spec; a TSX one core refused but handed back whole; or the issues, as text. */
export function readStoredPrototype(json: unknown): { readonly ok: true; readonly value: StoredPrototype } | { readonly ok: false; readonly error: string } {
  const read = parsePrototype(json);
  if (read.ok) return read;
  if ("tsx" in read) return { ok: true, value: read.tsx };
  return { ok: false, error: formatIssues(read.error) };
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The file's text: stable, indented JSON, prototypes in id order. */
export function exportProject(config: ProjectConfig, prototypes: readonly PrototypeRecord[]): string {
  const file: ProjectFile = {
    format: PROJECT_FILE_FORMAT,
    version: PROJECT_FILE_VERSION,
    project: config,
    prototypes: [...prototypes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(({ id, name, prototype, variants, pins }) => ({ id, name, prototype, ...(variants && (variants.variants.length > 0 || variants.picks.length > 0) ? { variants } : {}), ...(pins && pins.pins.length > 0 ? { pins } : {}) })),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** A file name for the export: the project's id. */
export function exportFileName(config: ProjectConfig): string {
  return `${config.id}.design-harness.json`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a project file. Every problem is reported, each with where it is, and nothing is imported unless there are none. */
export function importProject(text: string): { ok: true; value: Imported } | { ok: false; error: readonly string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: [`The file is not JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!isObject(json) || json.format !== PROJECT_FILE_FORMAT) return { ok: false, error: [`The file is not a design-harness project: its "format" is not "${PROJECT_FILE_FORMAT}".`] };
  if (json.version !== PROJECT_FILE_VERSION) return { ok: false, error: [`The file is version ${JSON.stringify(json.version)}; this app reads version ${PROJECT_FILE_VERSION}.`] };
  const errors: string[] = [];
  const unknownKeys = Object.keys(json).filter((key) => !["format", "version", "project", "prototypes"].includes(key));
  if (unknownKeys.length > 0) errors.push(`$: has unknown fields ${unknownKeys.map((key) => `"${key}"`).join(", ")}`);
  const { json: project, removed } = withoutTsxRules(json.project);
  const config = parseProjectConfig(project);
  if (!config.ok) errors.push(...formatIssues(config.error).split("\n").map((line) => `project: ${line.replace(/^\$/, "$.project")}`));
  const records: PrototypeRecord[] = [];
  if (!Array.isArray(json.prototypes)) {
    errors.push("$.prototypes: expected a list of prototypes");
  } else {
    const seen = new Set<string>();
    json.prototypes.forEach((entry: unknown, index) => {
      const at = `$.prototypes[${index}]`;
      if (!isObject(entry)) return errors.push(`${at}: expected an object with id, name and prototype`);
      const extra = Object.keys(entry).filter((key) => !["id", "name", "prototype", "variants", "pins"].includes(key));
      if (extra.length > 0) errors.push(`${at}: has unknown fields ${extra.map((key) => `"${key}"`).join(", ")}`);
      if (typeof entry.id !== "string" || !SLUG.test(entry.id)) errors.push(`${at}.id: expected a lowercase slug such as "booking"`);
      else if (seen.has(entry.id)) errors.push(`${at}.id: prototype "${entry.id}" appears twice`);
      else seen.add(entry.id);
      if (typeof entry.name !== "string" || entry.name.trim() === "") errors.push(`${at}.name: expected a non-empty string`);
      const prototype = readStoredPrototype(entry.prototype);
      if (!prototype.ok) errors.push(...prototype.error.split("\n").map((line) => line.replace(/^\$/, `${at}.prototype`)));
      const variants = entry.variants === undefined ? null : parseVariantState(entry.variants);
      if (variants && !variants.ok) errors.push(...formatIssues(variants.error).split("\n").map((line) => line.replace(/^\$/, `${at}.variants`)));
      const pins = entry.pins === undefined ? null : parsePinState(entry.pins);
      if (pins && !pins.ok) errors.push(...pins.error.map((line) => line.replace(/^\$/, `${at}.pins`)));
      if (prototype.ok && (!variants || variants.ok) && (!pins || pins.ok) && typeof entry.id === "string" && typeof entry.name === "string" && config.ok) {
        records.push({ projectId: config.value.id, id: entry.id, name: entry.name, prototype: prototype.value, ...(variants?.ok ? { variants: variants.value } : {}), ...(pins?.ok ? { pins: pins.value } : {}) });
      }
      return undefined;
    });
  }
  if (errors.length > 0 || !config.ok) return { ok: false, error: errors };
  return { ok: true, value: { config: config.value, prototypes: records, removed } };
}
