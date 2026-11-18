import type * as t from "@babel/types";
import type { Literal } from "../rules/types";
import type { ElementKind, ElementNode, ExtractionProblem, PropValue, SourceLocation } from "./model";
import { boundNames, isScript, locationOf, originOf, resolvePath, unwrap, visit, type ImportBinding, type ModuleInfo } from "./modules";
import { Env, UNDEFINED, choice, member, truthiness, unknown, type FunctionNode, type Piece, type Value } from "./values";

/** The module a prototype imports its page kit from: `Slot` fills a page type's named slot. */
export const PAGE_KIT = "@design-harness/page";
export const KIT_PARTS = ["Slot"] as const;

/** React parts that render their children and nothing of their own. */
const TRANSPARENT = new Set(["Fragment", "Suspense", "StrictMode", "Profiler"]);
/** React calls that build elements outside JSX, which the extractor cannot see into. */
const ELEMENT_FACTORIES = new Set(["createElement", "cloneElement", "jsx", "jsxs", "jsxDEV"]);

/** Bounds that keep a pathological prototype from running away; reaching one is a finding, not a pass. */
const MAX_DEPTH = 64;
const MAX_NODES = 50_000;

export type Marks = ReadonlyMap<t.Node, { readonly page?: string; readonly layout?: string }>;

export type EvaluatorContext = {
  readonly modules: ReadonlyMap<string, ModuleInfo>;
  readonly files: ReadonlySet<string>;
  readonly library: string;
  readonly problems: ExtractionProblem[];
};

export type Tag =
  | { readonly kind: "intrinsic" | "library" | "kit"; readonly name: string }
  | { readonly kind: "fragment" }
  | { readonly kind: "component"; readonly fn: Extract<Value, { k: "fn" }>; readonly name: string }
  | { readonly kind: "unresolved"; readonly name: string; readonly reason: string };

/**
 * Evaluates the prototype's source as far as it can be read without running
 * it: bindings, imports and exports, props passed to local components, and
 * the JSX each component returns. Local components are expanded in place, so
 * a page's tree holds what it renders across files.
 */
export class Evaluator {
  private readonly envs = new Map<string, Env>();
  private readonly stack: t.Node[] = [];
  private nodes = 0;
  private marks: Marks = new Map();
  private overBudget = false;

  constructor(private readonly ctx: EvaluatorContext) {}

  setMarks(marks: Marks): void {
    this.marks = marks;
  }

  isLibrary(specifier: string): boolean {
    return specifier === this.ctx.library || specifier.startsWith(`${this.ctx.library}/`);
  }

  moduleEnv(module: ModuleInfo): Env {
    const cached = this.envs.get(module.path);
    if (cached) return cached;
    const env = new Env(module, null);
    this.envs.set(module.path, env);
    for (const [local, binding] of module.imports) env.lazy(local, () => this.resolveImport(module, binding));
    this.hoist(
      module.program.body.flatMap((statement): t.Statement[] => {
        if (statement.type === "ExportNamedDeclaration" && statement.declaration) return [statement.declaration];
        if (statement.type === "ExportDefaultDeclaration" && (statement.declaration.type === "FunctionDeclaration" || statement.declaration.type === "ClassDeclaration") && statement.declaration.id) {
          return [statement.declaration];
        }
        return [statement];
      }),
      env,
    );
    return env;
  }

  resolveImport(module: ModuleInfo, binding: Pick<ImportBinding, "source" | "imported">): Value {
    const { source, imported } = binding;
    if (this.isLibrary(source)) {
      if (imported === "*") return { k: "lib", path: [] };
      if (imported === "default") return unknown(`the default export of "${source}" is not a part the rules know`);
      return { k: "lib", path: [imported] };
    }
    if (source === PAGE_KIT) return imported === "*" ? { k: "kit", name: "" } : { k: "kit", name: imported };
    if (source === "react" || source === "react/jsx-runtime") return imported === "*" || imported === "default" ? { k: "react", name: null } : { k: "react", name: imported };
    const path = resolvePath(module.path, source, this.ctx.files);
    if (path === null) return unknown(`"${source}" is not a file in the prototype or the project's library`, true);
    const target = this.ctx.modules.get(path);
    if (!target) return unknown(isScript(path) ? `${path} could not be parsed` : `${path} is not a script`, true);
    if (imported === "*") return { k: "ns", module: target };
    return this.resolveExport(target, imported) ?? unknown(`${path} has no export "${imported}"`, true);
  }

