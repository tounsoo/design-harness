// Describes a React component library's parts for spec prototypes, from the
// library's own TypeScript declarations: for each part, the props it
// declares itself, which of them are required, which a spec may bind to
// state (a prop with an on<Prop>Change callback), whether it takes children,
// and whether it can be pressed.
//
//   node packages/core/scripts/describe-library.mjs <package> <version> [--out <file>] [--only <A,B>]
//
// `--only` keeps the parts of the named exports alone (`Button` keeps Button
// and Button.Group), for a project config that carries only what it
// inventories: a large library's whole description can run to megabytes.
//
// It reads the exact version: the copy installed in this repository's
// node_modules when that is the version asked for, and otherwise a copy it
// installs into node_modules/.cache/design-harness/libraries/, with npm's
// --before set to the moment that version was published, so its dependencies
// (and the React types it builds on) resolve as they did then, every time.
// The same package and version give byte-identical output.
//
// What is a part:
// - a plain component, an export a JSX tag can name (`Button`);
// - a compound part, a capitalised member of an export that is one
//   (`Button.Root`, `Accordion.Item`), whether the export is an object, a
//   component with statics, or a namespace (`export * as Callout`).
// A context (it has a Consumer) is not a part.
//
// What a prop is, read from its declared type, undefined and null aside:
// - boolean: true and false;
// - enum: a union of string literals, sorted. The open-string idiom
//   `"a" | "b" | (string & {})` reads as its literals, and a union of
//   literals with object forms (a responsive value such as
//   `"1" | { sm: "1" }`) as its literals too: a spec writes the plain value,
//   so it may use only the named ones;
// - number, string: the plain JSON scalar;
// - unknown: anything else the library declares (an object, JSX, a union of
//   unlike types, `any`). The type cannot be read as a JSON value, so a spec
//   cannot set the prop: the catalog leaves it out and a spec that sets it is
//   refused. A required one goes in `needs`, and the part is left out.
// Callbacks are events, not props; `children` is the part's content; props
// inherited from React's DOM attributes are left out, except `id` and
// `aria-label`; so are refs, `key`, `className`, `style`, `render` and
// `dangerouslySetInnerHTML`.
//
// Style props: `style`, `className`, `sx` and `css` by name, and every prop a
// part takes from a library's own set of style props (an interface or type
// named like MantineStyleProps or SystemProps), are listed in `styleProps`
// with the sets they came from, so the role drafter can propose excluding
// them: they style a part directly, around the library's variants and tokens.
//
// A spec cannot hold JSX, so a part whose children must be raw HTML elements
// needs a word the types do not say. OVERRIDES holds those, and nothing else.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Parts whose children the types cannot describe: Field.Select's are <option> elements, so a spec gives them as data. */
export const OVERRIDES = {
  "@tounsoo/todae": {
    "Field.Select": { content: "options", props: { options: { type: "options", required: true } } },
  },
};

const SKIP = new Set(["children", "ref", "className", "style", "key", "render", "dangerouslySetInnerHTML"]);
/** Props that style an element directly, by name, in any library: a spec styling a part this way bypasses its variants and tokens. */
const STYLE_PROP_NAMES = new Set(["className", "css", "style", "sx"]);
/** A props type that is a library's set of style props (Mantine's MantineStyleProps, a system's SystemProps). */
const STYLE_PROP_SET = /(?:Style|System)Props$/;
const INHERITED = new Set(["id", "aria-label"]);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The entry a TypeScript consumer of the package reads: its `types` under `exports["."]` (any condition), or `types`/`typings`. */
function typesEntry(pkgDir, pkg) {
  const find = (node) => {
    if (typeof node === "string") return node.endsWith(".d.ts") || node.endsWith(".d.mts") ? node : null;
    if (typeof node !== "object" || node === null) return null;
    if (typeof node.types === "string") return node.types;
    for (const key of ["import", "default", "require"]) {
      const found = node[key] === undefined ? null : find(node[key]);
      if (found) return found;
    }
    return null;
  };
  const root = typeof pkg.exports === "object" && pkg.exports !== null ? (pkg.exports["."] ?? pkg.exports) : null;
  const entry = (root && find(root)) ?? pkg.types ?? pkg.typings;
  if (!entry) throw new Error(`${pkg.name} ${pkg.version} declares no TypeScript types, so its parts cannot be read`);
  return join(pkgDir, entry);
}

