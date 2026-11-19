import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nook } from "../examples/nook/project";
import { renderedCases } from "../examples/nook/rendered-cases";
import { button, heading, legalSnapshots, text } from "../examples/nook/snapshots";
import { RULE_TYPES, checkPrototype } from "../src/engine/check";
import { EVIDENCE_KINDS, RULE_EVIDENCE, evidenceFor, type Evidence, type EvidenceDeclaration } from "../src/engine/evidence";
import { flowFacts, viewFacts } from "../src/engine/facts";
import type { Finding } from "../src/engine/report";
import type { RenderedSnapshot } from "../src/rendered/types";
import type { RuleSpec } from "../src/rules/types";
import { EXAMPLES, loadCases, loadPrototype } from "./fixtures";
import { HEADER, check, configWith, prototype } from "./helpers";

const legal = loadPrototype(join(EXAMPLES, "legal", "booking"));
const cases = loadCases(legal, join(EXAMPLES, "illegal"));

const ONE_ACTION: RuleSpec = { type: "slot", id: "one-action", slot: "action", holds: { role: "action" }, max: 1 };
const TWO_ACTIONS = { "pages/home.tsx": `${HEADER}export function Home() { return <Slot name="action"><Button.Root>A</Button.Root><Button.Root>B</Button.Root></Slot>; }` };

/** Every finding the Nook fixtures produce, each with its rule's spec. */
function fixtureFindings(): { finding: Finding; rule: RuleSpec }[] {
  const out: { finding: Finding; rule: RuleSpec }[] = [];
  const add = (findings: readonly Finding[], rules: readonly RuleSpec[]) => {
    for (const finding of findings) {
      const rule = rules.find((item) => item.id === finding.rule);
      if (rule) out.push({ finding, rule });
    }
  };
  for (const item of cases) {
    const config = item.caps ? { ...nook, inputs: { ...nook.inputs, caps: Object.fromEntries(Object.entries(nook.inputs.caps).map(([name, cap]) => [name, { ...cap, value: item.caps?.[name] ?? cap.value }])) } } : nook;
    add(checkPrototype({ config, prototype: item.prototype }).findings, config.rules);
  }
  for (const item of renderedCases) add(checkPrototype({ config: nook, prototype: legal, snapshots: item.snapshots() }).findings, nook.rules);
  // No TSX fixture overfills a slot by count alone, so one is written here.
  add(check([ONE_ACTION], TWO_ACTIONS).findings, [ONE_ACTION]);
  return out;
}

function declarations(): { name: string; declared: EvidenceDeclaration }[] {
  return RULE_TYPES.flatMap((type) => {
    const declared = RULE_EVIDENCE[type] as EvidenceDeclaration | Readonly<Record<string, EvidenceDeclaration>>;
    if ("kind" in declared || "textOnly" in declared) return [{ name: type, declared: declared as EvidenceDeclaration }];
    return Object.entries(declared).map(([check, item]) => ({ name: `${type}/${check}`, declared: item }));
  });
}

describe("the evidence contract", () => {
  it("every rule type declares an evidence kind, or says why its findings are text only", () => {
    expect(Object.keys(RULE_EVIDENCE).sort()).toEqual([...RULE_TYPES]);
    for (const { name, declared } of declarations()) {
      if ("kind" in declared) expect(EVIDENCE_KINDS, name).toContain(declared.kind);
      else expect(declared.textOnly.length, `${name} needs a reason in words`).toBeGreaterThan(20);
    }
  });

  it("the flow and rendered families declare every check the schema accepts", () => {
    expect(Object.keys(RULE_EVIDENCE.flow).sort()).toEqual(["state-coverage", "step-budget"]);
    expect(Object.keys(RULE_EVIDENCE.rendered).sort()).toEqual(["accessible-names", "contrast", "first-view", "headings", "no-sideways-scroll", "target-size"]);
  });

  it("every evidence kind is declared by some rule type", () => {
    const used = new Set(declarations().flatMap(({ declared }) => ("kind" in declared ? [declared.kind] : [])));
    expect([...used].sort()).toEqual([...EVIDENCE_KINDS].sort());
  });

  const found = fixtureFindings();

  it("a finding carries only the kind its rule type declares", () => {
    for (const { finding, rule } of found) {
      const declared = evidenceFor(rule);
      if (finding.evidence) expect("kind" in declared ? declared.kind : `text only (${rule.id})`, `${rule.id}: ${finding.message}`).toBe(finding.evidence.kind);
    }
  });

  it("every declared kind is carried by a finding of that rule type in the Nook fixtures", () => {
    for (const { name, declared } of declarations()) {
      if (!("kind" in declared)) continue;
      const [type, checkName] = name.split("/");
      const carried = found.some(({ finding, rule }) => rule.type === type && (checkName === undefined || ("check" in rule && rule.check === checkName)) && finding.evidence?.kind === declared.kind);
      expect(carried, `no fixture finding of ${name} carries ${declared.kind}`).toBe(true);
    }
  });

  it("a rule a proposal could add gets its type's evidence with no code of its own", () => {
    const rule: RuleSpec = { type: "count", id: "one-toast", scope: "page", select: { component: "Text.Root" }, max: 1 };
    const report = check([rule], { "pages/home.tsx": `${HEADER}export function Home() { return <Slot name="body"><Text.Root as="p">a</Text.Root><Text.Root as="p">b</Text.Root></Slot>; }` });
    expect(report.findings[0]?.evidence).toEqual({ kind: "count-vs-cap", count: 2, cap: 1, bound: "max", unit: expect.any(String) });
  });
});

