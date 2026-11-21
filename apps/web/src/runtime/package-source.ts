import type { ComponentLibrary } from "@design-harness/core";
import type { ModuleSource, StyleSource } from "./protocol";

/**
 * Where a package's code comes from. A frame imports React, React DOM and the
 * project's component library by bare specifier; a package source says, for
 * one package at one exact version, where each module and stylesheet is.
 *
 * - `localPackageSource` serves React, React DOM, json-render and every
 *   component library apps/web/package.json lists under
 *   `designHarness.libraries`, at the versions installed in this
 *   repository's node_modules, prebuilt into `public/vendor/` by
 *   `npm run vendor`, each by name and exact version. It is what
 *   development, the tests and the default build use, and it works offline.
 *   It refuses any other package or version rather than render with the
 *   wrong one.
 * - `esmShPackageSource` points the frame at esm.sh, so any published version
 *   loads, with React kept external so the library and the page share one React.
 *
 * A page uses one source for every project (`?packages=esm.sh` picks
 * esm.sh for all of them). A project whose library version the page's
 * source does not serve can be set, by a person, to load from esm.sh alone
 * (`library.source`), when the deployment allows it: `sourceFor` picks the
 * source for one project's library, and the frame's CSP names that source's
 * origins only, so no other project's frames can reach esm.sh.
 */
export type PackageRequest = { readonly package: string; readonly version: string };

export interface PackageSource {
  /** A short name for messages: `local` or `esm.sh`. */
  readonly name: string;
  /** Origins the frame must be allowed to load modules, styles and fonts from. */
  readonly origins: readonly string[];
  /** One module of a package, by its specifier (`react`, `react/jsx-runtime`, `@tounsoo/todae`). */
  module(specifier: string, request: PackageRequest): Promise<ModuleSource>;
  /** A file inside a package, such as `dist/todae.css`. */
  stylesheet(path: string, request: PackageRequest): Promise<StyleSource>;
  /** The exact versions of a package this source serves, sorted, or `any` for a CDN that serves every published version. */
  versions?(name: string): Promise<readonly string[] | "any">;
}

/** How a failure to load packages starts, wherever it is shown, so a frame's card can tell it from its page's own failure. */
export const PACKAGES_UNAVAILABLE = "Packages could not load";

/** The page's source, and esm.sh when the deployment lets a project choose it for a version the page's source does not serve. */
export type PackageSources = { readonly page: PackageSource; readonly esm: PackageSource | null };

/**
 * The source one project's frames load its library from: esm.sh when the
 * project chose it and the deployment allows it, else the page's source.
 * A project that chose esm.sh on a deployment that does not allow it loads
 * from the page's source, and its failure says so.
 */
export function sourceFor(library: Pick<ComponentLibrary, "source">, sources: PackageSources): PackageSource {
  return library.source === "esm.sh" && sources.esm ? sources.esm : sources.page;
}

/** What a frame needs from packages: every module by specifier, and the library's stylesheets. */
export type RuntimePackages = { readonly modules: Readonly<Record<string, ModuleSource>>; readonly styles: readonly StyleSource[] };

/** The React modules every frame imports, with the package each comes from. */
const REACT_MODULES: readonly (readonly [string, string])[] = [
  ["react", "react"],
  ["react/jsx-runtime", "react"],
  ["react-dom", "react-dom"],
  ["react-dom/client", "react-dom"],
];

/**
 * The json-render renderer a spec prototype's frames draw with, at the exact
 * version the app is built and tested with: the app pins it, not the
 * project, since it is the harness's renderer rather than the project's
 * library.
 */
export const JSON_RENDER: PackageRequest = { package: "@json-render/react", version: "0.23.1" };

/**
 * Resolves every package module and stylesheet a project's frames import:
 * React, React DOM and the library, and for a spec prototype json-render's
 * renderer. Rejects with a message that names what is missing.
 */
export async function resolvePackages(library: ComponentLibrary, source: PackageSource, options: { readonly spec?: boolean } = {}): Promise<RuntimePackages> {
  const requests: [string, PackageRequest][] = [
    ...REACT_MODULES.map(([specifier, name]): [string, PackageRequest] => [specifier, { package: name, version: library.react }]),
    [library.package, { package: library.package, version: library.version }],
    ...(options.spec ? [[JSON_RENDER.package, JSON_RENDER] as [string, PackageRequest]] : []),
  ];
  const resolved = await Promise.all(requests.map(async ([specifier, request]) => [specifier, await source.module(specifier, request)] as const));
  const styles = await Promise.all((library.stylesheets ?? []).map((path) => source.stylesheet(path, { package: library.package, version: library.version })));
  return { modules: Object.fromEntries(resolved), styles };
}