  /** The value a module exports under `name`, following re-exports; null when it has no such export. */
  resolveExport(module: ModuleInfo, name: string, seen: ReadonlySet<string> = new Set()): Value | null {
    const key = `${module.path}#${name}`;
    if (seen.has(key)) return unknown(`${module.path} re-exports "${name}" in a cycle`);
    const next = new Set([...seen, key]);
    const target = module.exports.get(name);
    if (target) {
      switch (target.kind) {
        case "local":
          return this.moduleEnv(module).lookup(target.name);
        case "expression":
          return this.evaluate(target.node, this.moduleEnv(module));
        case "namespace":
          return this.resolveImport(module, { source: target.source, imported: "*" });
        case "reexport": {
          const path = resolvePath(module.path, target.source, this.ctx.files);
          const reexported = path ? this.ctx.modules.get(path) : undefined;
          if (reexported) return this.resolveExport(reexported, target.imported, next) ?? unknown(`${path} has no export "${target.imported}"`);
          return this.resolveImport(module, { source: target.source, imported: target.imported });
        }
      }
    }
    // `export *` never re-exports a default.
    if (name === "default") return null;
    for (const source of module.stars) {
      if (this.isLibrary(source)) return { k: "lib", path: [name] };
      const path = resolvePath(module.path, source, this.ctx.files);
      const starred = path ? this.ctx.modules.get(path) : undefined;
      const found = starred ? this.resolveExport(starred, name, next) : null;
      if (found) return found;
    }
    return null;
  }

  /** Binds the declarations a list of statements makes, as JavaScript hoists them. */
  hoist(statements: readonly t.Statement[], env: Env): void {
    for (const statement of statements) {
      if (statement.type === "FunctionDeclaration" && statement.id) {
        env.set(statement.id.name, { k: "fn", node: statement, env, name: statement.id.name });
      } else if (statement.type === "ClassDeclaration" && statement.id) {
        env.set(statement.id.name, unknown(`${statement.id.name} is a class component, which the extractor does not read`));
      } else if (statement.type === "VariableDeclaration") {
        for (const declarator of statement.declarations) this.declare(declarator, statement.kind, env);
      } else if (statement.type === "TSEnumDeclaration") {
        env.set(statement.id.name, unknown(`${statement.id.name} is an enum`));
      }
    }
  }

  private declare(declarator: t.VariableDeclarator, kind: t.VariableDeclaration["kind"], env: Env): void {
    const init = declarator.init;
    if (kind !== "const" || !init) {
      for (const name of boundNames(declarator.id)) env.set(name, unknown(`"${name}" is declared with ${kind}, so it may change`));
      return;
    }
    if (declarator.id.type === "Identifier") {
      const name = declarator.id.name;
      env.lazy(name, () => {
        const value = this.evaluate(init, env);
        return value.k === "fn" && value.name === "" ? { ...value, name } : value;
      });
      return;
    }
    let shared: Env | null = null;
    const pattern = declarator.id;
    const destructured = () => {
      if (!shared) {
        shared = new Env(env.module, null);
        this.bind(pattern, this.evaluate(init, env), shared, env);
      }
      return shared;
    };
    for (const name of boundNames(pattern)) env.lazy(name, () => destructured().lookup(name));
  }

  /** Binds a parameter or destructuring pattern to a value. Defaults are evaluated in `scope`. */
  bind(pattern: t.Node, value: Value, target: Env, scope: Env): void {
    switch (pattern.type) {
      case "Identifier":
        target.set(pattern.name, value);
        return;
      case "AssignmentPattern": {
        const missing = value.k === "lit" && value.v === undefined;
        this.bind(pattern.left, missing ? this.evaluate(pattern.right, scope) : value, target, scope);
        return;
      }
      case "ObjectPattern": {
        const used = new Set<string>();
        for (const property of pattern.properties) {
          if (property.type === "RestElement") {
            if (value.k === "obj") {
              const rest = new Map([...value.entries].filter(([key]) => !used.has(key)));
              this.bind(property.argument, { k: "obj", entries: rest, open: value.open }, target, scope);
            } else {
              this.bind(property.argument, value.k === "unknown" ? value : unknown("the rest of a value the extractor cannot see"), target, scope);
            }
            continue;
          }
          const key = !property.computed && property.key.type === "Identifier" ? property.key.name : property.key.type === "StringLiteral" ? property.key.value : null;
          if (key === null) {
            for (const name of boundNames(property.value)) target.set(name, unknown("a computed key"));
            continue;
          }
          used.add(key);
          this.bind(property.value, member(value, key), target, scope);
        }
        return;
      }
      case "ArrayPattern":
        pattern.elements.forEach((element, index) => {
          if (!element) return;
          const item = value.k === "arr" ? (value.items[index] ?? UNDEFINED) : unknown(value.k === "unknown" ? value.why : "an item of a value the extractor cannot see");
          this.bind(element, element.type === "RestElement" ? unknown("the rest of an array") : item, target, scope);
        });
        return;
      case "RestElement":
        this.bind(pattern.argument, unknown("rest parameters"), target, scope);
        return;
      default:
        for (const name of boundNames(pattern)) target.set(name, unknown("a pattern the extractor does not read"));
    }
  }

