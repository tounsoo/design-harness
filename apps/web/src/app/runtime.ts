import { boot, kit, spec } from "virtual:frame-runtime";
import { mainThreadEngine, workerEngine, type CheckEngine } from "../runtime/check-engine";
import { Session } from "../runtime/session";
import { esmShPackageSource, localPackageSource, type PackageSource } from "../runtime/package-source";

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
  const origin = params.get("packages-origin");
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

export function createSession(): Session {
  return new Session({ source: packageSource(), kit, spec, boot, parentOrigin: window.location.origin, window, engine: checkEngine() });
}
