import { configReferenceIssues } from "./config/references";
import { configSchema } from "./config/schema";
import type { ProjectConfig } from "./config/types";
import { prototypeSchema } from "./prototype/schema";
import type { Prototype } from "./prototype/types";
import { snapshotSchema } from "./rendered/schema";
import type { RenderedSnapshot } from "./rendered/types";
import { arr, run, type Issue, type Result } from "./validate";

/** Validates a project config from JSON: its shape, then every reference inside it. */
export function parseProjectConfig(json: unknown): Result<ProjectConfig> {
  const shaped = run(configSchema, json);
  if (!shaped.ok) return shaped;
  const issues = configReferenceIssues(shaped.value);
  return issues.length > 0 ? { ok: false, error: issues } : shaped;
}

/** Validates a prototype from JSON: its shape, and that its manifest ids are unique and its files are referenced by path. */
export function parsePrototype(json: unknown): Result<Prototype> {
  const shaped = run(prototypeSchema, json);
  if (!shaped.ok) return shaped;
  const issues = prototypeIssues(shaped.value);
  return issues.length > 0 ? { ok: false, error: issues } : shaped;
}

export function parseSnapshots(json: unknown): Result<readonly RenderedSnapshot[]> {
  return run(arr(snapshotSchema), json);
}

export function prototypeIssues(prototype: Prototype, root = "$"): Issue[] {
  const issues: Issue[] = [];
  const unique = (path: string, ids: readonly string[], what: string) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) issues.push({ path: `${root}.${path}[${index}]`, message: `${what} "${id}" appears twice` });
      seen.add(id);
    });
  };
  unique("pages", prototype.pages.map((page) => page.id), "page id");
  unique("layouts", prototype.layouts.map((layout) => layout.id), "layout id");
  unique("scenarios", prototype.scenarios.map((scenario) => scenario.id), "scenario id");
  unique("flow.states", prototype.flow.states, "flow state");
  return issues;
}

export function formatIssues(issues: readonly Issue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
}
