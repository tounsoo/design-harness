import { nook } from "../examples/nook/project";
import type { ProjectConfig } from "../src/config/types";
import { checkPrototype } from "../src/engine/check";
import type { CheckReport } from "../src/engine/report";
import { extractPrototype } from "../src/extract";
import type { ElementNode } from "../src/extract/model";
import type { Prototype } from "../src/prototype/types";
import type { RuleSpec } from "../src/rules/types";

/** Nook's config with only the given rules in force, for testing one rule type at a time. */
export function configWith(rules: readonly RuleSpec[], patch: Partial<ProjectConfig> = {}): ProjectConfig {
  return { ...nook, rules, ...patch };
}

/**
 * A one-page prototype: `pages/home.tsx` must export `Home`, a booking page.
 * Other files and manifest parts can be added.
 */
export function prototype(files: Record<string, string>, manifest: Partial<Omit<Prototype, "files">> = {}): Prototype {
  return {
    files,
    pages: [{ id: "home", pageType: "booking", component: { file: "pages/home.tsx", export: "Home" } }],
    layouts: [],
    scenarios: [],
    flow: { states: [], tasks: [] },
    ...manifest,
  };
}

export const HEADER = `import { Slot } from "@design-harness/page";\nimport { Button, Disclosure, Field, Text } from "@tounsoo/todae";\n`;

/** The home page's rendered tree. */
export function homeTree(files: Record<string, string>, manifest: Partial<Omit<Prototype, "files">> = {}): ElementNode {
  const model = extractPrototype(prototype(files, manifest), "@tounsoo/todae");
  const page = model.pages.find((item) => item.id === "home");
  if (!page) throw new Error(`no home page: ${JSON.stringify(model.problems)}`);
  return page.root;
}

/** Every node under a root, depth first. */
export function flat(root: ElementNode): ElementNode[] {
  return [root, ...root.children.flatMap(flat)];
}

export function named(root: ElementNode, name: string): ElementNode[] {
  return flat(root).filter((node) => node.name === name);
}

export function check(rules: readonly RuleSpec[], files: Record<string, string>, manifest: Partial<Omit<Prototype, "files">> = {}): CheckReport {
  return checkPrototype({ config: configWith(rules), prototype: prototype(files, manifest) });
}

export function messages(report: CheckReport, rule?: string): string[] {
  return report.findings.filter((finding) => rule === undefined || finding.rule === rule).map((finding) => `${finding.kind}: ${finding.message}`);
}
