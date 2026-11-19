/**
 * The component library versions the local package source serves, read from
 * apps/web/package.json. It is shared by the vendor build, which builds each
 * one, and the unit tests, which hold every library description the app
 * ships to it, so a version cannot be described without being served.
 *
 * `designHarness.libraries` maps each package to the exact versions served,
 * each with the stylesheets (paths inside the package) a project may name:
 *
 *   "@tounsoo/todae": { "0.11.3": ["dist/todae.css"], "0.10.1": ["dist/todae.css"] }
 *
 * One version of a package is the app's own dependency under its real name.
 * Every other version is installed beside it with an npm alias named
 * `<package>-<version>`, such as
 * `"@tounsoo/todae-0.10.1": "npm:@tounsoo/todae@0.10.1"`: the alias is
 * derived from the name and version, so the config never repeats it, and it
 * says what it holds wherever it shows up (node_modules, the lockfile).
 * Neither name reaches a frame: the vendor build files each version under
 * the package's real name and exact version.
 */

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The npm alias another version of a package is installed under. */
export function aliasOf(name, version) {
  return `${name}-${version}`;
}

/**
 * Every library version to serve, in config order, with the name it is
 * installed under in node_modules. Throws, naming the problem, when the
 * config or the dependencies do not say exactly where each version is.
 *
 * @param {{ dependencies?: Record<string, string>, designHarness?: { libraries?: unknown } }} packageJson
 * @returns {{ package: string, version: string, install: string, stylesheets: string[] }[]}
 */
export function vendoredLibraries(packageJson) {
  const dependencies = packageJson.dependencies ?? {};
  const libraries = packageJson.designHarness?.libraries ?? {};
  if (typeof libraries !== "object" || libraries === null || Array.isArray(libraries)) throw new Error("designHarness.libraries must map each package to its versions");
  const out = [];
  for (const [name, versions] of Object.entries(libraries)) {
    if (typeof versions !== "object" || versions === null || Array.isArray(versions) || Object.keys(versions).length === 0) {
      throw new Error(`designHarness.libraries["${name}"] must map each exact version served to its stylesheets, such as { "1.2.3": ["dist/styles.css"] }`);
    }
    for (const [version, stylesheets] of Object.entries(versions)) {
      if (!EXACT.test(version)) throw new Error(`designHarness.libraries["${name}"] lists "${version}", which is not an exact version`);
      if (!Array.isArray(stylesheets) || stylesheets.some((path) => typeof path !== "string" || path === "" || path.startsWith("/") || path.includes(".."))) {
        throw new Error(`designHarness.libraries["${name}"]["${version}"] must list stylesheets as paths inside the package`);
      }
      const alias = aliasOf(name, version);
      let install;
      if (dependencies[name] === version) install = name;
      else if (dependencies[alias] === `npm:${name}@${version}`) install = alias;
      else throw new Error(`designHarness.libraries serves ${name} ${version}, but the app depends on neither "${name}": "${version}" nor "${alias}": "npm:${name}@${version}"`);
      out.push({ package: name, version, install, stylesheets: [...stylesheets] });
    }
  }
  return out;
}

/**
 * Whether an installed version meets a peer range of the forms packages
 * write: `1.2.3`, `^1.2.3`, `~1.2.3`, `>=1.2.3`, `*`, joined by `||`. Throws
 * on any other form rather than guess.
 */
export function satisfies(version, range) {
  const parse = (text) => text.split("-")[0].split(".").map((part) => Number(part));
  const [major, minor, patch] = parse(version);
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  return range.split("||").some((alternative) => {
    const text = alternative.trim();
    if (text === "*" || text === "") return true;
    const match = /^(\^|~|>=)?(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?$/.exec(text);
    if (!match) throw new Error(`cannot read the peer range "${range}"`);
    const [, op, a, b, c] = match;
    const low = [Number(a), b === undefined || b === "x" ? 0 : Number(b), c === undefined || c === "x" ? 0 : Number(c)];
    const at = [major, minor, patch];
    if (compare(at, low) < 0) return false;
    if (op === ">=") return true;
    if (op === "^") return low[0] !== 0 ? major === low[0] : minor === low[1] && (low[1] !== 0 || patch === low[2]);
    if (op === "~" || b === undefined || b === "x" || c === undefined || c === "x") return major === low[0] && (b === undefined || b === "x" || minor === low[1]);
    return compare(at, low) === 0;
  });
}

/** A file name for a package's module or file: its name and version, safe in a URL path. */
export function vendorFileName(name, version, suffix) {
  return `${name.replace(/^@/, "").replace(/[^\w.-]/g, "-")}@${version}${suffix}`;
}

/**
 * Files one built module or copied package file in the manifest, under the
 * package's real name and exact version. `kind` is `modules` (by the
 * specifier a frame imports) or `files` (by its path in the package).
 * Refuses to file two things under one key.
 */
export function fileInManifest(manifest, { package: name, version, kind, key, file }) {
  const versions = (manifest.packages[name] ??= { versions: {} }).versions;
  const entry = (versions[version] ??= { modules: {}, files: {} });
  if (Object.hasOwn(entry[kind], key)) throw new Error(`vendor: ${name} ${version} already has ${key}`);
  entry[kind][key] = file;
  return manifest;
}

/**
 * The library descriptions a manifest cannot render: each `{ package,
 * version }` it serves no root module of, as "<package> <version>", sorted.
 * Empty when every description is served.
 */
export function unservedDescriptions(manifest, descriptions) {
  const missing = [];
  for (const description of descriptions) {
    const entry = manifest.packages[description.package]?.versions?.[description.version];
    if (!entry || !Object.hasOwn(entry.modules, description.package)) missing.push(`${description.package} ${description.version}`);
  }
  return missing.sort();
}