  private snippet(node: t.Node, env: Env): string {
    const text = env.module.text.slice(node.start ?? 0, node.end ?? 0).replace(/\s+/g, " ");
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  }

  evaluate(input: t.Node, env: Env): Value {
    const node = isExpression(input) ? unwrap(input) : input;
    switch (node.type) {
      case "StringLiteral":
      case "NumericLiteral":
      case "BooleanLiteral":
        return { k: "lit", v: node.value };
      case "NullLiteral":
        return { k: "lit", v: null };
      case "TemplateLiteral": {
        let text = node.quasis[0]?.value.cooked ?? "";
        for (const [index, expression] of node.expressions.entries()) {
          const part = this.evaluate(expression, env);
          if (part.k !== "lit" || part.v === undefined) return unknown(`\`${this.snippet(node, env)}\` is built at runtime`);
          text += String(part.v) + (node.quasis[index + 1]?.value.cooked ?? "");
        }
        return { k: "lit", v: text };
      }
      case "Identifier":
        return env.lookup(node.name);
      case "MemberExpression":
      case "OptionalMemberExpression": {
        const key = this.propertyKey(node, env);
        const object = this.evaluate(node.object, env);
        if (key === null) return unknown(`\`${this.snippet(node, env)}\` reads a computed property`);
        return this.memberOf(object, key);
      }
      case "ConditionalExpression": {
        const test = truthiness(this.evaluate(node.test, env));
        if (test === true) return this.evaluate(node.consequent, env);
        if (test === false) return this.evaluate(node.alternate, env);
        return choice([this.evaluate(node.consequent, env), this.evaluate(node.alternate, env)]);
      }
      case "LogicalExpression": {
        const left = this.evaluate(node.left, env);
        const test = node.operator === "??" ? (left.k === "lit" ? left.v !== null && left.v !== undefined : null) : truthiness(left);
        if (node.operator === "&&") {
          if (test === true) return this.evaluate(node.right, env);
          if (test === false) return left;
          return choice([this.evaluate(node.right, env), { k: "falsy", why: `\`${this.snippet(node.left, env)}\` may be false` }]);
        }
        if (test === true) return left;
        if (test === false) return this.evaluate(node.right, env);
        return choice([left, this.evaluate(node.right, env)]);
      }
      case "UnaryExpression": {
        if (node.operator === "void") return UNDEFINED;
        const argument = this.evaluate(node.argument, env);
        if (node.operator === "!") {
          const test = truthiness(argument);
          return test === null ? unknown(`\`${this.snippet(node, env)}\` is computed`) : { k: "lit", v: !test };
        }
        if (node.operator === "-" && argument.k === "lit" && typeof argument.v === "number") return { k: "lit", v: -argument.v };
        return unknown(`\`${this.snippet(node, env)}\` is computed`);
      }
      case "BinaryExpression": {
        if (node.operator === "+" && node.left.type !== "PrivateName") {
          const left = this.evaluate(node.left, env);
          const right = this.evaluate(node.right, env);
          if (left.k === "lit" && right.k === "lit" && (typeof left.v === "string" || typeof right.v === "string")) return { k: "lit", v: `${String(left.v)}${String(right.v)}` };
        }
        return unknown(`\`${this.snippet(node, env)}\` is computed`);
      }
      case "SequenceExpression":
        return this.evaluate(node.expressions[node.expressions.length - 1] as t.Expression, env);
      case "JSXElement":
        return this.jsxElement(node, env);
      case "JSXFragment":
        return { k: "render", pieces: this.jsxChildren(node.children, env) };
      case "ArrowFunctionExpression":
      case "FunctionExpression":
        return { k: "fn", node, env, name: node.type === "FunctionExpression" && node.id ? node.id.name : "" };
      case "FunctionDeclaration":
        return { k: "fn", node, env, name: node.id?.name ?? "" };
      case "ObjectExpression":
        return this.objectOf(node, env);
      case "ArrayExpression": {
        const items: Value[] = [];
        for (const element of node.elements) {
          if (!element) items.push(UNDEFINED);
          else if (element.type === "SpreadElement") {
            const spread = this.evaluate(element.argument, env);
            if (spread.k !== "arr") return unknown(`\`${this.snippet(node, env)}\` spreads a list the extractor cannot see`);
            items.push(...spread.items);
          } else items.push(this.evaluate(element, env));
        }
        return { k: "arr", items };
      }
      case "CallExpression":
      case "OptionalCallExpression":
        return this.call(node, env);
      case "ImportExpression":
        return unknown("a dynamic import, which loads a module at runtime", true);
      default:
        return unknown(`\`${this.snippet(node, env)}\` is computed at runtime`);
    }
  }

