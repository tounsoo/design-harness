import { describe, expect, it } from "vitest";
import { checkPrototype, type ProjectConfig, type Prototype, type RenderedSnapshot } from "@design-harness/core";
import { legalSnapshots } from "../../../../packages/core/examples/nook/snapshots";
import { seedProject } from "../seed/nook";
import { tallyProject } from "../seed/tally";
import { mainThreadEngine, runEngine, workerEngine, type CheckEngine, type EngineCache, type EngineWorker, type WorkerAnswer, type WorkerCall } from "./check-engine";
import { specParts, specPayload } from "./spec-payload";

/**
 * A module worker without a browser: what the app posts is cloned in, run
 * by `runEngine` with a cache of its own, and its answer cloned back out a
 * tick later, as structured clone does between the app and its worker.
 */
function fakeWorker(): EngineWorker & { readonly calls: WorkerCall[]; fail: () => void } {
  const cache: EngineCache = new Map();
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const calls: WorkerCall[] = [];
  return {
    calls,
    addEventListener: ((type: string, listener: (event: unknown) => void) => (listeners[type] ??= []).push(listener)) as EngineWorker["addEventListener"],
    postMessage: ((message: WorkerCall) => {
      const call = structuredClone(message);
      calls.push(call);
      if ("forget" in call) return;
      setTimeout(() => {
        let answer: WorkerAnswer;
        try {
          answer = { id: call.id, ok: true, result: runEngine(cache, call.request) };
        } catch (error) {
          answer = { id: call.id, ok: false, message: String(error) };
        }
        for (const listener of listeners.message ?? []) listener({ data: structuredClone(answer) });
      }, 0);
    }) as EngineWorker["postMessage"],
    terminate: () => undefined,
    fail: () => {
      for (const listener of listeners.error ?? []) listener({ preventDefault: () => undefined });
    },
  };
}

/** Light snapshots for every view, the dark views measured as their light twins, for every scenario: rendered rules have something to read on any seed. */
function snapshotsFor(config: ProjectConfig, prototype: Prototype): RenderedSnapshot[] {
  const light = legalSnapshots();
  return prototype.scenarios.flatMap((scenario, index) =>
    config.views.map((view) => {
      const twin = light.find((item) => item.view === view.name.replace(/-dark$/, "") && item.scenario === scenario.id) ?? light[index % light.length] ?? (light[0] as RenderedSnapshot);
      return { ...twin, scenario: scenario.id, view: view.name };
    }),
  );
}

const nook = seedProject();
const tally = tallyProject();
const SEEDS = [
  { name: "Nook, spec", config: nook.config, prototype: nook.prototype },
  { name: "Tally, spec on Mantine", config: tally.config, prototype: tally.prototype },
];

async function reports(engine: CheckEngine, config: ProjectConfig, prototype: Prototype, snapshots: readonly RenderedSnapshot[]) {
  const prepared = await engine.run({ kind: "prepare", session: "s", revision: 1, config, prototype });
  const measured = await engine.run({ kind: "measure", session: "s", revision: 1, config, prototype, snapshots });
  return { prepared, measured };
}

describe("core's engine off the main thread", () => {
  for (const seed of SEEDS) {
    it(`gives ${seed.name} the same reports byte for byte in the worker, on the main thread, and from core directly`, async () => {
      const snapshots = snapshotsFor(seed.config, seed.prototype);
      const direct = { prepared: checkPrototype({ config: seed.config, prototype: seed.prototype }), measured: checkPrototype({ config: seed.config, prototype: seed.prototype, snapshots }) };
      // Not a trivial comparison: the rendered rules ran on the snapshots, where the first check left them not run.
      expect(JSON.stringify(direct.measured)).not.toBe(JSON.stringify(direct.prepared));
      const worker = fakeWorker();
      const inWorker = await reports(workerEngine(() => worker), seed.config, seed.prototype, snapshots);
      const onMain = await reports(mainThreadEngine(), seed.config, seed.prototype, snapshots);
      expect(worker.calls.map((call) => ("request" in call ? call.request.kind : "forget"))).toEqual(["prepare", "measure"]);
      for (const result of [inWorker, onMain]) {
        expect(JSON.stringify(result.prepared.report)).toBe(JSON.stringify(direct.prepared));
        expect(JSON.stringify(result.measured)).toBe(JSON.stringify(direct.measured));
      }
      // And what the frames need is what the main thread worked out before: the same pages, as data, and no module of prototype code.
      const parts = specParts(seed.config);
      const pages = Object.fromEntries(seed.prototype.scenarios.map((scenario) => [scenario.id, specPayload(seed.config, seed.prototype, scenario, parts)]));
      expect(JSON.stringify(inWorker.prepared.payloads)).toBe(JSON.stringify(pages));
      expect(Object.keys(inWorker.prepared).sort()).toEqual(["payloads", "report"]);
    });
  }

  it("checks a revision with snapshots on the model it kept, and reads the source again for a revision it does not know", () => {
    const cache: EngineCache = new Map();
    const { config, prototype } = SEEDS[0] as (typeof SEEDS)[number];
    const snapshots = snapshotsFor(config, prototype);
    runEngine(cache, { kind: "prepare", session: "s", revision: 3, config, prototype });
    expect(cache.get("s")?.revision).toBe(3);
    const kept = runEngine(cache, { kind: "measure", session: "s", revision: 3, config, prototype, snapshots });
    const fresh = runEngine(new Map(), { kind: "measure", session: "s", revision: 3, config, prototype, snapshots });
    expect(JSON.stringify(kept)).toBe(JSON.stringify(fresh));
  });

  it("runs on the main thread when a worker cannot start, and moves every waiting call there when the worker fails", async () => {
    const { config, prototype } = SEEDS[0] as (typeof SEEDS)[number];
    const direct = JSON.stringify(checkPrototype({ config, prototype }));
    const refused = workerEngine(() => {
      throw new Error("no workers here");
    });
    expect(refused.where()).toBe("main");
    expect(JSON.stringify((await refused.run({ kind: "prepare", session: "s", revision: 1, config, prototype })).report)).toBe(direct);

    const worker = fakeWorker();
    const engine = workerEngine(() => ({ ...worker, postMessage: () => undefined }));
    expect(engine.where()).toBe("worker");
    const waiting = engine.run({ kind: "prepare", session: "s", revision: 1, config, prototype });
    worker.fail();
    expect(engine.where()).toBe("main");
    expect(JSON.stringify((await waiting).report)).toBe(direct);
  });
});
