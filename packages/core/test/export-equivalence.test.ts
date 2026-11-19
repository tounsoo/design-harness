import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nook } from "../examples/nook/project";
import { checkPrototype } from "../src/engine/check";
import type { CheckReport } from "../src/engine/report";
import { specToTsx } from "../src/export/tsx";
import type { Prototype } from "../src/prototype/types";
import { EXAMPLES, loadCases, loadPrototype, type IllegalCase } from "./fixtures";

/**
 * Code export must be checkable: the TSX a spec prototype exports, read back
 * as a TSX prototype with the same manifest, gives the same report as the
 * spec. Rule ids and each rule's status must match, and so must each rule's
 * findings by kind (violation or unverifiable) and count. Messages are not
 * compared: they name the file and line a finding is at, and the spec's
 * are JSON files where the export's are TSX.
 *
 * It holds for the legal Nook spec and for every illegal spec fixture core
 * reads whole. It cannot hold where the spec's own `extract` rule fails:
 * what the catalog refused is left out of the export, so the TSX has
 * nothing left to refuse (`EXTRACT_ONLY` lists those cases).
 */

const SPEC = join(EXAMPLES, "spec");
const legal = loadPrototype(join(SPEC, "legal", "booking"));

function shape(report: CheckReport): Record<string, { status: string; findings: string[] }> {
  return Object.fromEntries(report.rules.map((rule) => [rule.rule, { status: rule.status, findings: rule.findings.map((finding) => finding.kind).sort() }]));
}

function configFor(item: IllegalCase) {
  return item.caps ? { ...nook, inputs: { ...nook.inputs, caps: Object.fromEntries(Object.entries(nook.inputs.caps).map(([name, cap]) => [name, { ...cap, value: item.caps?.[name] ?? cap.value }])) } } : nook;
}

function exported(prototype: Prototype, config = nook): Prototype {
  const result = specToTsx(prototype, config);
  if (!result.ok) throw new Error(result.error);
  return result.value.prototype;
}

