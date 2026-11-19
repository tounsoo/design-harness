import { nook } from "../examples/nook/project";
import type { ProjectConfig } from "../src/config/types";
import { checkPrototype } from "../src/engine/check";
import type { CheckReport } from "../src/engine/report";
import type { Prototype } from "../src/prototype/types";
import type { RuleSpec } from "../src/rules/types";

/** Nook's config with only the given rules in force, for testing one rule type at a time. */
export function configWith(rules: readonly RuleSpec[], patch: Partial<ProjectConfig> = {}): ProjectConfig {
  return { ...nook, rules, ...patch };
}

/** One element of a spec, as a test writes it: `props` and `children` default to empty. */
export type TestElement = {
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly children?: readonly string[];
  readonly visible?: unknown;
  readonly repeat?: unknown;
  readonly on?: unknown;
};

const element = (item: TestElement) => ({ ...item, props: item.props ?? {}, children: item.children ?? [] });

/**
 * `pages/home.json`, a booking page: a Page filling `slots` with the keys of
 * `elements`, `outside` in its children, in none of its slots, and `state`.
 */
export function home(slots: Readonly<Record<string, readonly string[]>>, elements: Readonly<Record<string, TestElement>> = {}, options: { readonly outside?: readonly string[]; readonly state?: Readonly<Record<string, unknown>> } = {}): Record<string, string> {
  const spec = {
    root: "page",
    elements: { page: { type: "Page", props: {}, children: options.outside ?? [], slots }, ...Object.fromEntries(Object.entries(elements).map(([key, item]) => [key, element(item)])) },
    ...(options.state ? { state: options.state } : {}),
  };
  return { "pages/home.json": JSON.stringify(spec, null, 2) };
}

/** A spec file that is not a page: elements under `root`. */
export function fragment(root: string, elements: Readonly<Record<string, TestElement>>): string {
  return JSON.stringify({ root, elements: Object.fromEntries(Object.entries(elements).map(([key, item]) => [key, element(item)])) }, null, 2);
}

/**
 * A one-page spec prototype: `pages/home.json` is its booking page, "home".
 * Other files and manifest parts can be added.
 */
export function prototype(files: Record<string, string>, manifest: Partial<Omit<Prototype, "files" | "format">> = {}): Prototype {
  return {
    format: "spec",
    files,
    pages: [{ id: "home", pageType: "booking", component: { file: "pages/home.json", export: "default" } }],
    layouts: [],
    scenarios: [],
    flow: { states: [], tasks: [] },
    ...manifest,
  };
}

export function check(rules: readonly RuleSpec[], files: Record<string, string>, manifest: Partial<Omit<Prototype, "files" | "format">> = {}): CheckReport {
  return checkPrototype({ config: configWith(rules), prototype: prototype(files, manifest) });
}

export function messages(report: CheckReport, rule?: string): string[] {
  return report.findings.filter((finding) => rule === undefined || finding.rule === rule).map((finding) => `${finding.kind}: ${finding.message}`);
}
