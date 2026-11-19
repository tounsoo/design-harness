/**
 * Builds the local package source: one ES module per package entry a frame
 * imports, from this repository's node_modules, into public/vendor/. The
 * frame's import map points each bare specifier at one of these files, so
 * React is one instance shared by the library, the page kit and the
 * prototype. CommonJS packages (React, React DOM) get their named exports
 * listed from the module itself, as a CDN such as esm.sh does.
 *
 * The component libraries it serves are the ones apps/web/package.json lists
 * under `designHarness.libraries`, each with the stylesheets (paths inside the
 * package) a project's config may name. Each is served by name and the exact
 * version installed, so the app can serve any project whose library is one of
 * them; any other library loads from the esm.sh source.
 *
 * Output: public/vendor/manifest.json, which names, for each package and
 * version, the file for each module specifier and the package files
 * (stylesheets) copied as they are.
 */
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const out = join(app, "public", "vendor");
const require = createRequire(join(app, "package.json"));

/** The component libraries to serve, and the stylesheets of each, from the app's package.json. */
const LIBRARIES = Object.entries(JSON.parse(readFileSync(join(app, "package.json"), "utf8")).designHarness?.libraries ?? {});
const REACT_EXTERNALS = ["react", "react/jsx-runtime", "react-dom"];
/** A file name for a package's module or file: its name and version, safe in a URL path. */
const fileName = (name, version, suffix) => `${name.replace(/^@/, "").replace(/[^\w.-]/g, "-")}@${version}${suffix}`;

/** Each module a frame imports: specifier, file name, and which specifiers stay external. */
const MODULES = [
  { specifier: "react", file: "react.js", external: [] },
  { specifier: "react/jsx-runtime", file: "react-jsx-runtime.js", external: ["react"] },
  { specifier: "react-dom", file: "react-dom.js", external: ["react"] },
  { specifier: "react-dom/client", file: "react-dom-client.js", external: ["react", "react-dom"] },
  ...LIBRARIES.map(([name]) => ({ specifier: name, file: null, external: REACT_EXTERNALS })),
  // A spec prototype's frames draw specs with json-render's React renderer, which bundles its core and zod.
  { specifier: "@json-render/react", file: "json-render-react.js", external: ["react", "react/jsx-runtime", "react-dom"] },
];

function packageOf(specifier) {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

/** The package's own package.json, found from where its main entry resolves (its exports may not list package.json). */
function packageJson(name) {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)));
  while (!existsSync(join(dir, "package.json")) || JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name !== name) {
    const up = dirname(dir);
    if (up === dir) throw new Error(`vendor: cannot find the package.json of ${name}`);
    dir = up;
  }
  return { dir, json: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) };
}

function versionOf(name) {
  return packageJson(name).json.version;
}

/** An entry that re-exports a CommonJS module's keys as ES named exports. */
function cjsEntry(specifier) {
  process.env.NODE_ENV = "production";
  const names = Object.keys(require(specifier)).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name) && name !== "default");
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

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const manifest = { packages: {} };
for (const module of MODULES) {
  const name = packageOf(module.specifier);
  const version = versionOf(name);
  const file = module.file ?? fileName(name, version, ".js");
  const entry = isCommonJs(module.specifier) ? cjsEntry(module.specifier) : `export * from ${JSON.stringify(module.specifier)};\n`;
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
  const versions = (manifest.packages[name] ??= { versions: {} }).versions;
  (versions[version] ??= { modules: {}, files: {} }).modules[module.specifier] = file;
}
for (const [name, stylesheets] of LIBRARIES) {
  const { dir, json } = packageJson(name);
  for (const path of stylesheets) {
    const file = fileName(name, json.version, `-${path.replace(/[^\w.-]/g, "-")}`);
    copyFileSync(join(dir, path), join(out, file));
    manifest.packages[name].versions[json.version].files[path] = file;
  }
}
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`vendor: ${Object.entries(manifest.packages).flatMap(([name, entry]) => Object.keys(entry.versions).map((version) => `${name}@${version}`)).join(", ")} -> public/vendor`);
