/**
 * Builds the local package source: one ES module per package entry a frame
 * imports, from this repository's node_modules, into public/vendor/. The
 * frame's import map points each bare specifier at one of these files, so
 * React is one instance shared by the library, the page kit and the
 * prototype. CommonJS packages (React, React DOM) get their named exports
 * listed from the module itself, as a CDN such as esm.sh does.
 *
 * The component libraries it serves are the versions apps/web/package.json
 * lists under `designHarness.libraries` (`vendor-libraries.mjs` reads them),
 * each with the stylesheets (paths inside the package) a project's config
 * may name. A package can be served at several versions: one is installed
 * under its own name, each other under an npm alias. Every version is built
 * from where it is installed and filed under the package's real name and
 * exact version, so a frame imports `@tounsoo/todae` and gets the version
 * its project names; any other library loads from the esm.sh source. Each
 * library version must accept the one React served, by its peer range.
 *
 * Output: public/vendor/manifest.json, which names, for each package and
 * version, the file for each module specifier and the package files
 * (stylesheets) copied as they are.
 */
import { initSync as initCjsLexer, parse as parseCjs } from "cjs-module-lexer";
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fileInManifest, satisfies, unservedDescriptions, vendorFileName as fileName, vendoredLibraries } from "./vendor-libraries.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const out = join(app, "public", "vendor");
const require = createRequire(join(app, "package.json"));

/** The component library versions to serve, where each is installed, and the stylesheets of each, from the app's package.json. */
const LIBRARIES = vendoredLibraries(JSON.parse(readFileSync(join(app, "package.json"), "utf8")));
const REACT_EXTERNALS = ["react", "react/jsx-runtime", "react-dom"];

/**
 * Each module a frame imports: the specifier the frame imports it by, the
 * package and version it is filed under, where it is installed, its file
 * name, and which specifiers stay external.
 */
const MODULES = [
  { specifier: "react", file: "react.js", external: [] },
  { specifier: "react/jsx-runtime", file: "react-jsx-runtime.js", external: ["react"] },
  { specifier: "react-dom", file: "react-dom.js", external: ["react"] },
  { specifier: "react-dom/client", file: "react-dom-client.js", external: ["react", "react-dom"] },
  ...LIBRARIES.map((library) => ({ specifier: library.package, install: library.install, version: library.version, file: null, external: REACT_EXTERNALS })),
  // A spec prototype's frames draw specs with json-render's React renderer, which bundles its core and zod.
  { specifier: "@json-render/react", file: "json-render-react.js", external: ["react", "react/jsx-runtime", "react-dom"] },
];

function packageOf(specifier) {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

/**
 * The package's own package.json, found from where its main entry resolves
 * (its exports may not list package.json). `name` is the name it is
 * installed under: an alias's folder is named for the alias, its
 * package.json for the package.
 */
function packageJson(name) {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)));
  const folder = join("node_modules", name);
  while (!existsSync(join(dir, "package.json")) || !(dir.endsWith(folder) || JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === name)) {
    const up = dirname(dir);
    if (up === dir) throw new Error(`vendor: cannot find the package.json of ${name}`);
    dir = up;
  }
  return { dir, json: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) };
}

function versionOf(name) {
  return packageJson(name).json.version;
}

/**
 * A CommonJS module's export names, read from its source and the modules it
 * re-exports, without running any of it. A library is the code of whoever
 * asked for it (see scripts/library-request.mjs), so its code never runs in Node.
 */
function cjsExportNames(file, seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);
  const { exports, reexports } = parseCjs(readFileSync(file, "utf8"));
  const from = createRequire(file);
  return [...exports, ...reexports.flatMap((specifier) => cjsExportNames(from.resolve(specifier), seen))];
}

/**
 * An entry that re-exports a CommonJS module's keys as ES named exports. A
 * library's names are read from its source; React's, which this repository
 * pins, from the module itself, so its production build's names alone are exported.
 */
function cjsEntry(specifier, { library }) {
  process.env.NODE_ENV = "production";
  const keys = library ? [...new Set(cjsExportNames(require.resolve(specifier)))] : Object.keys(require(specifier));
  const names = keys.filter((name) => /^[A-Za-z_$][\w$]*$/.test(name) && name !== "default");
  // A library whose exports are made at run time has none its source shows; it is refused rather than served without them.
  if (library && names.length === 0) throw new Error(`vendor: ${specifier} is CommonJS and its source names no exports that can be read without running it; serve it from esm.sh instead`);
  return `import mod from ${JSON.stringify(specifier)};\nexport default mod;\nexport const { ${names.join(", ")} } = mod;\n`;
}

