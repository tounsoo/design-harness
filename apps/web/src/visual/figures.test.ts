import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EVIDENCE_KINDS, RULE_EVIDENCE, RULE_TYPES, checkPrototype, type Evidence, type EvidenceDeclaration, type Finding } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { renderedCases } from "../../../../packages/core/examples/nook/rendered-cases";
import { seedLegal } from "../../test/nook";
import { EvidenceFigure, FIGURES } from "./figures";

const legal = seedLegal();

/** Every evidence kind a rule type in core's vocabulary declares. */
function declaredKinds(): string[] {
  const kinds = new Set<string>();
  for (const type of RULE_TYPES) {
    const declared = RULE_EVIDENCE[type] as EvidenceDeclaration | Readonly<Record<string, EvidenceDeclaration>>;
    const list = "kind" in declared || "textOnly" in declared ? [declared as EvidenceDeclaration] : Object.values(declared);
    for (const item of list) if ("kind" in item) kinds.add(item.kind);
  }
  return [...kinds].sort();
}

const SAMPLES: { readonly [K in Evidence["kind"]]: Extract<Evidence, { kind: K }> } = {
  "box-with-neighbour": { kind: "box-with-neighbour", name: "Help", role: "link", box: { x: 280, y: 170, width: 12, height: 12 }, min: 24, neighbour: { element: 9, name: "Map", role: "link", box: { x: 296, y: 170, width: 12, height: 12 }, meets: "in-circle" } },
  "colour-pair": { kind: "colour-pair", text: "Pick a free room", foreground: "#a1a1aa", background: "#ffffff", ratio: 2.56, needs: 4.5, px: 16, weight: 400, scheme: "light" },
  "sequence-gap": { kind: "sequence-gap", items: [{ level: 1, text: "Rooms", shown: true }, { level: 3, text: "Lantern", shown: true }], problem: "skipped", at: 1, after: 0, missing: [2] },
  "count-vs-cap": { kind: "count-vs-cap", count: 2, cap: 1, bound: "max", unit: "primary actions" },
  "region-line": { kind: "region-line", axis: "y", line: 844, from: 900, to: 944, box: { x: 16, y: 900, width: 358, height: 44 }, view: { width: 390, height: 844 } },
  "route-vs-budget": { kind: "route-vs-budget", task: "hold-room", start: "rooms", success: "held", route: [{ from: "rooms", event: "open", to: "room-open" }, { from: "room-open", event: "book", to: "booked" }, { from: "booked", event: "hold", to: "held" }], steps: 3, budget: 2, transitions: [{ from: "booked", event: "hold", to: "held" }, { from: "room-open", event: "book", to: "booked" }, { from: "room-open", event: "hold", to: "held" }, { from: "rooms", event: "open", to: "room-open" }] },
  coverage: { kind: "coverage", state: "pick-time", scenarios: 0, covered: 4, states: 5 },
};

const finding = (evidence?: Evidence, extra: Partial<Finding> = {}): Finding => ({ rule: "r", kind: "violation", message: "Core's exact words.", ...(evidence ? { evidence } : {}), ...extra });
const draw = (item: Finding, findings: readonly Finding[] = [item]) => renderToStaticMarkup(createElement(EvidenceFigure, { finding: item, findings, children: createElement("p", null, item.message) }));

describe("the figure registry", () => {
  it("has one figure for every evidence kind core has, and no other", () => {
    expect(Object.keys(FIGURES).sort()).toEqual([...EVIDENCE_KINDS].sort());
    for (const kind of EVIDENCE_KINDS) expect(typeof FIGURES[kind].Figure, kind).toBe("function");
  });

  it("covers every kind a rule type in core's vocabulary declares", () => {
    for (const kind of declaredKinds()) expect(Object.keys(FIGURES), `no figure is registered for ${kind}`).toContain(kind);
  });

  for (const kind of EVIDENCE_KINDS) {
    it(`${kind}: draws, with core's message word for word as its caption`, () => {
      const html = draw(finding(SAMPLES[kind]));
      expect(html).toContain(`data-evidence="${kind}"`);
      expect(html).toContain("<figcaption");
      expect(html).toContain("<p>Core&#x27;s exact words.</p>");
    });

    it(`${kind}: every drawing is hidden from a screen reader or has a role and a name`, () => {
      const html = draw(finding(SAMPLES[kind]));
      for (const svg of html.match(/<svg[^>]*>/g) ?? []) expect(svg.includes('aria-hidden="true"') || /role="img"[^>]*aria-label="[^"]+"|aria-label="[^"]+"[^>]*role="img"/.test(svg), svg).toBe(true);
    });
  }
});