/**
 * The description of the package installed at `pkgDir`: `{ package, version, parts }`, parts and props in
 * code-unit order. Pure over the files it reads.
 */
export function describeLibrary(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const entry = typesEntry(pkgDir, pkg);
  // A generic component (a polymorphic `<C = "button">(props: Props<C>)`) has no props type until a tag
  // instantiates it, so the second pass reads such parts from a tag written for each, as TypeScript would check it.
  const first = readParts(pkgDir, pkg, entry, null);
  const read = first.generic.length === 0 ? first : readParts(pkgDir, pkg, entry, first.generic);
  return { package: pkg.name, version: pkg.version, parts: read.parts, ...(read.styleProps ? { styleProps: read.styleProps } : {}) };
}

const OPTIONS = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX, skipLibCheck: true, strict: true, noEmit: true, types: [] };

/** A program over the package's types entry, and, for generic parts, a file in the package's folder with one tag per part. */
function programFor(pkgDir, pkg, entry, generic) {
  if (!generic) return { program: ts.createProgram([entry], OPTIONS), tags: null };
  const virtual = join(pkgDir, "__describe_library__.tsx");
  const specifier = `./${entry.slice(pkgDir.length + 1).replace(/\.d\.([mc]?)ts$/, ".$1js")}`;
  const text = [`import * as L from ${JSON.stringify(specifier)};`, ...generic.map((part, index) => `export const t${index} = <L.${part} />;`)].join("\n");
  const host = ts.createCompilerHost(OPTIONS);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (file, language, ...rest) => (file === virtual ? ts.createSourceFile(file, text, language, true, ts.ScriptKind.TSX) : getSourceFile.call(host, file, language, ...rest));
  host.fileExists = (file) => file === virtual || fileExists.call(host, file);
  host.readFile = (file) => (file === virtual ? text : readFile.call(host, file));
  const program = ts.createProgram([entry, virtual], OPTIONS, host);
  const tags = new Map();
  const source = program.getSourceFile(virtual);
  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node)) tags.set(node.tagName.getText(source).slice(2), node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { program, tags };
}

