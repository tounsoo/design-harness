/**
 * Builds the local package source: one ES module per package entry a frame
 * imports, from this repository's node_modules, into public/vendor/. The
 * frame's import map points each bare specifier at one of these files, so
 * React is one instance shared by the library, the page kit and the
 * prototype. CommonJS packages (React, React DOM) get their named exports
 * listed from the module itself, as a CDN such as esm.sh does.
 *
 * Output: public/vendor/manifest.json, which names each package's version,
 * the file for each module specifier, and the package files (stylesheets)
 * copied as they are.
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

/** The library's stylesheets to copy, by path inside the package. */
const LIBRARY = "@tounsoo/todae";
const LIBRARY_FILES = ["dist/todae.css"];

/** Each module a frame imports: specifier, file name, and which specifiers stay external. */
const MODULES = [
  { specifier: "react", file: "react.js", external: [] },
  { specifier: "react/jsx-runtime", file: "react-jsx-runtime.js", external: ["react"] },
  { specifier: "react-dom", file: "react-dom.js", external: ["react"] },
  { specifier: "react-dom/client", file: "react-dom-client.js", external: ["react", "react-dom"] },
  { specifier: LIBRARY, file: "library.js", external: ["react", "react/jsx-runtime", "react-dom"] },
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
    outfile: join(out, module.file),
    logLevel: "warning",
  });
  const entryOf = (manifest.packages[name] ??= { version: versionOf(name), modules: {}, files: {} });
  entryOf.modules[module.specifier] = module.file;
}
for (const path of LIBRARY_FILES) {
  const file = path.split("/").pop();
  copyFileSync(join(packageJson(LIBRARY).dir, path), join(out, file));
  manifest.packages[LIBRARY].files[path] = file;
}
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`vendor: ${Object.entries(manifest.packages).map(([name, entry]) => `${name}@${entry.version}`).join(", ")} -> public/vendor`);
