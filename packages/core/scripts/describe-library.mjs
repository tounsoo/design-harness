// Describes a component library's parts for spec prototypes, from the
// library's own TypeScript declarations in node_modules: for each part (such
// as Button.Root), the props it declares itself whose values JSON can hold
// (string, number, boolean, a union of string literals), which of them are
// required, which a spec may bind to state (a prop with an on<Prop>Change
// callback), whether it takes children, and whether it can be pressed.
// Props it inherits from React's DOM attributes are left out, except `id` and
// `aria-label`; so are callbacks, refs, `className`, `style` and render props.
//
//   node packages/core/scripts/describe-library.mjs [package] > packages/core/libraries/<name>-<version>.json
//
// A spec cannot hold JSX, so a part whose children must be raw HTML elements
// needs a word the types do not say. OVERRIDES holds those, and nothing else.
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const name = process.argv[2] ?? "@tounsoo/todae";
/** The package's folder, found from where its entry resolves: its exports need not list package.json. */
function packageDir(packageName) {
  let dir = dirname(fileURLToPath(import.meta.resolve(packageName)));
  while (!existsSync(join(dir, "package.json")) || JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name !== packageName) dir = dirname(dir);
  return dir;
}
const pkgDir = packageDir(name);
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const entry = join(pkgDir, typeof pkg.exports?.["."] === "object" ? pkg.exports["."].types : pkg.types);

/** Parts whose children the types cannot describe: Field.Select's are <option> elements, so a spec gives them as data. */
const OVERRIDES = {
  "@tounsoo/todae": {
    "Field.Select": { content: "options", props: { options: { type: "options", required: true } } },
  },
};

const program = ts.createProgram([entry], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX, skipLibCheck: true, strict: true });
const checker = program.getTypeChecker();
const source = program.getSourceFile(entry);
const moduleSymbol = checker.getSymbolAtLocation(source);
const fromLibrary = (symbol) => (symbol.declarations ?? []).some((declaration) => declaration.getSourceFile().fileName.startsWith(pkgDir));
const SKIP = new Set(["children", "ref", "className", "style", "key", "render", "dangerouslySetInnerHTML"]);
const INHERITED = new Set(["id", "aria-label"]);

function scalar(type) {
  const parts = type.isUnion() ? type.types : [type];
  const kept = parts.filter((part) => !(part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
  if (kept.length === 0) return null;
  if (kept.every((part) => part.flags & ts.TypeFlags.BooleanLike)) return { type: "boolean" };
  if (kept.every((part) => part.isStringLiteral())) return { type: "enum", values: kept.map((part) => part.value).sort() };
  if (kept.every((part) => part.flags & ts.TypeFlags.NumberLike)) return { type: "number" };
  if (kept.length === 1 && kept[0].flags & ts.TypeFlags.String) return { type: "string" };
  return null;
}

function isFunction(type) {
  const parts = type.isUnion() ? type.types : [type];
  return parts.some((part) => part.getCallSignatures().length > 0);
}

function describePart(partType, at) {
  const signatures = partType.getCallSignatures();
  const signature = signatures[signatures.length - 1];
  const param = signature?.getParameters()[0];
  if (!param) return { props: {}, content: "none" };
  const propsType = checker.getTypeOfSymbolAtLocation(param, at);
  const props = {};
  const callbacks = new Set();
  const needs = [];
  let content = "none";
  let pressable = false;
  for (const property of checker.getPropertiesOfType(propsType)) {
    const key = property.getName();
    const type = checker.getTypeOfSymbolAtLocation(property, at);
    const required = (property.flags & ts.SymbolFlags.Optional) === 0;
    if (key === "children") {
      content = isFunction(type) ? "none" : "children";
      if (required && content === "none") needs.push(key);
      continue;
    }
    if (key === "onClick") pressable = true;
    if (SKIP.has(key)) continue;
    if (!fromLibrary(property) && !INHERITED.has(key)) continue;
    const schema = isFunction(type) ? null : scalar(type);
    if (isFunction(type) && /^on[A-Z]/.test(key)) callbacks.add(key);
    if (!schema) {
      // A required prop a spec cannot give (an object, a function): the part cannot be rendered from a spec.
      if (required) needs.push(key);
      continue;
    }
    props[key] = { ...schema, required };
  }
  for (const [key, schema] of Object.entries(props)) {
    const callback = `on${key[0].toUpperCase()}${key.slice(1)}Change`;
    if (callbacks.has(callback)) props[key] = { ...schema, bind: callback };
  }
  return { props: Object.fromEntries(Object.entries(props).sort(([a], [b]) => (a < b ? -1 : 1))), content, ...(pressable ? { events: ["press"] } : {}), ...(needs.length > 0 ? { needs: needs.sort() } : {}) };
}

const parts = {};
for (const exported of checker.getExportsOfModule(moduleSymbol)) {
  const exportName = exported.getName();
  if (!/^[A-Z]/.test(exportName)) continue;
  const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  if (!(symbol.flags & ts.SymbolFlags.Variable)) continue;
  const declaration = symbol.valueDeclaration;
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
  for (const member of checker.getPropertiesOfType(type)) {
    const memberType = checker.getTypeOfSymbolAtLocation(member, declaration);
    if (memberType.getCallSignatures().length === 0 || !/^[A-Z]/.test(member.getName())) continue;
    const part = `${exportName}.${member.getName()}`;
    const described = describePart(memberType, declaration);
    const override = OVERRIDES[name]?.[part];
    parts[part] = override ? { ...described, ...override, props: { ...described.props, ...override.props } } : described;
  }
}
const sorted = Object.fromEntries(Object.entries(parts).sort(([a], [b]) => (a < b ? -1 : 1)));
process.stdout.write(`${JSON.stringify({ package: name, version: pkg.version, parts: sorted }, null, 1)}\n`);
