import { NO_VARIANTS, checkPrototype, type ProjectConfig, type Prototype, type Variant, type VariantState } from "@design-harness/core";
import { nook } from "../../../packages/core/examples/nook/project";
import type { AgentHost } from "../src/agent/tools";
import { seedSpec } from "./nook";

/**
 * An agent host over plain values, for tests in Node, on the legal Nook spec
 * prototype unless given another: changes apply at once,
 * and "measured" checks the source with core, without frames (so rendered
 * rules report not-run).
 */
export function fakeHost(initial: Prototype = seedSpec(), config: ProjectConfig = nook, startVariants: VariantState = NO_VARIANTS) {
  let prototype = initial;
  let variants = startVariants;
  const savedVariants: (readonly Variant[])[] = [];
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
      return { revision };
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
    variants: () => variants,
    saveVariants(next) {
      variants = { ...variants, variants: next };
      savedVariants.push(next);
    },
  };
  return { host, applied, saved, savedVariants, measuredCalls: () => measuredCalls, prototype: () => prototype, config: () => current, variants: () => variants };
}
