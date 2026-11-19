import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nook } from "../../../../packages/core/examples/nook/project";
import { fileInManifest, satisfies, unservedDescriptions, vendoredLibraries, vendorFileName, type VendorManifest } from "../../scripts/vendor-libraries.mjs";
import { localPackageSource, resolvePackages } from "../runtime/package-source";
import { BUNDLED_PARTS } from "../store/migrate";
import { SHIPPED_LIBRARIES } from "./registry";
import { DESCRIBED_VERSIONS, currentDescription } from "./versions";

/**
 * The contract between what the app describes and what it serves: every
 * library version the app can be asked to render (a description core
 * ships, a registry entry, a version the stored-project migration accepts,
 * a version a project can be moved to) is served by the vendor build at
 * that exact version. These read the declared config, so they run without
 * `npm run vendor`; the vendor build itself refuses a manifest that leaves
 * one of core's descriptions out.
 */
const web = join(import.meta.dirname, "..", "..");
const root = join(web, "..", "..");
const packageJson = JSON.parse(readFileSync(join(web, "package.json"), "utf8")) as { dependencies: Record<string, string>; designHarness: { libraries: unknown } };
const served = vendoredLibraries(packageJson);
const isServed = (name: string, version: string) => served.some((library) => library.package === name && library.version === version);
const DESCRIPTIONS = join(root, "packages", "core", "libraries");

describe("every library version the app describes is served", () => {
  it("each description core ships in packages/core/libraries", () => {
    const files = readdirSync(DESCRIPTIONS).filter((file) => file.endsWith(".json")).sort();
    expect(files.length).toBeGreaterThan(0);
    const unserved = files.map((file) => JSON.parse(readFileSync(join(DESCRIPTIONS, file), "utf8")) as { package: string; version: string }).filter((description) => !isServed(description.package, description.version));
    expect(unserved.map((description) => `${description.package} ${description.version}`)).toEqual([]);
  });

  it("each registry entry, with the stylesheets it names", () => {
    for (const library of SHIPPED_LIBRARIES) expect(served.find((entry) => entry.package === library.package && entry.version === library.version)?.stylesheets).toEqual(library.setup.stylesheets);
  });

  it("each version the stored-project migration accepts", () => {
    expect(Object.keys(BUNDLED_PARTS).filter((key) => !isServed(key.slice(0, key.lastIndexOf("@")), key.slice(key.lastIndexOf("@") + 1)))).toEqual([]);
  });

  it("each version a project can be moved to, and its description is of that version", async () => {
    for (const entry of DESCRIBED_VERSIONS) {
      expect(isServed(entry.package, entry.version)).toBe(true);
      const description = await entry.describe();
      expect([description.package, description.version]).toEqual([entry.package, entry.version]);
    }
  });

  it("is installed at that version, under its own name or its npm alias", () => {
    expect(served.map((library) => [library.package, library.version, library.install])).toEqual([
      ["@tounsoo/todae", "0.11.3", "@tounsoo/todae"],
      ["@tounsoo/todae", "0.10.1", "@tounsoo/todae-0.10.1"],
      ["@mantine/core", "9.7.4", "@mantine/core"],
    ]);
    for (const library of served) {
      const installed = JSON.parse(readFileSync(join(root, "node_modules", library.install, "package.json"), "utf8")) as { name: string; version: string };
      expect([installed.name, installed.version]).toEqual([library.package, library.version]);
    }
  });
});

