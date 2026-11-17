import type * as t from "@babel/types";
import type { AmbientUse } from "./model";
import { boundNames, childNodes, locationOf, type ModuleInfo } from "./modules";

/**
 * What prototype code reaches beyond its imports. A prototype runs in the
 * same frame as the code that measures it, so code that could reach the
 * frame's window, its document, the channel to the app or the built-ins the
 * measuring code calls could change what its own frame reports. This scan
 * finds every way out the source shows, and fails closed: a name not on the
 * allowlist below is a use, and a property read by a computed key is one the
 * scan cannot clear.
 *
 * It reports:
 * - `global`: a free name (one no import, declaration or parameter binds)
 *   that is not a plain language built-in on `INTRINSICS`;
 * - `member`: a property name that leads from an ordinary value to a
 *   constructor, a prototype, the frame's window or document, or the frame's
 *   plumbing (`.constructor`, `.ownerDocument`, `.target`, `.postMessage`);
 * - `computed`: a property read or destructured by a key computed at run time;
 * - `write`: an assignment to a property, which is how built-ins get changed;
 * - `dom`: what hands code a DOM node or runs markup as code (`ref`,
 *   `useRef`, `dangerouslySetInnerHTML`, `<iframe>`, `<script>`);
 * - `meta`: `import.meta`.
 *
 * `require` is left to the imports rule, which already reports every call.
 */

/**
 * Free names prototype code may use: plain ECMAScript built-ins that hold no
 * path to the global object once the member names below are refused. `Object`
 * and `JSON` may only be called through the members `RESTRICTED` lists, since
 * their other members enumerate an object's values, which is a path from an
 * event to its window.
 */
const INTRINSICS = new Set([
  "undefined",
  "NaN",
  "Infinity",
  "arguments",
  "Math",
  "JSON",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Symbol",
  "BigInt",
  "Date",
  "Intl",
  "RegExp",
  "Promise",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "AggregateError",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "console",
]);

/** Built-ins that may only be used as `Name.member(...)`, with one of these members. */
const RESTRICTED: Readonly<Record<string, readonly string[]>> = {
  Object: ["assign", "freeze", "fromEntries", "hasOwn", "is", "isFrozen", "keys"],
  JSON: ["parse", "stringify"],
};

/** Names the imports rule already reports. */
const LEFT_TO_IMPORTS = new Set(["require"]);

/** Why a property name is refused, by name. */
const MEMBERS: ReadonlyMap<string, string> = new Map([
  ...["constructor", "prototype", "caller", "callee"].map((name) => [name, "leads from a value to a constructor or a prototype"] as const),
  ...["getPrototypeOf", "setPrototypeOf", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "getOwnPropertyNames", "getOwnPropertySymbols", "defineProperty", "defineProperties"].map(
    (name) => [name, "reads or changes an object's internals"] as const,
  ),
  ...["prepareStackTrace", "captureStackTrace", "stackTraceLimit"].map((name) => [name, "hooks the engine's stack traces"] as const),
  ...["window", "self", "globalThis", "parent", "top", "frames", "opener", "document"].map((name) => [name, "is the frame's window or document"] as const),
  ...["ownerDocument", "defaultView", "documentElement", "parentNode", "parentElement", "offsetParent", "getRootNode", "contentWindow", "contentDocument"].map(
    (name) => [name, "leads from a DOM node to the frame's document or window"] as const,
  ),
  ...["view", "target", "currentTarget", "srcElement", "relatedTarget", "nativeEvent", "composedPath"].map((name) => [name, "leads from an event to a DOM node or the frame's window"] as const),
  ...["postMessage", "addEventListener", "removeEventListener", "dispatchEvent"].map((name) => [name, "is the frame's message plumbing"] as const),
  ...["eval", "Function", "setTimeout", "setInterval", "requestAnimationFrame", "queueMicrotask", "fetch", "location"].map((name) => [name, "is a browser global"] as const),
  ...["innerHTML", "outerHTML", "insertAdjacentHTML", "srcdoc"].map((name) => [name, "runs markup as code"] as const),
  ...["useRef", "createRef", "useImperativeHandle", "findDOMNode"].map((name) => [name, "hands prototype code a DOM node"] as const),
]);

/** React exports that hand code a DOM node. */
const DOM_HOOKS = new Set(["useRef", "createRef", "useImperativeHandle", "findDOMNode"]);
/** JSX props that hand code a DOM node or run markup as code. */
const DOM_PROPS = new Set(["ref", "dangerouslySetInnerHTML", "srcDoc"]);
/** HTML elements that run code or load another document. */
const DOM_TAGS = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "base", "meta", "link", "portal"]);