describe("the legal Nook spec, exported as TSX", () => {
  const tsx = exported(legal);

  it("is one TSX file per page and layout, with the spec's manifest", () => {
    expect(Object.keys(tsx.files).sort()).toEqual(["layouts/room-cards.tsx", "layouts/room-details.tsx", "layouts/select-question.tsx", "pages/booking.tsx", "pages/rooms.tsx"]);
    expect(tsx.format).toBe("tsx");
    expect(tsx.scenarios).toEqual(legal.scenarios);
    expect(tsx.flow).toEqual(legal.flow);
    expect(tsx.pages.map((page) => [page.id, page.pageType, page.component.file])).toEqual(legal.pages.map((page) => [page.id, page.pageType, page.component.file.replace(/\.json$/, ".tsx")]));
  });

  it("gives the same report as the spec: every rule passes", () => {
    const spec = checkPrototype({ config: nook, prototype: legal });
    const back = checkPrototype({ config: nook, prototype: tsx });
    expect(back.findings).toEqual([]);
    expect(shape(back)).toEqual(shape(spec));
  });

  it("writes code a person would: imports from the library, React and the page kit only", () => {
    for (const [path, text] of Object.entries(tsx.files)) {
      const specifiers = [...text.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
      for (const specifier of specifiers) expect(["react", "@tounsoo/todae", "@design-harness/page"].includes(specifier as string) || (specifier as string).startsWith("."), `${path} imports ${specifier}`).toBe(true);
    }
    expect(tsx.files["pages/booking.tsx"]).toContain('{state === "booked" && <Text.Root as="p">Booked until 3 pm</Text.Root>}');
    expect(tsx.files["pages/booking.tsx"]).toContain("const [duration, setDuration] = useState(\"30\");");
    expect(tsx.files["layouts/select-question.tsx"]).toContain("onAnswerChange");
  });

  it("is deterministic", () => {
    expect(exported(legal)).toEqual(tsx);
  });
});

/** Cases whose named rule is extract: the catalog refused part of the spec, and the export leaves it out. */
const EXTRACT_ONLY = new Set<string>();

describe("each illegal Nook spec gives the same report once exported", () => {
  const cases = loadCases(legal, join(SPEC, "illegal"));
  for (const item of cases) {
    const config = configFor(item);
    const spec = checkPrototype({ config, prototype: item.prototype });
    const refused = spec.rules.find((rule) => rule.rule === "extract")?.status === "fail";
    if (refused) EXTRACT_ONLY.add(item.name);
    it(`${item.name}${refused ? " (extract fails: the export cannot carry what was refused)" : ""}`, () => {
      const back = checkPrototype({ config, prototype: exported(item.prototype, config) });
      if (refused) {
        // What the catalog refused is not in the export; every other rule still agrees.
        const { extract: _spec, ...rest } = shape(spec);
        const { extract: _back, ...again } = shape(back);
        expect(again).toEqual(rest);
        return;
      }
      expect(shape(back), JSON.stringify(back.findings, null, 1)).toEqual(shape(spec));
    });
  }
});

describe("a spec with actions, conditions, templates and repeats, exported", () => {
  // The booking page, with a Hold button that changes the page's state, a list the page draws by index, and text that depends on both.
  const spec = JSON.parse(legal.files["pages/booking.json"] as string) as { elements: Record<string, Record<string, unknown>>; state: Record<string, unknown> };
  spec.elements.hold = { type: "Button.Root", props: { variant: "secondary", text: { $cond: { $state: "/held" }, $then: "Held", $else: "Hold room" } }, on: { press: [{ action: "setState", params: { statePath: "/held", value: true } }, { action: "pushState", params: { statePath: "/log", value: "held" } }] }, children: [] };
  spec.elements["held-note"] = { type: "Text.Root", props: { as: "p", text: { $template: "Held for ${/minutes} minutes" } }, visible: [{ $state: "/scenario/state", eq: "held" }, { $state: "/minutes", gt: 5 }], children: [] };
  spec.elements.notes = { type: "Stack.Root", props: { gap: "condensed" }, repeat: { statePath: "/notes" }, visible: { $state: "/quiet", not: true }, children: ["note"] };
  spec.elements.note = { type: "Text.Root", props: { as: "p", text: { $template: "${/room/name}: ${title}" } }, children: [] };
  (spec.elements.page as { slots: Record<string, string[]> }).slots.facts!.push("notes");
  spec.state = { ...spec.state, held: false, log: [], minutes: 10, quiet: false, notes: [{ title: "Quiet room" }, { title: "No food" }] };
  const prototype = { ...legal, files: { ...legal.files, "pages/booking.json": JSON.stringify(spec) } };
  const tsx = exported(prototype);
  const page = tsx.files["pages/booking.tsx"] as string;

  it("writes state the page changes as useState, and the actions as its setters", () => {
    expect(page).toContain("const [held, setHeld] = useState(false);");
    expect(page).toContain("const [log, setLog] = useState<string[]>([]);");
    expect(page).toContain("onClick={() => { setHeld(true); setLog([...log, \"held\"]); }}");
    expect(page).toContain('{held ? "Held" : "Hold room"}');
    expect(page).toContain('{state === "held" && minutes > 5 && <Text.Root as="p">Held for {minutes} minutes</Text.Root>}');
    expect(page).toContain("{!quiet && (");
    expect(page).toContain("{notes.map((note, index) => <Text.Root key={index} as=\"p\">{room.name}: {note.title}</Text.Root>)}");
  });

  it("gives the same report as the spec", () => {
    const fromSpec = checkPrototype({ config: nook, prototype });
    const back = checkPrototype({ config: nook, prototype: tsx });
    expect(back.rules.find((rule) => rule.rule === "extract")?.findings).toEqual([]);
    expect(shape(back)).toEqual(shape(fromSpec));
  });
});

describe("each refused Nook spec, exported, agrees on every rule but extract", () => {
  for (const item of loadCases(legal, join(SPEC, "refused"))) {
    it(item.name, () => {
      const { extract: _spec, ...spec } = shape(checkPrototype({ config: nook, prototype: item.prototype }));
      const { extract: _back, ...back } = shape(checkPrototype({ config: nook, prototype: exported(item.prototype) }));
      expect(back).toEqual(spec);
    });
  }
});
