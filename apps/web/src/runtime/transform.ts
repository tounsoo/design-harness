import { parse } from "@babel/parser";
import { isScript, resolvePath } from "@design-harness/core";
import { transform } from "sucrase";
import { TAG_PROP, type TagSites } from "./tags";

/**
 * Turns a prototype's files into ES modules a frame can run, in the browser,
 * with no build step: sucrase strips TypeScript and compiles JSX to calls on
 * `react/jsx-runtime`, and every relative import is rewritten to the bare
 * specifier of the file it resolves to, `@prototype/<path>`, which the
 * frame's import map points at that file's module. Resolution is core's
 * `resolvePath`, so a file loads exactly what the extractor checked. Bare
 * imports (React, the library, the page kit) are left for the import map.
 *
 * Given the tag sites of core's model (`tags.ts`), it first adds the
 * element tag prop as the last attribute of every JSX element, so it wins
 * over any spread or attribute written before it: a library part, a page
 * kit part or an HTML element gets where it is written, anything else gets
 * undefined. This happens here only, after core has checked the source: core
 * reads the files as written, and code export writes them as written.
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

/**
 * The file with the tag prop added as the last attribute of each JSX element
 * core located, or the file as it is when it does not parse (sucrase then
 * reports why) or has no JSX core saw.
 */
export function withTags(path: string, code: string, sites: ReadonlyMap<string, string | null> | undefined): string {
  if (!sites || sites.size === 0 || path.endsWith(".ts")) return code;
  let program: unknown;
  try {
    program = parse(code, { sourceType: "module", plugins: path.endsWith(".tsx") ? ["jsx", "typescript"] : ["jsx"] }).program;
  } catch {
    return code;
  }
  const inserts: { at: number; text: string }[] = [];
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const item = node as { type?: string; loc?: { start: { line: number; column: number } }; openingElement?: { end: number; selfClosing: boolean } };
    if (item.type === "JSXElement" && item.loc && item.openingElement) {
      const site = `${item.loc.start.line}:${item.loc.start.column + 1}`;
      if (sites.has(site)) {
        const tag = sites.get(site) ?? null;
        // Before the opening element's closing ">" or "/>".
        const at = item.openingElement.end - (item.openingElement.selfClosing ? 2 : 1);
        inserts.push({ at, text: ` ${TAG_PROP}={${tag === null ? "undefined" : JSON.stringify(tag)}}` });
      }
    }
    for (const [key, value] of Object.entries(item)) {
      if (key !== "loc" && key !== "extra" && key !== "start" && key !== "end") visit(value);
    }
  };
  visit(program);
  let out = code;
  for (const insert of inserts.sort((a, b) => b.at - a.at)) out = `${out.slice(0, insert.at)}${insert.text}${out.slice(insert.at)}`;
  return out;
}

/** A module that fails to load with `message`, standing in for a file that does not compile. */
function failing(message: string): string {
  return `throw new SyntaxError(${JSON.stringify(message)});\n`;
}

export function compilePrototype(files: Readonly<Record<string, string>>, tags?: TagSites): CompiledPrototype {
  const paths = Object.keys(files).sort();
  const known = new Set(paths);
  const modules: Record<string, string> = {};
  const problems: CompileProblem[] = [];
  for (const path of paths) {
    if (!isScript(path)) continue;
    let code: string;
    const compile = (text: string) => transform(text, { transforms: transformsFor(path), jsxRuntime: "automatic", production: true, disableESTransforms: true, filePath: path }).code;
    try {
      const source = files[path] ?? "";
      const tagged = withTags(path, source, tags?.get(path));
      try {
        code = compile(tagged);
      } catch (error) {
        // Report where the file as written fails, not the tagged one, whose columns moved.
        if (tagged === source) throw error;
        code = compile(source);
      }
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