describe("reading the vendor build's config", () => {
  it("refuses a version with no dependency, a range, or an alias of another version", () => {
    const config = (libraries: unknown, dependencies: Record<string, string> = { "@acme/ui": "2.0.0" }) => () => vendoredLibraries({ dependencies, designHarness: { libraries } });
    expect(config({ "@acme/ui": { "2.0.0": [] } })()).toEqual([{ package: "@acme/ui", version: "2.0.0", install: "@acme/ui", stylesheets: [] }]);
    expect(config({ "@acme/ui": { "1.0.0": [] } })).toThrow('depends on neither "@acme/ui": "1.0.0" nor "@acme/ui-1.0.0": "npm:@acme/ui@1.0.0"');
    expect(config({ "@acme/ui": { "1.0.0": [] } }, { "@acme/ui": "2.0.0", "@acme/ui-1.0.0": "npm:@acme/ui@1.0.1" })).toThrow("depends on neither");
    expect(config({ "@acme/ui": { "1.0.0": [] } }, { "@acme/ui-1.0.0": "npm:@acme/ui@1.0.0" })()[0]?.install).toBe("@acme/ui-1.0.0");
    expect(config({ "@acme/ui": { "^2.0.0": [] } })).toThrow("not an exact version");
    expect(config({ "@acme/ui": ["styles.css"] })).toThrow("must map each exact version served");
    expect(config({ "@acme/ui": { "2.0.0": ["../outside.css"] } })).toThrow("paths inside the package");
  });

  it("checks a library's React peer range against the React frames get", () => {
    expect(satisfies("19.3.1", "^19.0.0")).toBe(true);
    expect(satisfies("19.3.1", "^18.0.0 || ^19.0.0")).toBe(true);
    expect(satisfies("19.3.1", "^18.2.0")).toBe(false);
    expect(satisfies("19.3.1", ">=18")).toBe(true);
    expect(satisfies("19.3.1", "~19.2.0")).toBe(false);
    expect(satisfies("0.2.5", "^0.2.3")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.3")).toBe(false);
    expect(() => satisfies("19.3.1", "19 - 20")).toThrow("cannot read the peer range");
  });
});

describe("a vendor manifest with two versions of one library", () => {
  const files = new Map<string, string>();
  const manifest: VendorManifest = { packages: {} };
  const add = (name: string, version: string, kind: "modules" | "files", key: string, suffix: string) => {
    const file = vendorFileName(name, version, suffix);
    fileInManifest(manifest, { package: name, version, kind, key, file });
    files.set(file, `/* ${name} ${version} ${key} */`);
  };
  add("react", "19.3.1", "modules", "react", ".js");
  add("react", "19.3.1", "modules", "react/jsx-runtime", "-jsx-runtime.js");
  add("react-dom", "19.3.1", "modules", "react-dom", ".js");
  add("react-dom", "19.3.1", "modules", "react-dom/client", "-client.js");
  for (const version of ["0.11.3", "0.10.1"]) {
    add("@tounsoo/todae", version, "modules", "@tounsoo/todae", ".js");
    add("@tounsoo/todae", version, "files", "dist/todae.css", "-dist-todae.css");
  }
  const fetchText = (url: string) => {
    const file = url.replace("https://app.example/vendor/", "");
    const text = file === "manifest.json" ? JSON.stringify(manifest) : files.get(file);
    return Promise.resolve({ ok: text !== undefined, status: text === undefined ? 404 : 200, text: () => Promise.resolve(text ?? "") });
  };

  it("files each version under the package's real name, and serves each project exactly the version it names", async () => {
    expect(Object.keys(manifest.packages["@tounsoo/todae"]?.versions ?? {})).toEqual(["0.11.3", "0.10.1"]);
    const source = localPackageSource("https://app.example/vendor/", fetchText);
    const older = await resolvePackages({ ...nook.library, version: "0.10.1" }, source);
    const newer = await resolvePackages(nook.library, source);
    // The frame imports @tounsoo/todae either way; what it gets is its project's version, with that version's stylesheet.
    expect(older.modules["@tounsoo/todae"]).toEqual({ code: "/* @tounsoo/todae 0.10.1 @tounsoo/todae */" });
    expect(older.styles).toEqual([{ css: "/* @tounsoo/todae 0.10.1 dist/todae.css */" }]);
    expect(newer.modules["@tounsoo/todae"]).toEqual({ code: "/* @tounsoo/todae 0.11.3 @tounsoo/todae */" });
    // React is one version, shared by both.
    expect(older.modules.react).toEqual(newer.modules.react);
    expect(await source.versions?.("@tounsoo/todae")).toEqual(["0.10.1", "0.11.3"]);
  });

  it("refuses to file two things under one key, and names every description it does not serve", () => {
    expect(() => fileInManifest(manifest, { package: "@tounsoo/todae", version: "0.10.1", kind: "modules", key: "@tounsoo/todae", file: "x.js" })).toThrow("already has @tounsoo/todae");
    expect(unservedDescriptions(manifest, [{ package: "@tounsoo/todae", version: "0.10.1" }, { package: "@tounsoo/todae", version: "0.9.0" }, { package: "@mantine/core", version: "9.7.4" }])).toEqual(["@mantine/core 9.7.4", "@tounsoo/todae 0.9.0"]);
  });
});

describe("the description of the version a project is on", () => {
  it("is the project's own parts when it has them, else the one the app ships, else none", async () => {
    expect((await currentDescription(nook))?.parts).toBe(nook.library.parts);
    const { parts: _parts, ...bare } = nook.library;
    expect((await currentDescription({ ...nook, library: { ...bare, version: "0.10.1" } }))?.version).toBe("0.10.1");
    expect(await currentDescription({ ...nook, library: { ...bare, version: "0.9.0" } })).toBeNull();
  });
});