  private propertyKey(node: t.MemberExpression | t.OptionalMemberExpression, env: Env): string | null {
    if (!node.computed && node.property.type === "Identifier") return node.property.name;
    if (node.property.type === "PrivateName") return null;
    const key = this.evaluate(node.property, env);
    return key.k === "lit" && (typeof key.v === "string" || typeof key.v === "number") ? String(key.v) : null;
  }

  memberOf(object: Value, key: string): Value {
    if (object.k === "ns") return this.resolveExport(object.module, key) ?? unknown(`${object.module.path} has no export "${key}"`);
    return member(object, key);
  }

  private objectOf(node: t.ObjectExpression, env: Env): Value {
    const entries = new Map<string, Value>();
    let open: string | null = null;
    for (const property of node.properties) {
      if (property.type === "SpreadElement") {
        const spread = this.evaluate(property.argument, env);
        if (spread.k === "obj") {
          for (const [key, value] of spread.entries) entries.set(key, value);
          open = spread.open ?? open;
        } else {
          open = `\`${this.snippet(property, env)}\` spreads a value the extractor cannot see`;
        }
        continue;
      }
      const key = !property.computed && property.key.type === "Identifier" ? property.key.name : property.key.type === "StringLiteral" ? property.key.value : null;
      if (key === null) {
        open = `\`${this.snippet(property, env)}\` has a computed key`;
        continue;
      }
      entries.set(key, property.type === "ObjectMethod" ? { k: "fn", node: property, env, name: key } : this.evaluate(property.value, env));
    }
    return { k: "obj", entries, open };
  }

