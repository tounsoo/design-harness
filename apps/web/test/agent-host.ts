import { checkPrototype, type ProjectConfig, type Prototype } from "@design-harness/core";
import { nook } from "../../../packages/core/examples/nook/project";
import type { AgentHost } from "../src/agent/tools";
import { seedLegal } from "./nook";

/**
 * An agent host over plain values, for tests in Node: changes apply at once,
 * and "measured" checks the source with core, without frames (so rendered
 * rules report not-run).
 */
export function fakeHost(initial: Prototype = seedLegal(), config: ProjectConfig = nook) {
  let prototype = initial;
  let current = config;
  let revision = 1;
  const applied: Prototype[] = [];
  const saved: ProjectConfig[] = [];
  let measuredCalls = 0;
  const host: AgentHost = {
    config: () => current,
    prototype: () => prototype,
    apply(next) {
      prototype = next;
      revision += 1;
      applied.push(next);
      return { revision, compileProblems: [] };
    },
    async saveConfig(next) {
      current = next;
      saved.push(next);
    },
    async measured(signal) {
      measuredCalls += 1;
      if (signal.aborted) throw new DOMException("stopped", "AbortError");
      return { revision, report: checkPrototype({ config: current, prototype }), frames: [] };
    },
    now: () => "2026-11-17T12:00:00.000Z",
  };
  return { host, applied, saved, measuredCalls: () => measuredCalls, prototype: () => prototype, config: () => current };
}
