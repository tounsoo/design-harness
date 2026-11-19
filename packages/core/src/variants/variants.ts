import type { ProjectConfig } from "../config/types";
import type { Prototype } from "../prototype/types";
import { formatSpec } from "../spec/format";
import { parseJson } from "../spec/json";
import { specIssues } from "../spec/model";
import { arr, obj, record, run, str, yes, type Check, type Result } from "../validate";
import { CURRENT, type PickRecord, type Variant, type VariantState } from "./types";

const ID = /^[a-z]{1,3}$/;

const variantSchema: Check<Variant> = obj(
  { id: str({ pattern: ID, patternName: 'a variant id such as "b"' }), page: str(), note: str({ nonEmpty: true }), spec: str() },
  { like: str({ pattern: ID, patternName: 'a variant id such as "b"' }) },
);
const pickSchema: Check<PickRecord> = obj({ at: str(), page: str(), slots: record(str()), notes: record(str()), before: str(), after: str() }, { undone: yes });
const stateSchema: Check<VariantState> = obj({ variants: arr(variantSchema), picks: arr(pickSchema) });

/** A prototype's stored variants and picks, validated, with variant ids unique. */
export function parseVariantState(json: unknown): Result<VariantState> {
  const shaped = run(stateSchema, json);
  if (!shaped.ok) return shaped;
  const seen = new Set<string>();
  const issues = shaped.value.variants.flatMap((variant, index) => {
    if (seen.has(variant.id)) return [{ path: `$.variants[${index}].id`, message: `variant id "${variant.id}" appears twice` }];
    seen.add(variant.id);
    return [];
  });
  return issues.length > 0 ? { ok: false, error: issues } : shaped;
}

/** "A" for "a": how a variant is named to people. */
export function variantLabel(id: string): string {
  return id === CURRENT ? "Current" : `Variant ${id.toUpperCase()}`;
}

/** The ids the next `count` variants get: "a", "b", ... "z", "aa", ..., skipping every id in `used`. */
export function nextVariantIds(used: readonly string[], count: number): string[] {
  const taken = new Set(used);
  const out: string[] = [];
  for (let n = 0; out.length < count; n += 1) {
    let id = "";
    for (let rest = n; ; rest = Math.floor(rest / 26) - 1) {
      id = String.fromCharCode(97 + (rest % 26)) + id;
      if (rest < 26) break;
    }
    if (!taken.has(id)) out.push(id);
  }
  return out;
}

/** The prototype with one page's file replaced by a variant's spec: what the variant would be, checked like any prototype. */
export function withPageSpec(prototype: Prototype, page: string, spec: string): Prototype {
  const entry = prototype.pages.find((item) => item.id === page);
  if (!entry) return prototype;
  return { ...prototype, files: { ...prototype.files, [entry.component.file]: spec } };
}

export function variantPrototype(prototype: Prototype, variant: Variant): Prototype {
  return withPageSpec(prototype, variant.page, variant.spec);
}

/**
 * Whether a spec can be a variant of a page: the prototype is a spec
 * prototype, the page is in its manifest, and the spec, put in the page's
 * place, brings no issue of its own against the catalog and the layouts'
 * parameters (an issue the prototype already had is not the variant's).
 * A variant that reads but breaks a rule is a variant: the checks show it
 * failing. Returns the spec as core formats it, or every problem.
 */
export function checkVariant(prototype: Prototype, config: ProjectConfig, page: string, spec: string): Result<string, readonly string[]> {
  const entry = prototype.pages.find((item) => item.id === page);
  if (!entry) return { ok: false, error: [`There is no page "${page}" in the manifest (${prototype.pages.map((item) => `"${item.id}"`).join(", ") || "none"}).`] };
  const parsed = parseJson(spec);
  if (!parsed.ok) return { ok: false, error: [`The spec does not parse as JSON: it ${parsed.message} at line ${parsed.at.line}.`] };
  const text = formatSpec(parsed.value);
  const key = (issue: { readonly message: string; readonly at: unknown }) => JSON.stringify([issue.message, issue.at]);
  const before = new Set(specIssues(prototype, config).map(key));
  const after = specIssues(withPageSpec(prototype, page, text), config).filter((issue) => !before.has(key(issue)));
  if (after.length > 0) return { ok: false, error: after.map((issue) => `${issue.at.file}:${issue.at.line}:${issue.at.column}: ${issue.message}`) };
  return { ok: true, value: text };
}
