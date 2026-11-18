import { parse, type ParserPlugin } from "@babel/parser";
import type * as t from "@babel/types";
import type { ExtractionProblem, ModuleLoad, SourceLocation } from "./model";

/** How a module binds a name it imports. `imported` is `default`, `*` for a namespace, or the exported name. */
export type ImportBinding = { readonly source: string; readonly imported: string; readonly at: SourceLocation };

export type ExportTarget =
  | { readonly kind: "local"; readonly name: string }
  | { readonly kind: "expression"; readonly node: t.Expression | t.FunctionDeclaration | t.ClassDeclaration }
  | { readonly kind: "reexport"; readonly source: string; readonly imported: string }
  | { readonly kind: "namespace"; readonly source: string };

export type ModuleInfo = {
  readonly path: string;
  readonly text: string;
  readonly program: t.Program;
  readonly imports: ReadonlyMap<string, ImportBinding>;
  readonly exports: ReadonlyMap<string, ExportTarget>;
  /** `export * from` sources, in source order. */
  readonly stars: readonly string[];
  readonly loads: readonly ModuleLoad[];
};

const SCRIPT = /\.(tsx|ts|jsx|js|mjs|cjs)$/;

export function isScript(path: string): boolean {
  return SCRIPT.test(path);
}

function pluginsFor(path: string): ParserPlugin[] {
  if (path.endsWith(".tsx")) return ["jsx", "typescript"];
  if (path.endsWith(".ts")) return ["typescript"];
  return ["jsx"];
}

export function locationOf(file: string, node: t.Node): SourceLocation {
  const start = node.loc?.start;
  return { file, line: start?.line ?? 1, column: (start?.column ?? 0) + 1 };
}

/** The node's offset in its file, which names the JSX expression a node came from. */
export function originOf(file: string, node: t.Node): string {
  return `${file}:${node.start ?? 0}`;
}

/** Parses one file. A syntax error is a problem, never a throw. */
export function parseModule(path: string, text: string): { module: ModuleInfo } | { problem: ExtractionProblem } {
  let program: t.Program;
  try {
    program = parse(text, { sourceType: "module", plugins: pluginsFor(path), sourceFilename: path }).program;
  } catch (error) {
    const loc = (error as { loc?: { line: number; column: number } }).loc;
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s*\(\d+:\d+\)$/, "").replace(/\.$/, "");
    return { problem: { message: `${path} does not parse: ${message}. Nothing in it can be checked.`, at: { file: path, line: loc?.line ?? 1, column: (loc?.column ?? 0) + 1 } } };
  }
  return { module: readModule(path, text, program) };
}

function stringValue(node: t.Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;
  return null;
}

function nameOf(node: t.Identifier | t.StringLiteral): string {
  return node.type === "Identifier" ? node.name : node.value;
}

function readModule(path: string, text: string, program: t.Program): ModuleInfo {
  const imports = new Map<string, ImportBinding>();
  const exports = new Map<string, ExportTarget>();
  const stars: string[] = [];
  const loads: ModuleLoad[] = [];

  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      const names: string[] = [];
      const typeOnly = statement.importKind === "type";
      for (const specifier of statement.specifiers) {
        const imported =
          specifier.type === "ImportDefaultSpecifier" ? "default" : specifier.type === "ImportNamespaceSpecifier" ? "*" : nameOf(specifier.imported);
        if (typeOnly || (specifier.type === "ImportSpecifier" && specifier.importKind === "type")) continue;
        names.push(imported);
        imports.set(specifier.local.name, { source: statement.source.value, imported, at: locationOf(path, specifier) });
      }
      if (!typeOnly) loads.push({ at: locationOf(path, statement), specifier: statement.source.value, how: "import", names });
      continue;
    }
    if (statement.type === "ExportAllDeclaration") {
      if (statement.exportKind === "type") continue;
      stars.push(statement.source.value);
      loads.push({ at: locationOf(path, statement), specifier: statement.source.value, how: "export-from", names: ["*"] });
      continue;
    }
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.declaration;
      if (declaration.type === "TSDeclareFunction") continue;
      if ((declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") && declaration.id) {
        exports.set("default", { kind: "local", name: declaration.id.name });
      } else {
        exports.set("default", { kind: "expression", node: declaration as t.Expression | t.FunctionDeclaration | t.ClassDeclaration });
      }
      continue;
    }
    if (statement.type === "ExportNamedDeclaration") {
      if (statement.exportKind === "type") continue;
      const source = statement.source?.value;
      if (source !== undefined) {
        const names: string[] = [];
        for (const specifier of statement.specifiers) {
          if (specifier.type === "ExportNamespaceSpecifier") {
            exports.set(specifier.exported.name, { kind: "namespace", source });
            names.push("*");
          } else if (specifier.type === "ExportDefaultSpecifier") {
            exports.set(specifier.exported.name, { kind: "reexport", source, imported: "default" });
            names.push("default");
          } else if (specifier.exportKind !== "type") {
            exports.set(nameOf(specifier.exported), { kind: "reexport", source, imported: specifier.local.name });
            names.push(specifier.local.name);
          }
        }
        loads.push({ at: locationOf(path, statement), specifier: source, how: "export-from", names });
        continue;
      }
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ExportSpecifier" && specifier.exportKind !== "type") exports.set(nameOf(specifier.exported), { kind: "local", name: specifier.local.name });
      }
      const declaration = statement.declaration;
      if (!declaration) continue;
      if ((declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") && declaration.id) {
        exports.set(declaration.id.name, { kind: "local", name: declaration.id.name });
      } else if (declaration.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) {
          for (const name of boundNames(declarator.id)) exports.set(name, { kind: "local", name });
        }
      }
    }
  }

  collectRuntimeLoads(path, program, loads);
  return { path, text, program, imports, exports, stars, loads };
}