function readParts(pkgDir, pkg, entry, generic) {
  const name = pkg.name;
  const { program, tags } = programFor(pkgDir, pkg, entry, generic);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (!source) throw new Error(`cannot read ${entry}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`${entry} is not a module`);
  const libraryRoot = `${pkgDir}/`;
  /** Style props seen on any part, and where each set was declared. */
  const styleNames = new Set();
  const styleSets = new Set();
  /** The name of the interface or type alias a property is declared in, when it has one. */
  const ownerOf = (symbol) => {
    for (const declaration of symbol.declarations ?? []) {
      let node = declaration.parent;
      while (node && !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node) && !ts.isSourceFile(node)) node = node.parent;
      if (node && (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))) return node.name.text;
    }
    return null;
  };
  const fromLibrary = (symbol) => (symbol.declarations ?? []).some((declaration) => declaration.getSourceFile().fileName.startsWith(libraryRoot));
  const resolveAlias = (symbol) => (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);

  const withoutNullish = (type) => (type.isUnion() ? type.types : [type]).filter((part) => !(part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)));
  /** `string & {}`: any string, kept apart so editors still offer the literals. */
  const isOpenString = (part) => part.isIntersection() && part.types.some((member) => member.flags & ts.TypeFlags.String) && part.types.every((member) => member.flags & ts.TypeFlags.String || (member.flags & ts.TypeFlags.Object && checker.getPropertiesOfType(member).length === 0));
  const isFunction = (type) => (type.isUnion() ? type.types : [type]).some((part) => part.getCallSignatures().length > 0);

  function schemaOf(type) {
    const kept = withoutNullish(type);
    if (kept.length === 0) return { type: "unknown" };
    if (kept.some((part) => part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter))) return { type: "unknown" };
    if (kept.every((part) => part.flags & ts.TypeFlags.BooleanLike)) return { type: "boolean" };
    if (kept.every((part) => part.flags & ts.TypeFlags.NumberLike)) return { type: "number" };
    // Any string goes, whatever else the union takes (text for a ReactNode, a length for a CSS value): a spec writes the string.
    if (kept.some((part) => part.flags & ts.TypeFlags.String && !part.isStringLiteral())) return { type: "string" };
    const literals = kept.filter((part) => part.isStringLiteral());
    // Every other member is the open-string idiom or an object form (a responsive value): the literals are what a spec can write.
    const rest = kept.filter((part) => !part.isStringLiteral());
    if (literals.length > 0 && rest.every((part) => isOpenString(part) || (part.flags & ts.TypeFlags.Object && !isFunction(part)))) {
      return { type: "enum", values: [...new Set(literals.map((part) => part.value))].sort(compare) };
    }
    return { type: "unknown" };
  }

  const signaturesOf = (type) => (type.getCallSignatures().length > 0 ? type.getCallSignatures() : type.getConstructSignatures());

  /** The props type a JSX tag of this component checks its attributes against: the last signature's first parameter, or, for a generic part, the signature its tag resolves to. */
  function propsOf(part, partType, at) {
    const tag = tags?.get(part);
    const signatures = signaturesOf(partType);
    const signature = tag ? checker.getResolvedSignature(tag) : signatures[signatures.length - 1];
    const where = tag ?? at;
    const param = signature?.getParameters()[0];
    return param ? { type: checker.getTypeOfSymbolAtLocation(param, where), at: where } : null;
  }

  function describePart(part, partType, declaration) {
    const found = propsOf(part, partType, declaration);
    if (!found) return { props: {}, content: "none" };
    const { type: propsType, at } = found;
    const props = {};
    const types = new Map();
    /** Each on<Name> callback, by name, with the type of the value it reports (its first parameter). */
    const callbacks = new Map();
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
      if (STYLE_PROP_NAMES.has(key)) styleNames.add(key);
      if (SKIP.has(key)) continue;
      if (!fromLibrary(property) && !INHERITED.has(key)) continue;
      if (isFunction(type)) {
        if (/^on[A-Z]/.test(key)) {
          const signature = withoutNullish(type).flatMap((part) => part.getCallSignatures())[0];
          const first = signature?.getParameters()[0];
          callbacks.set(key, first ? checker.getTypeOfSymbolAtLocation(first, at) : null);
        }
        // A required function a spec cannot give: the part cannot be rendered from a spec.
        if (required) needs.push(key);
        continue;
      }
      const owner = fromLibrary(property) ? ownerOf(property) : null;
      if (owner && STYLE_PROP_SET.test(owner)) {
        styleNames.add(key);
        styleSets.add(owner);
      }
      const schema = schemaOf(type);
      if (schema.type === "unknown" && required) needs.push(key);
      props[key] = { ...schema, required };
      types.set(key, type);
    }
    for (const [key, schema] of Object.entries(props)) {
      // Bindable when on<Prop>Change reports a value the prop takes back: react-number-format's onValueChange reports an object, not the value.
      const callback = `on${key[0].toUpperCase()}${key.slice(1)}Change`;
      const reported = callbacks.get(callback);
      if (reported && schema.type !== "unknown" && checker.isTypeAssignableTo(reported, types.get(key))) props[key] = { ...schema, bind: callback };
    }
    const sorted = Object.fromEntries(Object.entries(props).sort(([a], [b]) => compare(a, b)));
    return { props: sorted, content, ...(pressable ? { events: ["press"] } : {}), ...(needs.length > 0 ? { needs: [...new Set(needs)].sort(compare) } : {}) };
  }

  const isComponent = (type) => {
    if (signaturesOf(type).length === 0) return false;
    // A context is callable in React 19's types (it is its own Provider), but a page never draws one.
    return !checker.getPropertiesOfType(type).some((property) => property.getName() === "Consumer");
  };

  const parts = {};
  const genericParts = [];
  const add = (part, type, declaration) => {
    if (signaturesOf(type).some((signature) => (signature.getTypeParameters() ?? []).length > 0)) genericParts.push(part);
    const described = describePart(part, type, declaration);
    const override = OVERRIDES[name]?.[part];
    parts[part] = override ? { ...described, ...override, props: { ...described.props, ...override.props } } : described;
  };
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const exportName = exported.getName();
    if (!/^[A-Z]/.test(exportName)) continue;
    const symbol = resolveAlias(exported);
    if (symbol.flags & ts.SymbolFlags.ValueModule && !(symbol.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Function | ts.SymbolFlags.Class))) {
      // `export * as Callout from "./callout"`: its exports are the parts.
      for (const member of checker.getExportsOfModule(symbol)) {
        const memberName = member.getName();
        const resolved = resolveAlias(member);
        const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0];
        if (!/^[A-Z]/.test(memberName) || !(resolved.flags & ts.SymbolFlags.Value) || !declaration) continue;
        const type = checker.getTypeOfSymbolAtLocation(resolved, declaration);
        if (isComponent(type)) add(`${exportName}.${memberName}`, type, declaration);
      }
      continue;
    }
    if (!(symbol.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Function | ts.SymbolFlags.Class))) continue;
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) continue;
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    if (checker.getPropertiesOfType(type).some((property) => property.getName() === "Consumer")) continue;
    if (isComponent(type)) add(exportName, type, declaration);
    for (const member of checker.getPropertiesOfType(type)) {
      if (!/^[A-Z]/.test(member.getName())) continue;
      const memberType = checker.getTypeOfSymbolAtLocation(member, declaration);
      if (isComponent(memberType)) add(`${exportName}.${member.getName()}`, memberType, declaration);
    }
  }
  const sorted = Object.fromEntries(Object.entries(parts).sort(([a], [b]) => compare(a, b)));
  const styleProps = styleNames.size > 0 ? { styleProps: { names: [...styleNames].sort(compare), sets: [...styleSets].sort(compare) } } : {};
  return { parts: sorted, generic: [...new Set(genericParts)].sort(compare), ...styleProps };
}

/** The description with only the parts of these exports (`Button` keeps `Button` and `Button.Group`); its style props are kept whole. */
export function onlyParts(description, exports) {
  const keep = new Set(exports);
  return { ...description, parts: Object.fromEntries(Object.entries(description.parts).filter(([part]) => keep.has(part.split(".")[0]))) };
}

/** The description as the file a project config carries: JSON, one space per level, a final newline. */
export function descriptionText(description) {
  return `${JSON.stringify(description, null, 1)}\n`;
}

/** The folder of `name` in this repository's node_modules, when it is installed there at exactly `version`. */
export function installedDir(name, version, root = REPO) {
  for (const base of [root, ...["apps", "packages"].flatMap((folder) => listDirs(join(root, folder)))]) {
    const dir = join(base, "node_modules", ...name.split("/"));
    const file = join(dir, "package.json");
    if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).version === version) return dir;
  }
  return null;
}

function listDirs(dir) {
  return existsSync(dir) ? readdirSync(dir).sort(compare).map((entry) => join(dir, entry)) : [];
}

/**
 * Installs `name@version` alone, with its dependencies and React's types, into a cache folder and returns the
 * package's folder there. npm resolves every range as of the version's publish time (`--before`), so the same
 * version installs the same tree on every run. Install scripts never run.
 */
export function installLibrary(name, version, cache = join(REPO, "node_modules", ".cache", "design-harness", "libraries")) {
  const folder = join(cache, `${name.replace("/", "+")}@${version}`);
  const dir = join(folder, "node_modules", ...name.split("/"));
  if (existsSync(join(dir, "package.json")) && JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version === version) return dir;
  const meta = JSON.parse(execFileSync("npm", ["view", `${name}@${version}`, "time", "peerDependencies", "--json"], { encoding: "utf8" }));
  const published = meta.time?.[version];
  if (!published) throw new Error(`npm has no ${name}@${version}`);
  // One second after publication, so the version itself is in range.
  const before = new Date(Date.parse(published) + 1000).toISOString();
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "package.json"), `${JSON.stringify({ private: true, name: "describe-library-cache" }, null, 2)}\n`);
  const typesRange = meta.peerDependencies?.["@types/react"] && meta.peerDependencies["@types/react"] !== "*" ? meta.peerDependencies["@types/react"] : "*";
  execFileSync("npm", ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps", "--install-strategy=hoisted", `--before=${before}`, `${name}@${version}`, `@types/react@${typesRange}`], { cwd: folder, stdio: ["ignore", "ignore", "inherit"] });
  return dir;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (flag) => {
    const at = args.indexOf(flag);
    return at >= 0 ? { at, value: args[at + 1] } : null;
  };
  const outOption = option("--out");
  const onlyOption = option("--only");
  const out = outOption?.value;
  const taken = new Set([outOption?.at, outOption && outOption.at + 1, onlyOption?.at, onlyOption && onlyOption.at + 1]);
  const [name, version] = args.filter((_, index) => !taken.has(index));
  if (!name || !version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    process.stderr.write("usage: node packages/core/scripts/describe-library.mjs <package> <exact version> [--out <file>]\n");
    process.exit(2);
  }
  const dir = installedDir(name, version) ?? installLibrary(name, version);
  const described = describeLibrary(dir);
  const text = descriptionText(onlyOption?.value ? onlyParts(described, onlyOption.value.split(",")) : described);
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
