import { checkPrototype, extractPrototype, specModel, type CheckReport, type ProjectConfig, type Prototype, type PrototypeModel, type RenderedSnapshot } from "@design-harness/core";
import type { SpecPayload } from "./protocol";
import { specParts, specPayload } from "./spec-payload";
import { tagSites } from "./tags";
import { compilePrototype, type CompileProblem } from "./transform";

/**
 * Where core's engine runs for a check session: the page model, the rules,
 * the rendered rules on the frames' snapshots, and what a frame needs that
 * comes from the same model (a TSX prototype's compiled modules with their
 * element tags, a spec prototype's page for each scenario).
 *
 * `runEngine` is the one function that does it. The app runs it in a module
 * worker (`check-worker.ts`), so typing in the code view and scrolling the
 * board never wait on core, and on the main thread when a worker cannot
 * start. Both run the same function on the same input, and a report crosses
 * from the worker by structured clone, which keeps every key, value and
 * order, so the report is the same either way, byte for byte as JSON.
 *
 * Nothing here decides anything core does not: it calls core and returns
 * what core returned.
 */

/** A revision's first check, before any frame has answered, with what its frames need. */
export type PrepareRequest = {
  readonly kind: "prepare";
  readonly session: string;
  readonly revision: number;
  readonly config: ProjectConfig;
  readonly prototype: Prototype;
  /** Whether a TSX prototype's elements are tagged (`tags.ts`). */
  readonly tags: boolean;
};

export type Prepared = {
  /** Core's report with no snapshots: rendered rules say not-run. */
  readonly report: CheckReport;
  /** A TSX prototype's modules by specifier; empty for a spec prototype. */
  readonly modules: Readonly<Record<string, string>>;
  readonly problems: readonly CompileProblem[];
  /** A spec prototype's page for each scenario id, or null where its spec could not be read; absent for TSX. */
  readonly payloads?: Readonly<Record<string, SpecPayload | null>>;
};

/** A revision's check once every frame has answered, with the snapshots it has. */
export type MeasureRequest = {
  readonly kind: "measure";
  readonly session: string;
  readonly revision: number;
  readonly config: ProjectConfig;
  readonly prototype: Prototype;
  readonly snapshots: readonly RenderedSnapshot[];
};

export type EngineRequest = PrepareRequest | MeasureRequest;
export type EngineResult<R extends EngineRequest> = R extends PrepareRequest ? Prepared : CheckReport;

/** The model each session's revision was checked with, so its second check does not read the source again. One per session: a revision replaces the one before. */
export type EngineCache = Map<string, { readonly revision: number; readonly model: PrototypeModel }>;

function modelOf(config: ProjectConfig, prototype: Prototype): PrototypeModel {
  return prototype.format === "spec" ? specModel(prototype, config) : extractPrototype(prototype, config.library.package);
}

export function runEngine(cache: EngineCache, request: PrepareRequest): Prepared;
export function runEngine(cache: EngineCache, request: MeasureRequest): CheckReport;
export function runEngine(cache: EngineCache, request: EngineRequest): Prepared | CheckReport;
export function runEngine(cache: EngineCache, request: EngineRequest): Prepared | CheckReport {
  const { config, prototype } = request;
  if (request.kind === "measure") {
    const kept = cache.get(request.session);
    const model = kept?.revision === request.revision ? kept.model : modelOf(config, prototype);
    return checkPrototype({ config, prototype, snapshots: request.snapshots, model });
  }
  const model = modelOf(config, prototype);
  cache.set(request.session, { revision: request.revision, model });
  const report = checkPrototype({ config, prototype, model });
  if (prototype.format === "spec") {
    const parts = specParts(config);
    const payloads: Record<string, SpecPayload | null> = {};
    for (const scenario of prototype.scenarios) if (!(scenario.id in payloads)) payloads[scenario.id] = prototype.pages.some((page) => page.id === scenario.page) ? specPayload(config, prototype, scenario, parts) : null;
    return { report, modules: {}, problems: [], payloads };
  }
  // A TSX prototype's elements are tagged where core found them, after core has read the source.
  const compiled = compilePrototype(prototype.files, request.tags ? tagSites(model) : undefined);
  return { report, modules: compiled.modules, problems: compiled.problems };
}

/** Runs the engine for check sessions, and forgets a session's model when it is disposed. */
export interface CheckEngine {
  /** "worker" while checks run in the module worker; "main" on the main thread. */
  readonly where: () => "worker" | "main";
  run<R extends EngineRequest>(request: R): Promise<EngineResult<R>>;
  forget(session: string): void;
}

/** The engine on the main thread: the same function, a tick later, so a session behaves the same with either engine. */
export function mainThreadEngine(): CheckEngine {
  const cache: EngineCache = new Map();
  return {
    where: () => "main",
    run: <R extends EngineRequest>(request: R) => Promise.resolve().then(() => runEngine(cache, request) as EngineResult<R>),
    forget: (session) => {
      cache.delete(session);
    },
  };
}

/** App → worker. */
export type WorkerCall = { readonly id: number; readonly request: EngineRequest } | { readonly id: number; readonly forget: string };
/** Worker → app: what `runEngine` returned, or the message it threw. */
export type WorkerAnswer = { readonly id: number; readonly ok: true; readonly result: Prepared | CheckReport } | { readonly id: number; readonly ok: false; readonly message: string };

/** The part of a Worker the engine uses; injectable for tests. */
export type EngineWorker = Pick<Worker, "postMessage" | "terminate" | "addEventListener">;

/**
 * The engine in a module worker, falling back to the main thread for good
 * when the worker cannot start or fails: every call still waiting is run on
 * the main thread instead, so no revision is left without its report. A
 * request the engine itself throws on is run again on the main thread, so it
 * throws there as it always did.
 */
export function workerEngine(start: () => EngineWorker, fallback: CheckEngine = mainThreadEngine()): CheckEngine {
  let worker: EngineWorker | null = null;
  let next = 0;
  const pending = new Map<number, { readonly request: EngineRequest; readonly resolve: (value: Prepared | CheckReport) => void; readonly reject: (error: unknown) => void }>();
  const fail = () => {
    worker?.terminate();
    worker = null;
    const waiting = [...pending.values()];
    pending.clear();
    for (const item of waiting) fallback.run(item.request).then(item.resolve, item.reject);
  };
  try {
    worker = start();
    worker.addEventListener("message", (event: MessageEvent<WorkerAnswer>) => {
      const answer = event.data;
      const item = pending.get(answer.id);
      if (!item) return;
      pending.delete(answer.id);
      if (answer.ok) item.resolve(answer.result);
      else fallback.run(item.request).then(item.resolve, item.reject);
    });
    worker.addEventListener("error", (event) => {
      event.preventDefault?.();
      fail();
    });
    worker.addEventListener("messageerror", fail);
  } catch {
    worker = null;
  }
  return {
    where: () => (worker ? "worker" : "main"),
    run: <R extends EngineRequest>(request: R): Promise<EngineResult<R>> => {
      if (!worker) return fallback.run(request);
      const id = (next += 1);
      return new Promise<EngineResult<R>>((resolve, reject) => {
        pending.set(id, { request, resolve: resolve as (value: Prepared | CheckReport) => void, reject });
        try {
          worker?.postMessage({ id, request } satisfies WorkerCall);
        } catch {
          // The request could not be cloned or the worker is gone: the main thread runs it, and every call after.
          fail();
        }
      });
    },
    forget: (session) => {
      fallback.forget(session);
      try {
        worker?.postMessage({ id: (next += 1), forget: session } satisfies WorkerCall);
      } catch {
        fail();
      }
    },
  };
}