describe("what each figure says", () => {
  it("target size names the neighbour and the scale it is shown at", () => {
    const html = draw(finding(SAMPLES["box-with-neighbour"]));
    expect(html).toContain('data-testid="figure-neighbour"');
    expect(html).toMatch(/Shown at \d+(\.\d+)?×/);
    expect(html).toContain("its 24 px circle");
    expect(html).toContain("where it meets &quot;Map&quot;");
  });

  it("contrast shows the text in its measured colours, once for each scheme its findings cover", () => {
    const light = finding(SAMPLES["colour-pair"], { scenario: "rooms-list", view: "phone" });
    const dark = finding({ ...SAMPLES["colour-pair"], scheme: "dark", foreground: "#52525b", background: "#121212", ratio: 2.31 }, { scenario: "rooms-list", view: "phone-dark" });
    const other = finding({ ...SAMPLES["colour-pair"], text: "Another line", scheme: "dark" }, { scenario: "rooms-list", view: "phone-dark" });
    const html = draw(light, [light, { ...light, view: "desktop" }, dark, other]);
    expect(html.match(/data-testid="figure-contrast-row"/g)).toHaveLength(2);
    expect(html).toContain("2.56:1");
    expect(html).toContain("2.31:1");
    expect(html).toContain("color:#a1a1aa;background:#ffffff");
    expect(html).toContain("color:#52525b;background:#121212");
    expect(html).toContain("AA 4.5:1");
    expect(html).not.toContain("Another line");
  });

  it("headings show the skipped level as an empty row above the heading that skips it", () => {
    const html = draw(finding(SAMPLES["sequence-gap"]));
    expect(html.indexOf('data-testid="figure-gap"')).toBeGreaterThan(html.indexOf("Rooms"));
    expect(html.indexOf('data-testid="figure-gap"')).toBeLessThan(html.indexOf("Lantern"));
    expect(html).toContain("skips a level");
  });

  it("a count names itself to a screen reader, and marks what is past the limit", () => {
    const html = draw(finding(SAMPLES["count-vs-cap"]));
    expect(html).toContain('role="img" aria-label="2, at most 1 primary actions"');
    expect(html.match(/data-pip="over"/g)).toHaveLength(1);
  });

  it("a route's map numbers each step, marks the one past the budget, and lists the same steps in words", () => {
    const html = draw(finding(SAMPLES["route-vs-budget"]));
    expect(html.match(/data-testid="flow-step"/g)).toHaveLength(3);
    expect(html.match(/data-testid="flow-step" data-over=""/g)).toHaveLength(1);
    expect(html).toContain('data-testid="flow-limit"');
    expect(html).toContain("3 steps on the longest route, budget 2");
    expect(html).toContain("past the budget of 2");
  });
});

describe("the fallback", () => {
  it("a finding with no evidence and no element stands as its message alone", () => {
    expect(draw(finding())).toBe("<p>Core&#x27;s exact words.</p>");
  });

  it("a finding with an element in a measured snapshot gets its outline, and a rule found in several places a count", () => {
    const report = checkPrototype({ config: nook, prototype: legal, snapshots: renderedCases.find((item) => item.name === "unnamed-control")?.snapshots() ?? [] });
    const found = report.findings.find((item) => item.rule === "accessible-names");
    if (!found) throw new Error("no finding");
    const snapshot = renderedCases.find((item) => item.name === "unnamed-control")?.snapshots().find((item) => item.scenario === found.scenario && item.view === found.view);
    const view = nook.views.find((item) => item.name === found.view);
    const html = renderToStaticMarkup(createElement(EvidenceFigure, { finding: found, findings: [found, found, found], snapshot, view, children: createElement("p", null, found.message) }));
    expect(html).toContain('data-evidence="fallback"');
    expect(html).toContain('data-testid="figure-outline-fallback"');
    expect(html).toContain('aria-label="Found in 3 places"');
    expect(html).toContain("has no accessible name.");
  });
});