function evidenceOf(snapshots: RenderedSnapshot[], rule: string): Evidence | undefined {
  return checkPrototype({ config: nook, prototype: legal, snapshots }).findings.find((finding) => finding.rule === rule)?.evidence;
}

const renderedCase = (name: string) => renderedCases.find((item) => item.name === name)?.snapshots() ?? [];

describe("evidence on rendered findings", () => {
  it("target size: the box, the minimum, and the first neighbour the circle meets", () => {
    const report = checkPrototype({ config: nook, prototype: legal, snapshots: renderedCase("small-targets-side-by-side") });
    const [help, map] = report.findings.filter((finding) => finding.rule === "target-size");
    expect(help?.evidence).toEqual({ kind: "box-with-neighbour", name: "Help", role: "link", box: { x: 280, y: 170, width: 12, height: 12 }, min: 24, neighbour: { element: expect.any(Number), name: "Map", role: "link", box: { x: 296, y: 170, width: 12, height: 12 }, meets: "in-circle" } });
    expect(map?.evidence).toMatchObject({ neighbour: { name: "Help" } });
    // The neighbour's index points at the neighbour in the same snapshot.
    const snapshot = renderedCase("small-targets-side-by-side").find((item) => item.scenario === help?.scenario && item.view === help?.view);
    const neighbour = help?.evidence?.kind === "box-with-neighbour" ? help.evidence.neighbour : undefined;
    expect(snapshot?.elements[neighbour?.element ?? -1]?.name).toBe("Map");
  });

  it("target size: two undersized controls whose circles overlap say so", () => {
    const snapshots = legalSnapshots().map((snapshot) =>
      snapshot.scenario === "rooms-list" && snapshot.view === "desktop"
        ? { ...snapshot, elements: [...snapshot.elements, button("A", { x: 280, y: 600, width: 10, height: 10 }), button("B", { x: 298, y: 600, width: 10, height: 10 })] }
        : snapshot,
    );
    expect(evidenceOf(snapshots, "target-size")).toMatchObject({ neighbour: { name: "B", meets: "circles-meet" } });
  });

  it("contrast: the flattened pair, the ratio, what it needs and the view's scheme", () => {
    expect(evidenceOf(renderedCase("faint-text"), "text-contrast")).toEqual({ kind: "colour-pair", text: "Pick a free room to book or hold.", foreground: "#a1a1aa", background: "#ffffff", ratio: 2.56, needs: 4.5, px: 16, weight: 400, scheme: "light" });
  });

  it("contrast: a dark view's finding says dark", () => {
    const config = { ...nook, views: [...nook.views, { name: "phone-dark", width: 390, height: 844, scheme: "dark" as const }] };
    const dark = legalSnapshots()
      .filter((snapshot) => snapshot.view === "phone")
      .map((snapshot) => ({ ...snapshot, view: "phone-dark", canvas: [18, 18, 18, 1] as const, elements: snapshot.elements.map((element) => (element.text ? { ...element, text: { ...element.text, color: [120, 120, 120, 1] as const, backgrounds: [] } } : element)) }));
    const report = checkPrototype({ config, prototype: legal, snapshots: [...legalSnapshots(), ...dark] });
    const finding = report.findings.find((item) => item.rule === "text-contrast" && item.view === "phone-dark");
    expect(finding?.evidence).toMatchObject({ kind: "colour-pair", scheme: "dark", background: "#121212" });
  });

  it("headings: the outline, the heading out of order, the one it follows and the level left out", () => {
    const evidence = evidenceOf(renderedCase("skipped-heading-level"), "heading-structure");
    expect(evidence).toEqual({
      kind: "sequence-gap",
      items: [
        { level: 1, text: "Rooms", shown: true },
        { level: 3, text: "Lantern", shown: true },
        { level: 2, text: "Harbor", shown: true },
      ],
      problem: "skipped",
      at: 1,
      after: 0,
      missing: [2],
    });
    expect(evidenceOf(renderedCase("second-h1"), "heading-structure")).toMatchObject({ problem: "second-first", at: 1 });
  });

  it("headings: a page with no title has an outline and no place", () => {
    const snapshots = legalSnapshots().map((snapshot) => (snapshot.scenario === "rooms-list" && snapshot.view === "phone" ? { ...snapshot, elements: snapshot.elements.map((element) => (element.headingLevel === 1 ? heading(2, element.name, element.rect) : element)) } : snapshot));
    const evidence = evidenceOf(snapshots, "heading-structure");
    expect(evidence).toMatchObject({ kind: "sequence-gap", problem: "no-first" });
    expect(evidence && "at" in evidence).toBe(false);
  });

  it("first view: the fold, the action's top and bottom, and the page's height when it was measured", () => {
    expect(evidenceOf(renderedCase("primary-below-the-fold"), "rank-1-in-first-view")).toEqual({ kind: "region-line", axis: "y", line: 844, from: 900, to: 944, box: { x: 16, y: 900, width: 358, height: 44 }, view: { width: 390, height: 844 } });
    const tall = renderedCase("primary-below-the-fold").map((snapshot) => ({ ...snapshot, scrollHeight: 1200 }));
    expect(evidenceOf(tall, "rank-1-in-first-view")).toMatchObject({ pageHeight: 1200 });
  });

  it("sideways scroll: the view's edge and the page's width", () => {
    expect(evidenceOf(renderedCase("sideways-scroll"), "no-sideways-scroll")).toEqual({ kind: "region-line", axis: "x", line: 390, from: 390, to: 520, view: { width: 390, height: 844 } });
  });

  it("a snapshot's page height changes no verdict and no message", () => {
    for (const item of renderedCases) {
      const plain = checkPrototype({ config: nook, prototype: legal, snapshots: item.snapshots() });
      const tall = checkPrototype({ config: nook, prototype: legal, snapshots: item.snapshots().map((snapshot) => ({ ...snapshot, scrollHeight: 2000 })) });
      const words = (findings: readonly Finding[]) => findings.map(({ evidence: _evidence, ...rest }) => rest);
      expect(words(tall.findings)).toEqual(words(plain.findings));
      expect(tall.status).toBe(plain.status);
    }
  });
});