/** One package at one version, as the vendor build wrote it: the file for each module specifier, and for each package file (a stylesheet). */
type VendorEntry = { readonly modules: Readonly<Record<string, string>>; readonly files: Readonly<Record<string, string>> };
/** `public/vendor/manifest.json`: every package the build served, by name and exact version. */
export type VendorManifest = { readonly packages: Readonly<Record<string, { readonly versions: Readonly<Record<string, VendorEntry>> }>> };

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * The packages installed in node_modules, served from `base` (the app's
 * `vendor/` folder). Modules are sent to the frame as code, which it loads
 * from blob URLs, so the frame never fetches from the app's origin.
 */
export function localPackageSource(base: string, fetchText: Fetch = (url) => fetch(url)): PackageSource {
  const root = base.endsWith("/") ? base : `${base}/`;
  const texts = new Map<string, Promise<string>>();
  const get = (file: string): Promise<string> => {
    let text = texts.get(file);
    if (!text) {
      text = fetchText(`${root}${file}`).then((response) => {
        if (!response.ok) throw new Error(`the local package source could not read ${root}${file} (HTTP ${response.status}); run npm run vendor`);
        return response.text();
      });
      texts.set(file, text);
      text.catch(() => texts.delete(file));
    }
    return text;
  };
  let manifest: Promise<VendorManifest> | undefined;
  // A manifest that could not be read is read again next time, as every other file is: a failed read is never kept.
  const readManifest = (): Promise<VendorManifest> => {
    if (!manifest) {
      const reading = get("manifest.json").then((text) => JSON.parse(text) as VendorManifest);
      manifest = reading;
      reading.catch(() => {
        if (manifest === reading) manifest = undefined;
      });
    }
    return manifest;
  };
  const entry = async (request: PackageRequest) => {
    const versions = (await readManifest()).packages[request.package]?.versions;
    if (!versions) throw new Error(`the local package source has no ${request.package}; it serves only the packages this app was built with (open the app with ?packages=esm.sh to load any package from esm.sh)`);
    const found = Object.hasOwn(versions, request.version) ? versions[request.version] : undefined;
    if (!found) {
      throw new Error(`the local package source has ${request.package} ${sortVersions(Object.keys(versions)).join(", ")}, but the project asks for ${request.version}; it serves only the versions this app was built with`);
    }
    return found;
  };
  return {
    name: "local",
    origins: [],
    async versions(name) {
      return sortVersions(Object.keys((await readManifest()).packages[name]?.versions ?? {}));
    },
    async module(specifier, request) {
      const found = await entry(request);
      const file = found.modules[specifier];
      if (!file) throw new Error(`the local package source serves only ${Object.keys(found.modules).join(", ")} of ${request.package}, not ${specifier}`);
      return { code: await get(file) };
    },
    async stylesheet(path, request) {
      const found = await entry(request);
      const file = found.files[path];
      if (!file) throw new Error(`the local package source has no ${path} in ${request.package}`);
      return { css: await get(file) };
    },
  };
}

/**
 * esm.sh: `https://esm.sh/<package>@<version>[/<subpath>]`, with React and
 * React DOM marked external so every module imports the one React the frame's
 * import map names. Files that are not modules, such as stylesheets, are
 * served as they are in the package.
 */
export function esmShPackageSource(origin = "https://esm.sh"): PackageSource {
  const base = origin.replace(/\/$/, "");
  const external = (request: PackageRequest) => (request.package === "react" ? "" : "?external=react,react-dom");
  return {
    name: "esm.sh",
    origins: [base],
    versions: () => Promise.resolve("any"),
    module(specifier, request) {
      if (specifier !== request.package && !specifier.startsWith(`${request.package}/`)) return Promise.reject(new Error(`${specifier} is not a module of ${request.package}`));
      const subpath = specifier.slice(request.package.length);
      return Promise.resolve({ url: `${base}/${request.package}@${request.version}${subpath}${external(request)}` });
    },
    stylesheet(path, request) {
      return Promise.resolve({ url: `${base}/${request.package}@${request.version}/${path}` });
    },
  };
}

/** Versions in numeric order, oldest first: 0.9.0 before 0.10.1. */
export function sortVersions(versions: readonly string[]): string[] {
  const parts = (version: string) => version.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return [...versions].sort((a, b) => {
    const x = parts(a);
    const y = parts(b);
    for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
      const p = x[index];
      const q = y[index];
      if (p === q) continue;
      if (p === undefined) return -1;
      if (q === undefined) return 1;
      if (typeof p === "number" && typeof q === "number") return p - q;
      return String(p) < String(q) ? -1 : 1;
    }
    return 0;
  });
}