/** Every name a binding pattern introduces. */
export function boundNames(pattern: t.LVal | t.Node): string[] {
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((property) => (property.type === "RestElement" ? boundNames(property.argument) : boundNames(property.value)));
    case "ArrayPattern":
      return pattern.elements.flatMap((element) => (element ? boundNames(element) : []));
    case "AssignmentPattern":
      return boundNames(pattern.left);
    case "RestElement":
      return boundNames(pattern.argument);
    default:
      return [];
  }
}

/** Unwraps TypeScript-only and parenthesised wrappers, which change nothing at runtime. */
export function unwrap(node: t.Expression): t.Expression {
  let current: t.Node = node;
  while (
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSInstantiationExpression" ||
    current.type === "ParenthesizedExpression"
  ) {
    current = current.expression;
  }
  return current as t.Expression;
}

function isRequireCallee(callee: t.Node): boolean {
  let current: t.Node = callee;
  while (current.type === "SequenceExpression" || current.type === "ParenthesizedExpression") {
    current = current.type === "SequenceExpression" ? (current.expressions[current.expressions.length - 1] as t.Node) : current.expression;
  }
  if (current.type === "Identifier") return current.name === "require";
  if (current.type === "MemberExpression" || current.type === "OptionalMemberExpression") {
    if (current.property.type === "Identifier" && !current.computed) return current.property.name === "require";
    return stringValue(current.property) === "require";
  }
  return false;
}

/** Dynamic `import()` and `require()` anywhere in the file, each of which loads a module as surely as an import does. */
function collectRuntimeLoads(path: string, program: t.Program, loads: ModuleLoad[]): void {
  visit(program, (node, parent) => {
    if (node.type === "ImportExpression") {
      loads.push({ at: locationOf(path, node), specifier: stringValue(node.source), how: "dynamic-import", names: ["*"] });
    } else if (node.type === "CallExpression" && node.callee.type === "Import") {
      loads.push({ at: locationOf(path, node), specifier: stringValue(node.arguments[0]), how: "dynamic-import", names: ["*"] });
    } else if (node.type === "CallExpression" && isRequireCallee(node.callee)) {
      loads.push({ at: locationOf(path, node), specifier: stringValue(node.arguments[0]), how: "require", names: ["*"] });
    } else if (node.type === "Identifier" && node.name === "require" && parent && heldAsValue(node, parent)) {
      // `const load = require` hides every later call behind another name.
      loads.push({ at: locationOf(path, node), specifier: null, how: "require", names: ["*"], held: true });
    }
  });
}

/** True when `require` is stored or passed rather than called. */
function heldAsValue(node: t.Node, parent: t.Node): boolean {
  switch (parent.type) {
    case "VariableDeclarator":
      return parent.init === node;
    case "AssignmentExpression":
      return parent.right === node;
    case "ObjectProperty":
      return parent.value === node;
    case "CallExpression":
    case "NewExpression":
      return parent.arguments.includes(node as t.Expression);
    case "ArrayExpression":
      return parent.elements.includes(node as t.Expression);
    case "ReturnStatement":
    case "ArrowFunctionExpression":
      return true;
    default:
      return false;
  }
}

const SKIP = new Set(["loc", "start", "end", "extra", "leadingComments", "trailingComments", "innerComments", "range", "typeAnnotation", "returnType", "typeParameters", "superTypeParameters"]);

/** Calls `fn` on every node under `root`, with its parent, depth first, in source order. Type annotations are skipped: they never render. */
export function visit(root: t.Node, fn: (node: t.Node, parent: t.Node | null) => void, parent: t.Node | null = null): void {
  fn(root, parent);
  for (const child of childNodes(root)) visit(child, fn, root);
}

/** A node's child nodes in source order, type annotations left out. */
export function childNodes(node: t.Node): t.Node[] {
  const out: t.Node[] = [];
  for (const key of Object.keys(node)) {
    if (SKIP.has(key)) continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item);
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

export function isNode(value: unknown): value is t.Node {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/**
 * Resolves a relative specifier to a prototype file, as a bundler would:
 * the path itself, then with a script extension, then as a folder's index.
 * Returns null for a bare package name or a path the prototype lacks.
 */
export function resolvePath(from: string, specifier: string, files: ReadonlySet<string>): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../") && specifier !== "." && specifier !== "..") return null;
  const parts = from.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  const base = parts.join("/");
  const candidates = [base, ...[".tsx", ".ts", ".jsx", ".js"].map((ext) => `${base}${ext}`), ...["index.tsx", "index.ts", "index.jsx", "index.js"].map((name) => (base ? `${base}/${name}` : name))];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}