describe("evidence on structural and flow findings", () => {
  const evidenceIn = (name: string, rule: string) => {
    const item = cases.find((entry) => entry.name === name);
    if (!item) throw new Error(`no case ${name}`);
    const config = item.caps ? { ...nook, inputs: { ...nook.inputs, caps: Object.fromEntries(Object.entries(nook.inputs.caps).map(([cap, value]) => [cap, { ...value, value: item.caps?.[cap] ?? value.value }])) } } : nook;
    return checkPrototype({ config, prototype: item.prototype }).findings.find((finding) => finding.rule === rule)?.evidence;
  };

  it("count: the count and the cap as numbers", () => {
    expect(evidenceIn("two-questions", "visible-questions")).toEqual({ kind: "count-vs-cap", count: 2, cap: 1, bound: "max", unit: expect.stringContaining("question") });
    expect(evidenceIn("two-disclosures", "disclosures-per-page")).toMatchObject({ count: 2, cap: 1, bound: "max" });
    expect(evidenceIn("missing-disclosed-section", "disclosed-sections")).toMatchObject({ count: 0, cap: 1, bound: "min" });
  });

  it("slot and nesting depth: counts against their caps too", () => {
    expect(evidenceIn("extra-in-primary-slot", "primary-slot")).toBeUndefined();
    expect(evidenceIn("nested-disclosure", "disclosure-depth")).toMatchObject({ kind: "count-vs-cap", count: 2, cap: 1, bound: "max" });
    const report = check([ONE_ACTION], TWO_ACTIONS);
    expect(report.findings[0]?.evidence).toMatchObject({ kind: "count-vs-cap", count: 2, cap: 1, bound: "max" });
  });

  it("step budget: the longest route step by step, and the budget", () => {
    const evidence = evidenceIn("route-over-budget", "step-budget");
    expect(evidence).toMatchObject({ kind: "route-vs-budget", task: "hold-room", success: "held", budget: 2 });
    if (evidence?.kind !== "route-vs-budget") throw new Error("no route evidence");
    expect(evidence.route.length).toBe(evidence.steps);
    for (const step of evidence.route) expect(evidence.transitions).toContainEqual(step);
    expect(evidence.transitions.length).toBeGreaterThan(evidence.route.length);
    expect(evidence.steps).toBeGreaterThan(evidence.budget);
    expect(evidence.route[0]?.from).toBe(evidence.start);
    expect(evidence.route.at(-1)?.to).toBe(evidence.success);
    evidence.route.slice(1).forEach((step, index) => expect(step.from).toBe(evidence.route[index]?.to));
  });

  it("state coverage: the state with no scenario, among the flow's states", () => {
    expect(evidenceIn("state-without-scenario", "state-coverage")).toMatchObject({ kind: "coverage", scenarios: 0 });
  });
});

