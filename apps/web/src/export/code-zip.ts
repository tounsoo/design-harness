import { exportReactProject, type CheckReport, type ProjectConfig, type Prototype, type TsxPrototype } from "@design-harness/core";
import { strToU8, zipSync } from "fflate";

/**
 * Code export: a prototype as a runnable React project, zipped in the
 * browser. Core writes the files (`exportReactProject`, which writes a spec
 * prototype as TSX first, and a stored TSX prototype's files as they are);
 * this only names them under the project's folder
 * and zips them with fflate (0.8.3, pinned), deflated, every entry dated
 * the time of the export, so the same export is the same bytes.
 */

export type CodeZip = { readonly fileName: string; readonly folder: string; readonly bytes: Uint8Array; readonly paths: readonly string[]; readonly notes: readonly string[] };

/** Core's report in a few words for the export's README. */
export function checksWords(report: CheckReport | null): string | undefined {
  if (!report) return undefined;
  const failing = report.rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule);
  return report.status === "pass" ? "pass: every rule passes" : report.status === "fail" ? `fail: ${failing.join(", ")}` : "incomplete: some rules did not run";
}

export function codeZip(input: { readonly config: ProjectConfig; readonly prototype: Prototype | TsxPrototype; readonly name: string; readonly at: string; readonly report?: CheckReport | null }): { ok: true; value: CodeZip } | { ok: false; error: string } {
  const checks = checksWords(input.report ?? null);
  const project = exportReactProject({ config: input.config, prototype: input.prototype, name: input.name, at: input.at, ...(checks ? { checks } : {}) });
  if (!project.ok) return project;
  const { folder, files, notes } = project.value;
  const paths = Object.keys(files).sort().map((path) => `${folder}/${path}`);
  const entries = Object.fromEntries(Object.keys(files).sort().map((path) => [`${folder}/${path}`, strToU8(files[path] as string)]));
  const bytes = zipSync(entries, { level: 6, mtime: input.at });
  return { ok: true, value: { fileName: `${folder}.zip`, folder, bytes, paths, notes } };
}
