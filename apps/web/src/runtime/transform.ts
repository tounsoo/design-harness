import { parse } from "@babel/parser";
import { isScript, resolvePath } from "@design-harness/core";
import { transform } from "sucrase";

/**
 * Turns a prototype's files into ES modules a frame can run, in the browser,
 * with no build step: sucrase strips TypeScript and compiles JSX to calls on
 * `react/jsx-runtime`, and every relative import is rewritten to the bare
 * specifier of the file it resolves to, `@prototype/<path>`, which the
 * frame's import map points at that file's module. Resolution is core's
 * `resolvePath`, so a file loads exactly what the extractor checked. Bare
 * imports (React, the library, the page kit) are left for the import map.
 *
 * Pure and deterministic: the same files give the same modules.
 */

export const PROTOTYPE_PREFIX = "@prototype/";

export function moduleSpecifier(path: string): string {
  return `${PROTOTYPE_PREFIX}${path}`;
}

export type CompileProblem = { readonly file: string; readonly line?: number; readonly column?: number; readonly message: string };

export type CompiledPrototype = {
  /** Module specifier → JavaScript, one per script file. */
  readonly modules: Readonly<Record<string, string>>;
  readonly problems: readonly CompileProblem[];
};

function transformsFor(path: string): ("typescript" | "jsx")[] {
  if (path.endsWith(".tsx")) return ["typescript", "jsx"];
  if (path.endsWith(".ts")) return ["typescript"];
  return ["jsx"];
}

/** Where each module specifier sits in `code`, for every static import, re-export and literal dynamic import. */
function specifiers(code: string): { start: number; end: number; value: string }[] {
  const found: { start: number; end: number; value: string }[] = [];
  const program = parse(code, { sourceType: "module" }).program;
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const item = node as { type?: string; source?: { type: string; value: string; start: number; end: number } | null; arguments?: unknown[] };
    if ((item.type === "ImportDeclaration" || item.type === "ExportAllDeclaration" || item.type === "ExportNamedDeclaration") && item.source?.type === "StringLiteral") {
      found.push({ start: item.source.start, end: item.source.end, value: item.source.value });
    }
    if (item.type === "ImportExpression" && item.source?.type === "StringLiteral") found.push({ start: item.source.start, end: item.source.end, value: item.source.value });
    for (const [key, value] of Object.entries(item)) {
      if (key !== "loc" && key !== "extra" && key !== "start" && key !== "end") visit(value);
    }
  };
  visit(program.body);
  return found.sort((a, b) => a.start - b.start);
}

/** A module that fails to load with `message`, standing in for a file that does not compile. */
function failing(message: string): string {
  return `throw new SyntaxError(${JSON.stringify(message)});\n`;
}

export function compilePrototype(files: Readonly<Record<string, string>>): CompiledPrototype {
  const paths = Object.keys(files).sort();
  const known = new Set(paths);
  const modules: Record<string, string> = {};
  const problems: CompileProblem[] = [];
  for (const path of paths) {
    if (!isScript(path)) continue;
    let code: string;
    try {
      code = transform(files[path] ?? "", {
        transforms: transformsFor(path),
        jsxRuntime: "automatic",
        production: true,
        disableESTransforms: true,
        filePath: path,
      }).code;
    } catch (error) {
      const loc = (error as { loc?: { line: number; column: number } }).loc;
      const message = `${path} does not compile: ${error instanceof Error ? error.message : String(error)}`;
      problems.push({ file: path, ...(loc ? { line: loc.line, column: loc.column + 1 } : {}), message });
      modules[moduleSpecifier(path)] = failing(message);
      continue;
    }
    let rewritten = "";
    let last = 0;
    try {
      for (const site of specifiers(code)) {
        if (!site.value.startsWith(".")) continue;
        const target = resolvePath(path, site.value, known);
        // An import of a file the prototype lacks is left as written: the frame reports it, and core's imports rule flags it.
        if (target === null) continue;
        rewritten += `${code.slice(last, site.start)}${JSON.stringify(moduleSpecifier(target))}`;
        last = site.end;
      }
    } catch (error) {
      const message = `${path} compiled to code that does not parse: ${error instanceof Error ? error.message : String(error)}`;
      problems.push({ file: path, message });
      modules[moduleSpecifier(path)] = failing(message);
      continue;
    }
    modules[moduleSpecifier(path)] = rewritten + code.slice(last);
  }
  return { modules, problems };
}