/** CommonJS unless the package says it is a module, by its type or by an `import` condition in its exports (json-render ships both). */
function isCommonJs(specifier) {
  const json = packageJson(packageOf(specifier)).json;
  const root = typeof json.exports === "object" && json.exports !== null ? (json.exports["."] ?? json.exports) : null;
  return json.type !== "module" && !(typeof root === "object" && root !== null && "import" in root);
}

/**
 * Keeps exactly these specifiers external (esbuild's own `external` would
 * also take their subpaths, such as react/jsx-runtime with react). A
 * CommonJS `require` of one becomes an import of its ES module namespace, so
 * React DOM's `require("react")` reads the one React the import map names.
 */
function externals(specifiers) {
  const exact = new Set(specifiers);
  return {
    name: "exact-externals",
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (!exact.has(args.path) || args.namespace === "esm-namespace") return args.namespace === "esm-namespace" ? { path: args.path, external: true } : undefined;
        return args.kind === "require-call" ? { path: args.path, namespace: "esm-namespace" } : { path: args.path, external: true };
      });
      builder.onLoad({ filter: /.*/, namespace: "esm-namespace" }, (args) => ({ contents: `export * from ${JSON.stringify(args.path)};`, loader: "js" }));
    },
  };
}

initCjsLexer();
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const manifest = { packages: {} };
const react = versionOf("react");
for (const library of LIBRARIES) {
  const { json } = packageJson(library.install);
  if (json.name !== library.package || json.version !== library.version) throw new Error(`vendor: ${library.install} holds ${json.name} ${json.version}, not ${library.package} ${library.version}; run npm ci`);
  for (const peer of ["react", "react-dom"]) {
    const range = json.peerDependencies?.[peer];
    if (range && !satisfies(react, range)) throw new Error(`vendor: ${library.package} ${library.version} needs ${peer} ${range}, but frames get ${react}; it cannot share the one React a frame loads`);
  }
}
for (const module of MODULES) {
  const name = packageOf(module.specifier);
  // A library version is built from where it is installed (its own name, or its alias), and filed under its real name.
  const install = module.install ?? name;
  const version = module.version ?? versionOf(name);
  const file = module.file ?? fileName(name, version, ".js");
  const from = install + module.specifier.slice(name.length);
  const entry = isCommonJs(from) ? cjsEntry(from, { library: module.install !== undefined }) : `export * from ${JSON.stringify(from)};\n`;
  await build({
    stdin: { contents: entry, resolveDir: app, loader: "js" },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    plugins: [externals(module.external)],
    define: { "process.env.NODE_ENV": '"production"' },
    outfile: join(out, file),
    logLevel: "error",
  });
  fileInManifest(manifest, { package: name, version, kind: "modules", key: module.specifier, file });
}
for (const library of LIBRARIES) {
  const { dir } = packageJson(library.install);
  for (const path of library.stylesheets) {
    const file = fileName(library.package, library.version, `-${path.replace(/[^\w.-]/g, "-")}`);
    copyFileSync(join(dir, path), join(out, file));
    fileInManifest(manifest, { package: library.package, version: library.version, kind: "files", key: path, file });
  }
}
// Every library description core ships is one the app can be asked to render (the registry, the stored-project migration), so each must be served.
const described = join(app, "..", "..", "packages", "core", "libraries");
const descriptions = readdirSync(described).filter((file) => file.endsWith(".json")).sort().map((file) => {
  const { package: name, version } = JSON.parse(readFileSync(join(described, file), "utf8"));
  return { package: name, version };
});
const unserved = unservedDescriptions(manifest, descriptions);
if (unserved.length > 0) throw new Error(`vendor: packages/core/libraries describes ${unserved.join(", ")}, which this build does not serve: add each to designHarness.libraries in apps/web/package.json, with its dependency (an npm alias for a second version)`);
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`vendor: ${Object.entries(manifest.packages).flatMap(([name, entry]) => Object.keys(entry.versions).map((version) => `${name}@${version}`)).join(", ")} -> public/vendor`);
