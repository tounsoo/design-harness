import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nook } from "../examples/nook/project";
import { legalSnapshots } from "../examples/nook/snapshots";
import type { ProjectConfig } from "../src/config/types";
import { checkPrototype } from "../src/engine/check";
import { specModel } from "../src/spec/model";
import type { Prototype } from "../src/prototype/types";
import { EXAMPLES, loadCases, loadPrototype } from "./fixtures";

const legal = loadPrototype(join(EXAMPLES, "spec", "legal", "booking"));

function reversedKeys<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).reverse()) as T;
}

/** The same prototype with its files, manifest lists and flow tasks given in the opposite order. */
function shuffledPrototype(prototype: Prototype): Prototype {
  return reversedKeys({
    ...prototype,
    files: reversedKeys(prototype.files),
    pages: [...prototype.pages].reverse(),
    layouts: [...prototype.layouts].reverse(),
    scenarios: [...prototype.scenarios].reverse(),
    flow: { states: [...prototype.flow.states].reverse(), tasks: [...prototype.flow.tasks].reverse() },
  });
}

/** The same config with its rules, caps and roles given in the opposite order. */
function shuffledConfig(config: ProjectConfig): ProjectConfig {
  return reversedKeys({
    ...config,
    library: { ...config.library, roles: reversedKeys(config.library.roles) },
    inputs: { ...config.inputs, caps: reversedKeys(config.inputs.caps) },
    rules: [...config.rules].reverse(),
  });
}

describe("checks are deterministic", () => {
  it("the same input twice gives byte-identical reports", () => {
    const first = JSON.stringify(checkPrototype({ config: nook, prototype: legal, snapshots: legalSnapshots() }));
    const second = JSON.stringify(checkPrototype({ config: nook, prototype: legal, snapshots: legalSnapshots() }));
    expect(second).toBe(first);
  });

  it("the page model does not depend on the order files are given in", () => {
    expect(JSON.stringify(specModel(shuffledPrototype(legal), nook))).toBe(JSON.stringify(specModel(legal, nook)));
  });

  it("reports with findings are identical whatever order files, keys, lists, rules and snapshots come in", () => {
    const cases = ["illegal", "refused"].flatMap((kind) => loadCases(legal, join(EXAMPLES, "spec", kind)));
    expect(cases.length).toBeGreaterThan(0);
    for (const item of [...cases, { name: "legal", prototype: legal }]) {
      const snapshots = legalSnapshots();
      const straight = JSON.stringify(checkPrototype({ config: nook, prototype: item.prototype, snapshots }));
      const shuffled = JSON.stringify(checkPrototype({ config: shuffledConfig(nook), prototype: shuffledPrototype(item.prototype), snapshots: [...snapshots].reverse() }));
      expect(shuffled, item.name).toBe(straight);
    }
  });

  it("a prototype with many findings keeps one order across runs", () => {
    const messy: Prototype = {
      ...legal,
      files: {
        ...legal.files,
        "pages/extra.json": JSON.stringify({
          root: "page",
          elements: {
            page: { type: "Page", props: {}, slots: { body: ["raw", "b", "outer"], footer: [] }, children: ["loose"] },
            raw: { type: "button", props: {}, children: [] },
            b: { type: "Button.Root", props: { text: "b", variant: { $cond: { $state: "/scenario/state", eq: "held" }, $then: "primary", $else: "ghost" } }, children: [] },
            outer: { type: "Disclosure.Root", props: {}, children: ["inner"] },
            inner: { type: "Disclosure.Root", props: {}, children: [] },
            loose: { type: "Text.Root", props: { text: "loose" }, children: [] },
          },
        }),
      },
      pages: [...legal.pages, { id: "extra", pageType: "booking", component: { file: "pages/extra.json", export: "default" } }],
    };
    const report = checkPrototype({ config: nook, prototype: messy });
    expect(report.findings.length).toBeGreaterThan(5);
    expect(JSON.stringify(checkPrototype({ config: shuffledConfig(nook), prototype: shuffledPrototype(messy) }))).toBe(JSON.stringify(report));
  });
});