export function memberReason(name: string): string | undefined {
  if (name.startsWith("__")) return "reaches engine or library internals";
  return MEMBERS.get(name);
}

type Scope = { readonly names: Set<string>; readonly parent: Scope | null };

const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);
/** TypeScript-only nodes, which never run. */
const TYPE_ONLY = new Set([
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSDeclareFunction",
  "TSDeclareMethod",
  "TSModuleDeclaration",
  "TSTypeAnnotation",
  "TSTypeParameterDeclaration",
  "TSTypeParameterInstantiation",
  "TSExpressionWithTypeArguments",
  "TSClassImplements",
  "TSInterfaceHeritage",
]);

function bound(scope: Scope | null, name: string): boolean {
  for (let current = scope; current; current = current.parent) if (current.names.has(name)) return true;
  return false;
}

/** The names a statement list declares in its own block: let, const, class, function, enum and import bindings. */
function lexicalNames(statements: readonly t.Node[]): string[] {
  const names: string[] = [];
  for (const raw of statements) {
    const statement = raw.type === "ExportNamedDeclaration" || raw.type === "ExportDefaultDeclaration" ? raw.declaration : raw;
    if (!statement) continue;
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) names.push(specifier.local.name);
    } else if (statement.type === "VariableDeclaration") {
      for (const declarator of statement.declarations) names.push(...boundNames(declarator.id));
    } else if ((statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration" || statement.type === "TSEnumDeclaration") && statement.id) {
      names.push(statement.id.name);
    }
  }
  return names;
}

/** `var` declarations anywhere in a function body, not in nested functions: they belong to the function's scope. */
function varNames(body: t.Node): string[] {
  const names: string[] = [];
  const walk = (node: t.Node) => {
    if (FUNCTIONS.has(node.type) || node.type === "ClassDeclaration" || node.type === "ClassExpression") return;
    if (node.type === "VariableDeclaration" && node.kind === "var") for (const declarator of node.declarations) names.push(...boundNames(declarator.id));
    for (const child of childNodes(node)) walk(child);
  };
  walk(body);
  return names;
}

/** The key a member expression or pattern property reads: its name, or null when computed at run time. */
function staticKey(key: t.Node, computed: boolean): string | null {
  if (!computed) {
    if (key.type === "Identifier") return key.name;
    if (key.type === "PrivateName") return `#${key.id.name}`;
  }
  if (key.type === "StringLiteral") return key.value;
  if (key.type === "NumericLiteral") return String(key.value);
  if (key.type === "TemplateLiteral" && key.expressions.length === 0) return key.quasis[0]?.value.cooked ?? null;
  return null;
}