describe("facts for pictures of a whole page or flow", () => {
  it("target facts list every control, and the ones that fail are exactly the rule's findings", () => {
    for (const item of renderedCases) {
      const snapshots = item.snapshots();
      const report = checkPrototype({ config: nook, prototype: legal, snapshots });
      for (const snapshot of snapshots) {
        const view = nook.views.find((entry) => entry.name === snapshot.view);
        if (!view) throw new Error("no view");
        const facts = viewFacts(nook, view, snapshot);
        const here = (rule: string) => report.findings.filter((finding) => finding.rule === rule && finding.scenario === snapshot.scenario && finding.view === snapshot.view);
        expect(facts.targets?.controls.filter((control) => control.status === "fails").map((control) => control.element)).toEqual(here("target-size").map((finding) => finding.element));
        expect(facts.targets?.controls.length).toBe(snapshot.elements.filter((element) => element.visible && element.interactive).length);
        expect(facts.fold.action?.controls.filter((control) => control.below).map((control) => control.element) ?? []).toEqual(here("rank-1-in-first-view").map((finding) => finding.element));
        expect(facts.edge.overflow > 0).toBe(here("no-sideways-scroll").length > 0);
      }
    }
  });

  it("an undersized control far from any other is spaced, and an inline link is exempt", () => {
    const snapshot = legalSnapshots()[0] as RenderedSnapshot;
    const lone = { ...button("Lone", { x: 900, y: 700, width: 12, height: 12 }) };
    const inline = { role: "link", name: "terms", tag: "a", rect: { x: 600, y: 700, width: 30, height: 12 }, interactive: true, visible: true, inline: true };
    const view = nook.views[0];
    if (!view) throw new Error("no view");
    const facts = viewFacts(nook, view, { ...snapshot, elements: [...snapshot.elements, lone, inline] });
    expect(facts.targets?.controls.slice(-2).map((control) => control.status)).toEqual(["spaced", "inline"]);
    expect(facts.targets?.min).toBe(24);
  });

  it("the fold lists what ends below it, and the edge what crosses it", () => {
    const base = legalSnapshots().find((snapshot) => snapshot.scenario === "rooms-list" && snapshot.view === "phone") as RenderedSnapshot;
    const view = nook.views[1];
    if (!view) throw new Error("no view");
    const wide = text("A very long line", { x: 16, y: 860, width: 500, height: 24 });
    const facts = viewFacts(nook, view, { ...base, scrollWidth: 516, scrollHeight: 1100, elements: [...base.elements, wide] });
    expect(facts.fold).toMatchObject({ line: 844, pageHeight: 1100, below: [base.elements.length] });
    expect(facts.edge).toEqual({ line: 390, scrollWidth: 516, overflow: 126, crossing: [base.elements.length] });
    expect(viewFacts(nook, view, base).edge).toMatchObject({ overflow: 0, crossing: [] });
  });

  it("with no target-size rule in force there are no target facts", () => {
    const view = nook.views[0];
    if (!view) throw new Error("no view");
    expect(viewFacts(configWith([]), view, legalSnapshots()[0] as RenderedSnapshot).targets).toBeUndefined();
  });

  it("flow facts: each task's longest route and whether it fits, agreeing with the step-budget rule", () => {
    const facts = flowFacts(nook, legal);
    expect(facts.tasks.map((task) => [task.task, task.status, task.budget])).toEqual([
      ["book-room", "fits", 3],
      ["hold-room", "fits", 2],
    ]);
    for (const task of facts.tasks) expect(task.longest?.length).toBeLessThanOrEqual(task.budget);
    expect(facts.states.map((item) => item.state)).toEqual(legal.flow.states);
    expect(facts.states.every((item) => item.scenarios.length > 0)).toBe(true);
    for (const item of cases) {
      const report = checkPrototype({ config: nook, prototype: item.prototype });
      const over = flowFacts(nook, item.prototype).tasks.filter((task) => task.status === "over").map((task) => task.task);
      const said = report.findings.flatMap((finding) => (finding.evidence?.kind === "route-vs-budget" ? [finding.evidence.task] : []));
      expect(over, item.name).toEqual(said);
      const uncovered = flowFacts(nook, item.prototype).states.filter((state) => state.scenarios.length === 0).map((state) => state.state).sort();
      expect(uncovered, item.name).toEqual(report.findings.flatMap((finding) => (finding.evidence?.kind === "coverage" ? [finding.evidence.state] : [])));
    }
  });

  it("flow facts say when a task is not modeled", () => {
    expect(flowFacts(nook, prototype({})).tasks.map((task) => task.status)).toEqual(["not-modeled", "not-modeled"]);
  });
});