  private call(node: t.CallExpression | t.OptionalCallExpression, env: Env): Value {
    const callee = unwrapNode(node.callee);
    if (callee.type === "Import") return unknown("a dynamic import, which loads a module at runtime", true);
    const args = node.arguments.map((argument) =>
      argument.type === "SpreadElement" || argument.type === "ArgumentPlaceholder" ? unknown("a spread argument") : this.evaluate(argument as t.Expression, env),
    );
    if ((callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") && !callee.computed && callee.property.type === "Identifier") {
      const method = callee.property.name;
      const object = this.evaluate(callee.object, env);
      if (method === "map" || method === "flatMap") return this.mapOver(object, args[0] ?? UNDEFINED);
      if (object.k !== "react" && object.k !== "ns" && object.k !== "obj") {
        return unknown(`\`${this.snippet(node, env)}\` is the result of a call`);
      }
      return this.apply(this.memberOf(object, method), args, node, env);
    }
    return this.apply(this.evaluate(callee, env), args, node, env);
  }

  private apply(fn: Value, args: readonly Value[], node: t.Node, env: Env): Value {
    if (fn.k === "fn") return this.callFunction(fn, args);
    if (fn.k === "react" && fn.name !== null) {
      if (fn.name === "memo" || fn.name === "forwardRef" || fn.name === "useCallback") return args[0] ?? UNDEFINED;
      if (fn.name === "useMemo") {
        const factory = args[0];
        return factory?.k === "fn" ? this.callFunction(factory, []) : unknown("useMemo without a function");
      }
      if (ELEMENT_FACTORIES.has(fn.name)) {
        const at = locationOf(env.module.path, node);
        return { k: "render", pieces: [{ kind: "node", node: this.unresolvedNode(at, originOf(env.module.path, node), `React.${fn.name}`, `React.${fn.name} builds an element without JSX, which the extractor cannot read`) }] };
      }
      if (fn.name === "lazy") return unknown("React.lazy loads a component at runtime", true);
    }
    return unknown(`\`${this.snippet(node, env)}\` calls a function the extractor cannot see`, true);
  }

  /** `list.map(fn)`: each item of a list written in the source, or once for a list it cannot see, marked repeated. */
  private mapOver(list: Value, callback: Value): Value {
    if (callback.k !== "fn") return unknown("a map whose callback the extractor cannot see");
    if (list.k === "arr") return { k: "arr", items: list.items.map((item, index) => this.callFunction(callback, [item, { k: "lit", v: index }, list])) };
    const once = this.callFunction(callback, [unknown("an item of a list the extractor cannot see"), unknown("an index"), list]);
    return repeated(once);
  }

  callFunction(fn: Extract<Value, { k: "fn" }>, args: readonly Value[]): Value {
    if (this.stack.includes(fn.node)) return unknown(`${fn.name || "a function"} calls itself`, true);
    if (this.stack.length >= MAX_DEPTH) return unknown(`calls nest more than ${MAX_DEPTH} deep`, true);
    this.stack.push(fn.node);
    try {
      const scope = new Env(fn.env.module, fn.env);
      fn.node.params.forEach((param, index) => this.bind(param, args[index] ?? UNDEFINED, scope, scope));
      const body = fn.node.body;
      return body.type === "BlockStatement" ? this.block(body.body, scope) : this.evaluate(body, scope);
    } finally {
      this.stack.pop();
    }
  }

  /** What a function body returns: one value, or a choice of every return it can reach. */
  private block(statements: readonly t.Statement[], env: Env): Value {
    const returns: Value[] = [];
    let branched = false;
    const walk = (list: readonly t.Statement[], scope: Env, nested: boolean) => {
      const inner = nested ? new Env(scope.module, scope) : scope;
      this.hoist(list, inner);
      for (const statement of list) {
        switch (statement.type) {
          case "ReturnStatement":
            returns.push(statement.argument ? this.evaluate(statement.argument, inner) : UNDEFINED);
            if (nested) branched = true;
            return;
          case "IfStatement":
            walk([statement.consequent], inner, true);
            if (statement.alternate) walk([statement.alternate], inner, true);
            break;
          case "BlockStatement":
            walk(statement.body, inner, true);
            break;
          case "SwitchStatement":
            for (const clause of statement.cases) walk(clause.consequent, inner, true);
            break;
          case "TryStatement":
            walk(statement.block.body, inner, true);
            if (statement.handler) walk(statement.handler.body.body, inner, true);
            if (statement.finalizer) walk(statement.finalizer.body, inner, true);
            break;
          case "ForStatement":
          case "ForInStatement":
          case "ForOfStatement":
          case "WhileStatement":
          case "DoWhileStatement":
          case "LabeledStatement":
            walk([statement.body], inner, true);
            break;
          default:
        }
      }
    };
    walk(statements, env, false);
    if (returns.length === 0) return UNDEFINED;
    if (returns.length === 1 && !branched) return returns[0] as Value;
    return choice(branched && returns.length === 1 ? [returns[0] as Value, UNDEFINED] : returns);
  }

  resolveTag(name: t.JSXOpeningElement["name"], env: Env): Tag {
    if (name.type === "JSXNamespacedName") return { kind: "intrinsic", name: `${name.namespace.name}:${name.name.name}` };
    if (name.type === "JSXIdentifier" && (/^[a-z]/.test(name.name) || name.name.includes("-"))) return { kind: "intrinsic", name: name.name };
    const written = jsxName(name);
    const value = this.tagValue(name, env);
    switch (value.k) {
      case "lib":
        return value.path.length > 0 ? { kind: "library", name: value.path.join(".") } : { kind: "unresolved", name: written, reason: `${written} is the library's namespace, not a part` };
      case "kit":
        return (KIT_PARTS as readonly string[]).includes(value.name) ? { kind: "kit", name: value.name } : { kind: "unresolved", name: written, reason: `the page kit has no part "${value.name}"` };
      case "react":
        if (value.name !== null && TRANSPARENT.has(value.name)) return { kind: "fragment" };
        return { kind: "unresolved", name: written, reason: `React's ${value.name ?? "namespace"} is not a component the extractor reads` };
      case "fn":
        return { kind: "component", fn: value, name: value.name || written };
      case "lit":
        return typeof value.v === "string" && /^[a-z]/.test(value.v) ? { kind: "intrinsic", name: value.v } : { kind: "unresolved", name: written, reason: `${written} is not a component` };
      case "choice":
        return { kind: "unresolved", name: written, reason: `${written} is chosen at runtime` };
      case "unknown":
        return { kind: "unresolved", name: written, reason: value.why };
      default:
        return { kind: "unresolved", name: written, reason: `${written} is not a component the extractor can follow` };
    }
  }

  private tagValue(name: t.JSXIdentifier | t.JSXMemberExpression, env: Env): Value {
    if (name.type === "JSXIdentifier") return name.name === "this" ? unknown("this") : env.lookup(name.name);
    return this.memberOf(this.tagValue(name.object, env), name.property.name);
  }

  /** Evaluates a JSX element: a node for a library, HTML, kit or unresolved element; the expansion for a local component. */
  jsxElement(node: t.JSXElement, env: Env): Value {
    const file = env.module.path;
    const at = locationOf(file, node);
    const origin = originOf(file, node);
    const tag = this.resolveTag(node.openingElement.name, env);
    const { props, open } = this.attributes(node.openingElement.attributes, env);
    const children = this.jsxChildren(node.children, env);
    if (tag.kind === "fragment") {
      const fallback = props.get("fallback");
      return { k: "render", pieces: [...children, ...(fallback ? conditional(this.piecesOf(fallback)) : [])] };
    }
    if (tag.kind === "component") return this.expand(tag.fn, tag.name, at, origin, props, open, children);
    const extra: Piece[] = [];
    for (const [name, value] of props) {
      if (value.k === "render" || value.k === "choice" || value.k === "arr") extra.push(...this.piecesOf(value).filter((piece) => piece.kind === "node"));
      // A function prop on a library part may be a render prop the part calls any number of times.
      // An event handler (onClick) runs later, not while rendering, so what it builds is not on the page.
      if (value.k === "fn" && tag.kind === "library" && !/^on[A-Z]/.test(name) && containsJsx(value.node)) {
        extra.push(...this.piecesOf(repeated(this.callFunction(value, [unknown("an argument the library passes")]))).filter((piece) => piece.kind === "node"));
      }
    }
    const kind: ElementKind = tag.kind;
    return { k: "render", pieces: [{ kind: "node", node: this.makeNode(kind, tag.name, at, origin, props, open, [...children, ...extra], tag.kind === "unresolved" ? tag.reason : undefined, node, env) }] };
  }

  /** A local component, rendered with the props written at the call site. */
  private expand(fn: Extract<Value, { k: "fn" }>, name: string, at: SourceLocation, origin: string, props: ReadonlyMap<string, Value>, open: string | null, children: readonly Piece[]): Value {
    if (this.stack.includes(fn.node)) {
      return { k: "render", pieces: [{ kind: "node", node: this.unresolvedNode(at, origin, name, `${name} renders itself, so how deep it goes cannot be known`) }] };
    }
    const entries = new Map(props);
    if (children.length > 0) entries.set("children", { k: "render", pieces: children });
    const result = this.callFunction(fn, [{ k: "obj", entries, open }, unknown("a ref")]);
    const pieces = this.piecesOf(result, { at, origin: `${origin}:returns` });
    const mark = this.marks.get(fn.node);
    const { nodes, text, dynamic } = assemble(pieces);
    this.count();
    return {
      k: "render",
      pieces: [
        {
          kind: "node",
          node: {
            kind: "component",
            name,
            at,
            origin,
            props: propValues(props, () => "a prop of a local component"),
            ...(open ? { openProps: open } : {}),
            text,
            textDynamic: dynamic,
            conditional: false,
            repeated: false,
            ...(mark?.page ? { page: mark.page } : {}),
            ...(mark?.layout ? { layout: mark.layout } : {}),
            children: nodes,
          },
        },
      ],
    };
  }

  private attributes(attributes: t.JSXOpeningElement["attributes"], env: Env): { props: Map<string, Value>; open: string | null } {
    const props = new Map<string, Value>();
    let open: string | null = null;
    for (const attribute of attributes) {
      if (attribute.type === "JSXSpreadAttribute") {
        const spread = this.evaluate(attribute.argument, env);
        const at = locationOf(env.module.path, attribute);
        if (spread.k === "obj") {
          for (const [key, value] of spread.entries) props.set(key, value);
          if (spread.open) open = spread.open;
          continue;
        }
        open = `the spread \`${this.snippet(attribute, env)}\` at line ${at.line} may set any prop`;
        for (const key of [...props.keys()]) props.set(key, unknown(`may be overridden by ${open.replace(/ may set any prop$/, "")}`));
        continue;
      }
      const name = attribute.name.type === "JSXIdentifier" ? attribute.name.name : `${attribute.name.namespace.name}:${attribute.name.name.name}`;
      if (name === "key" || name === "ref") continue;
      const value = attribute.value;
      let evaluated: Value;
      if (value === null || value === undefined) evaluated = { k: "lit", v: true };
      else if (value.type === "StringLiteral") evaluated = { k: "lit", v: value.value };
      else if (value.type === "JSXExpressionContainer") {
        evaluated = value.expression.type === "JSXEmptyExpression" ? UNDEFINED : this.evaluate(value.expression, env);
        if (evaluated.k === "unknown") evaluated = unknown(`computed from \`${this.snippet(value.expression, env)}\``);
      } else evaluated = this.evaluate(value, env);
      props.set(name, evaluated);
    }
    return { props, open };
  }

  private jsxChildren(children: readonly t.Node[], env: Env): Piece[] {
    const pieces: Piece[] = [];
    for (const child of children) {
      if (child.type === "JSXText") {
        const text = cleanJsxText(child.value);
        if (text) pieces.push({ kind: "text", text });
      } else if (child.type === "JSXExpressionContainer") {
        if (child.expression.type !== "JSXEmptyExpression") {
          const site = { at: locationOf(env.module.path, child), origin: originOf(env.module.path, child) };
          pieces.push(...this.piecesOf(this.evaluate(child.expression, env), site));
        }
      } else if (child.type === "JSXSpreadChild") {
        pieces.push({ kind: "dynamic" });
      } else {
        pieces.push(...this.piecesOf(this.evaluate(child, env)));
      }
    }
    return pieces;
  }

  /** What a value renders as a child. At a `site`, an opaque value becomes an unresolved element, since it may render anything. */
  piecesOf(value: Value, site?: { readonly at: SourceLocation; readonly origin: string }): Piece[] {
    switch (value.k) {
      case "lit":
        return typeof value.v === "string" || typeof value.v === "number" ? [{ kind: "text", text: String(value.v) }] : [];
      case "falsy":
        return [];
      case "render":
        return [...value.pieces];
      case "arr":
        return value.items.flatMap((item) => this.piecesOf(item, site));
      case "choice": {
        const pieces = value.of.flatMap((option) => this.piecesOf(option, site));
        const nodes = conditional(pieces.filter((piece) => piece.kind === "node"));
        return pieces.some((piece) => piece.kind !== "node") ? [...nodes, { kind: "dynamic" }] : nodes;
      }
      case "unknown":
        if (value.opaque && site) return [{ kind: "node", node: this.unresolvedNode(site.at, site.origin, "{…}", value.why) }];
        return [{ kind: "dynamic" }];
      default:
        return [{ kind: "dynamic" }];
    }
  }

  /** Expands a component as if rendered with no props, as a manifest page is. */
  renderComponent(fn: Extract<Value, { k: "fn" }>, name: string, at: SourceLocation, origin: string): ElementNode {
    // A page's props come from whatever renders it at runtime, so none of them is known.
    const rendered = this.expand(fn, name, at, origin, new Map(), "a page's props are given at runtime", []);
    const piece = rendered.k === "render" ? rendered.pieces[0] : undefined;
    return piece?.kind === "node" ? piece.node : this.unresolvedNode(at, origin, name, `${name} did not render`);
  }

  private count(): void {
    this.nodes += 1;
    if (this.nodes > MAX_NODES && !this.overBudget) {
      this.overBudget = true;
      this.ctx.problems.push({ message: `the prototype renders more than ${MAX_NODES} elements, so the extractor stopped expanding it` });
    }
  }

  private makeNode(kind: ElementKind, name: string, at: SourceLocation, origin: string, props: ReadonlyMap<string, Value>, open: string | null, pieces: readonly Piece[], reason: string | undefined, jsx: t.JSXElement, env: Env): ElementNode {
    this.count();
    const { nodes, text, dynamic } = assemble(pieces);
    return {
      kind,
      name,
      at,
      origin,
      props: propValues(props, (key) => {
        const attribute = jsx.openingElement.attributes.find((item) => item.type === "JSXAttribute" && item.name.type === "JSXIdentifier" && item.name.name === key);
        return attribute ? `computed from \`${this.snippet(attribute, env)}\`` : "computed";
      }),
      ...(open ? { openProps: open } : {}),
      text,
      textDynamic: dynamic,
      conditional: false,
      repeated: false,
      ...(reason ? { reason } : {}),
      children: this.overBudget ? [] : nodes,
    };
  }

  unresolvedNode(at: SourceLocation, origin: string, name: string, reason: string): ElementNode {
    this.count();
    return { kind: "unresolved", name, at, origin, props: {}, text: "", textDynamic: true, conditional: false, repeated: false, reason, children: [] };
  }
}

function isExpression(node: t.Node): node is t.Expression {
  return node.type !== "FunctionDeclaration" && node.type !== "ClassDeclaration";
}

function unwrapNode(node: t.Node): t.Node {
  return node.type === "Import" || node.type === "V8IntrinsicIdentifier" ? node : unwrap(node as t.Expression);
}

function jsxName(name: t.JSXIdentifier | t.JSXMemberExpression): string {
  return name.type === "JSXIdentifier" ? name.name : `${jsxName(name.object)}.${name.property.name}`;
}

function containsJsx(node: FunctionNode): boolean {
  let found = false;
  visit(node.body, (child) => {
    if (child.type === "JSXElement" || child.type === "JSXFragment") found = true;
  });
  return found;
}

/** React's rule for JSX text: lines are trimmed, blank lines dropped, and the rest joined by one space. */
export function cleanJsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  if (lines.length === 1) return raw;
  const kept: string[] = [];
  lines.forEach((line, index) => {
    let text = line.replace(/\t/g, " ");
    if (index > 0) text = text.replace(/^[ ]+/, "");
    if (index < lines.length - 1) text = text.replace(/[ ]+$/, "");
    if (text) kept.push(text);
  });
  return kept.join(" ");
}

