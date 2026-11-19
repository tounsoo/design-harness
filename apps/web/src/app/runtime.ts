import { boot, kit, spec } from "virtual:frame-runtime";
import { mainThreadEngine, workerEngine, type CheckEngine } from "../runtime/check-engine";
import { Session } from "../runtime/session";
import { esmShPackageSource, localPackageSource, type PackageSource, type PackageSources } from "../runtime/package-source";

/**
 * The package source this page uses: `local` (packages installed in
 * node_modules, served from ./vendor/) unless the build sets
 * VITE_PACKAGE_SOURCE=esm.sh or the page is opened with ?packages=esm.sh.
 * `&packages-origin=<origin>` points the esm.sh source at a mirror with the
 * same URL scheme. Frames are sandboxed whatever they load, so the choice
 * of origin cannot widen what a frame can reach.
 */
export function packageSource(): PackageSource {
  // One source for the page, so every session shares the files it has already read.
  shared ??= choose();
  return shared;
}

let shared: PackageSource | undefined;

function choose(): PackageSource {
  const params = new URLSearchParams(window.location.search);
  const asked = params.get("packages") ?? import.meta.env.VITE_PACKAGE_SOURCE ?? "local";
  if (asked !== "esm.sh") return localPackageSource(new URL("vendor/", document.baseURI).href);
  return esm();
}

/** esm.sh, or the mirror `&packages-origin=` names. */
function esm(): PackageSource {
  const origin = new URLSearchParams(window.location.search).get("packages-origin");
  return origin && /^https?:\/\//.test(origin) ? esmShPackageSource(new URL(origin).origin) : esmShPackageSource();
}

/**
 * Where core's engine runs for every session of the page: one module
 * worker, so typing and scrolling never wait on a check, or the main thread
 * when the page is opened with `?checks=main` or a worker cannot start. The
 * report is the same either way (`check-engine.ts`).
 */
export function checkEngine(): CheckEngine {
  engine ??= new URLSearchParams(window.location.search).get("checks") === "main" || typeof Worker === "undefined" ? mainThreadEngine() : workerEngine(() => new Worker(new URL("../runtime/check-worker.ts", import.meta.url), { type: "module", name: "design-harness checks" }));
  return engine;
}

let engine: CheckEngine | undefined;

/**
 * Whether this deployment lets a person load one project's library from
 * esm.sh, for a version the page's source does not serve. On unless the
 * build sets `VITE_ESM_FALLBACK=off`; a person still chooses it, per
 * project, and the project shows that choice wherever it is open.
 */
export const ESM_FALLBACK = import.meta.env.VITE_ESM_FALLBACK !== "off";

/** The page's source, and esm.sh for a project that chose it, when the deployment allows it. */
export function packageSources(): PackageSources {
  sharedEsm ??= ESM_FALLBACK ? esm() : null;
  return { page: packageSource(), esm: sharedEsm };
}

let sharedEsm: PackageSource | null | undefined;

export function createSession(): Session {
  const sources = packageSources();
  return new Session({ source: sources.page, esm: sources.esm, kit, spec, boot, parentOrigin: window.location.origin, window, engine: checkEngine() });
}