export function scanAmbient(module: ModuleInfo): AmbientUse[] {
  const uses: AmbientUse[] = [];
  const path = module.path;
  const report = (node: t.Node, kind: AmbientUse["kind"], name: string, reason: string) => uses.push({ kind, name, reason, at: locationOf(path, node) });

  const member = (node: t.Node, name: string) => {
    const reason = memberReason(name);
    if (reason) report(node, "member", name, reason);
  };

  /** A reference to a name: fine when bound, an allowed built-in or left to another rule; otherwise a global use. */
  const reference = (node: t.Identifier, scope: Scope, parent: t.Node | null) => {
    const name = node.name;
    if (bound(scope, name) || LEFT_TO_IMPORTS.has(name)) return;
    if (!INTRINSICS.has(name)) {
      report(node, "global", name, memberReason(name) ?? "is not a plain language built-in");
      return;
    }
    const allowed = RESTRICTED[name];
    if (!allowed) return;
    const asObject = parent && (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && parent.object === node;
    const key = asObject ? staticKey(parent.property, parent.computed) : null;
    if (key === null || !allowed.includes(key)) {
      report(node, "global", name, `may only be called as ${allowed.map((item) => `${name}.${item}`).join(", ")}, since its other members read an object's values`);
    }
  };

  /** Walks a binding pattern: its names are bound by the caller; keys it reads, defaults and computed keys are checked. */
  const pattern = (node: t.Node, scope: Scope, assigning: boolean): void => {
    switch (node.type) {
      case "Identifier":
        if (assigning) reference(node, scope, null);
        return;
      case "ObjectPattern":
        for (const property of node.properties) {
          if (property.type === "RestElement") {
            pattern(property.argument, scope, assigning);
            continue;
          }
          const key = staticKey(property.key, property.computed);
          if (key === null) {
            report(property.key, "computed", "a computed key", "destructures a property whose key is computed at run time");
            expression(property.key, scope, property);
          } else member(property.key, key);
          pattern(property.value, scope, assigning);
        }
        return;
      case "ArrayPattern":
        for (const element of node.elements) if (element) pattern(element, scope, assigning);
        return;
      case "AssignmentPattern":
        pattern(node.left, scope, assigning);
        expression(node.right, scope, node);
        return;
      case "RestElement":
        pattern(node.argument, scope, assigning);
        return;
      case "MemberExpression":
      case "OptionalMemberExpression":
        report(node, "write", "a property", "assigns to a property");
        expression(node, scope, null);
        return;
      default:
        if (node.type === "TSParameterProperty") pattern(node.parameter, scope, assigning);
        else if (node.type === "TSAsExpression" || node.type === "TSNonNullExpression" || node.type === "TSSatisfiesExpression" || node.type === "TSTypeAssertion" || node.type === "ParenthesizedExpression") pattern(node.expression, scope, assigning);
    }
  };

  const fn = (node: t.Function, scope: Scope) => {
    const inner: Scope = { names: new Set(), parent: scope };
    if ((node.type === "FunctionExpression" || node.type === "FunctionDeclaration") && node.id) inner.names.add(node.id.name);
    for (const param of node.params) for (const name of boundNames(param.type === "TSParameterProperty" ? param.parameter : param)) inner.names.add(name);
    for (const name of varNames(node.body)) inner.names.add(name);
    if ((node.type === "ObjectMethod" || node.type === "ClassMethod") && node.computed) expression(node.key, scope, node);
    for (const param of node.params) pattern(param, inner, false);
    if (node.body.type === "BlockStatement") block(node.body.body, inner);
    else expression(node.body, inner, node);
  };

  const block = (statements: readonly t.Node[], scope: Scope) => {
    const inner: Scope = { names: new Set(lexicalNames(statements)), parent: scope };
    for (const statement of statements) expression(statement, inner, null);
  };

  /** Walks any node: statements and expressions alike, tracking scope. */
  const expression = (node: t.Node, scope: Scope, parent: t.Node | null): void => {
    if (TYPE_ONLY.has(node.type)) return;
    switch (node.type) {
      case "Identifier":
        reference(node, scope, parent);
        return;
      case "ImportDeclaration":
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          const imported = specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
          if (DOM_HOOKS.has(imported) && node.importKind !== "type" && specifier.importKind !== "type") report(specifier, "dom", imported, "hands prototype code a DOM node");
        }
        return;
      case "ExportNamedDeclaration":
        if (node.exportKind === "type") return;
        if (node.declaration) expression(node.declaration, scope, node);
        if (!node.source) for (const specifier of node.specifiers) if (specifier.type === "ExportSpecifier" && specifier.exportKind !== "type") expression(specifier.local, scope, specifier);
        return;
      case "ExportAllDeclaration":
        return;
      case "ExportDefaultDeclaration":
        if (node.declaration.type !== "TSDeclareFunction") expression(node.declaration, scope, node);
        return;
      case "MetaProperty":
        if (node.meta.name === "import") report(node, "meta", "import.meta", "reaches the module's own loading");
        return;
      case "MemberExpression":
      case "OptionalMemberExpression": {
        expression(node.object, scope, node);
        const key = staticKey(node.property, node.computed);
        if (key === null) {
          report(node.property, "computed", "a computed key", "reads a property whose key is computed at run time");
          expression(node.property, scope, node);
        } else member(node.property, key);
        return;
      }
      case "CallExpression":
      case "OptionalCallExpression":
      case "NewExpression": {
        callShape(node);
        expression(node.callee, scope, node);
        for (const argument of node.arguments) expression(argument, scope, node);
        return;
      }
      case "AssignmentExpression":
        if (node.left.type === "Identifier") reference(node.left, scope, node);
        else pattern(node.left, scope, true);
        expression(node.right, scope, node);
        return;
      case "UpdateExpression":
        if (node.argument.type === "Identifier") reference(node.argument, scope, node);
        else pattern(node.argument, scope, true);
        return;
      case "UnaryExpression":
        if (node.operator === "delete" && (node.argument.type === "MemberExpression" || node.argument.type === "OptionalMemberExpression")) report(node, "write", "a property", "deletes a property");
        expression(node.argument, scope, node);
        return;
      case "VariableDeclarator":
        pattern(node.id, scope, false);
        if (node.init) expression(node.init, scope, node);
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
      case "ObjectMethod":
      case "ClassMethod":
      case "ClassPrivateMethod":
        fn(node, scope);
        return;
      case "ClassDeclaration":
      case "ClassExpression": {
        const inner: Scope = { names: new Set(node.id ? [node.id.name] : []), parent: scope };
        if (node.superClass) expression(node.superClass, scope, node);
        for (const item of node.body.body) expression(item, inner, node.body);
        return;
      }
      case "ClassProperty":
      case "ClassPrivateProperty":
      case "ClassAccessorProperty":
        if (node.type !== "ClassPrivateProperty" && node.computed) expression(node.key, scope, node);
        if (node.value) expression(node.value, scope, node);
        return;
      case "ObjectProperty":
        if (node.computed) expression(node.key, scope, node);
        expression(node.value, scope, node);
        return;
      case "BlockStatement":
        block(node.body, scope);
        return;
      case "StaticBlock":
        block(node.body, scope);
        return;
      case "Program":
        block(node.body, scope);
        return;
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        const head = node.type === "ForStatement" ? node.init : node.left;
        const inner: Scope = { names: new Set(head?.type === "VariableDeclaration" ? head.declarations.flatMap((declarator) => boundNames(declarator.id)) : []), parent: scope };
        if (node.type === "ForStatement") {
          if (node.init) expression(node.init, inner, node);
          if (node.test) expression(node.test, inner, node);
          if (node.update) expression(node.update, inner, node);
        } else {
          if (node.left.type === "VariableDeclaration") expression(node.left, inner, node);
          else pattern(node.left, inner, true);
          expression(node.right, inner, node);
        }
        expression(node.body, inner, node);
        return;
      }
      case "CatchClause": {
        const inner: Scope = { names: new Set(node.param ? boundNames(node.param) : []), parent: scope };
        if (node.param) pattern(node.param, inner, false);
        expression(node.body, inner, node);
        return;
      }
      case "SwitchStatement": {
        expression(node.discriminant, scope, node);
        const inner: Scope = { names: new Set(lexicalNames(node.cases.flatMap((item) => item.consequent))), parent: scope };
        for (const item of node.cases) {
          if (item.test) expression(item.test, inner, item);
          for (const statement of item.consequent) expression(statement, inner, item);
        }
        return;
      }
      case "LabeledStatement":
        expression(node.body, scope, node);
        return;
      case "BreakStatement":
      case "ContinueStatement":
        return;
      case "TSEnumDeclaration":
        for (const item of node.members) if (item.initializer) expression(item.initializer, scope, item);
        return;
      case "JSXElement":
        jsx(node, scope);
        return;
      case "JSXAttribute":
        if (node.value) expression(node.value, scope, node);
        return;
      default:
        for (const child of childNodes(node)) expression(child, scope, node);
    }
  };

  /** `Object.assign` writes into its first argument, and `JSON.stringify`'s replacer sees every value. */
  const callShape = (node: t.CallExpression | t.OptionalCallExpression | t.NewExpression) => {
    const callee = node.callee;
    if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier" || callee.computed || callee.property.type !== "Identifier") return;
    const target = `${callee.object.name}.${callee.property.name}`;
    const first = node.arguments[0];
    const second = node.arguments[1];
    if (target === "Object.assign" && first?.type !== "ObjectExpression") report(node, "write", target, "writes into an object other than a new literal; pass {} first");
    if (target === "JSON.stringify" && second && second.type !== "NullLiteral") report(node, "global", target, "calls a replacer with every value it serialises; pass null as the second argument");
  };

  const jsx = (node: t.JSXElement, scope: Scope) => {
    const name = node.openingElement.name;
    if (name.type === "JSXIdentifier") {
      const first = name.name[0] ?? "";
      if (first === first.toLowerCase() && first !== first.toUpperCase() && !name.name.includes(".")) {
        if (DOM_TAGS.has(name.name)) report(name, "dom", `<${name.name}>`, "runs code or loads another document");
      } else if (!bound(scope, name.name) && !INTRINSICS.has(name.name)) {
        report(name, "global", name.name, "is not a plain language built-in");
      }
    } else if (name.type === "JSXMemberExpression") {
      let root: t.JSXMemberExpression | t.JSXIdentifier = name;
      while (root.type === "JSXMemberExpression") {
        member(root.property, root.property.name);
        root = root.object;
      }
      if (!bound(scope, root.name)) report(root, "global", root.name, memberReason(root.name) ?? "is not a plain language built-in");
    }
    for (const attribute of node.openingElement.attributes) {
      if (attribute.type === "JSXSpreadAttribute") {
        expression(attribute.argument, scope, attribute);
        continue;
      }
      const prop = attribute.name.type === "JSXIdentifier" ? attribute.name.name : `${attribute.name.namespace.name}:${attribute.name.name.name}`;
      if (DOM_PROPS.has(prop)) report(attribute, "dom", prop, prop === "ref" ? "hands prototype code a DOM node" : "runs markup as code");
      if (attribute.value) expression(attribute.value, scope, attribute);
    }
    for (const child of node.children) expression(child, scope, node);
  };

  expression(module.program, { names: new Set(), parent: null }, null);
  return uses;
}