function assemble(pieces: readonly Piece[]): { nodes: ElementNode[]; text: string; dynamic: boolean } {
  const nodes: ElementNode[] = [];
  let text = "";
  let dynamic = false;
  for (const piece of pieces) {
    if (piece.kind === "node") {
      nodes.push(piece.node);
      text += piece.node.text;
      dynamic ||= piece.node.textDynamic;
    } else if (piece.kind === "text") text += piece.text;
    else dynamic = true;
  }
  return { nodes, text: text.replace(/\s+/g, " ").trim(), dynamic };
}

function conditional(pieces: readonly Piece[]): Piece[] {
  return pieces.map((piece) => (piece.kind === "node" ? { kind: "node", node: { ...piece.node, conditional: true } } : piece));
}

/** Marks every element a value renders as repeated: it renders once per item of a list of unknown length. */
function repeated(value: Value): Value {
  switch (value.k) {
    case "render":
      return { k: "render", pieces: value.pieces.map((piece) => (piece.kind === "node" ? { kind: "node", node: { ...piece.node, repeated: true } } : piece.kind === "text" ? { kind: "dynamic" } : piece)) };
    case "choice":
      return { k: "choice", of: value.of.map(repeated) };
    case "arr":
      return { k: "arr", items: value.items.map(repeated) };
    case "lit":
      return typeof value.v === "string" || typeof value.v === "number" ? unknown("text repeated for each item of a list") : value;
    default:
      return value;
  }
}

function propValues(props: ReadonlyMap<string, Value>, reasonFor: (key: string) => string): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const key of [...props.keys()].sort()) {
    const value = props.get(key) as Value;
    const converted = propValue(value, () => (value.k === "unknown" ? value.why : reasonFor(key)));
    if (converted) out[key] = converted;
  }
  return out;
}

/** A prop as rules see it. Undefined is a prop not given, as React treats it. */
function propValue(value: Value, reason: () => string): PropValue | null {
  if (value.k === "lit") return value.v === undefined ? null : { kind: "literal", value: value.v };
  if (value.k === "render") return { kind: "elements" };
  if (value.k === "choice") {
    const literals: Literal[] = [];
    for (const option of value.of) {
      if (option.k !== "lit" || option.v === undefined) return { kind: "dynamic", reason: reason() };
      literals.push(option.v);
    }
    return { kind: "choice", values: literals };
  }
  return { kind: "dynamic", reason: reason() };
}
