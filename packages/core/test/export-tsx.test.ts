import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nook } from "../examples/nook/project";
import { checkPrototype } from "../src/engine/check";
import { specToTsx } from "../src/export/tsx";
import { parsePrototype } from "../src/parse";
import type { Prototype, TsxPrototype } from "../src/prototype/types";
import { EXAMPLES, loadCases, loadPrototype } from "./fixtures";

/**
 * Code export writes a spec prototype as the TSX a person would write, one
 * file per page and layout with the spec's manifest. Core no longer reads
 * TSX, so the export is not checked back against the spec's report: these
 * tests hold what it writes, and the end-to-end test "code export builds"
 * builds it with Vite and TypeScript.
 */

const SPEC = join(EXAMPLES, "spec");
const legal = loadPrototype(join(SPEC, "legal", "booking"));

function exported(prototype: Prototype, config = nook): TsxPrototype {
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

  it("is TSX core refuses to read back, handed over as it is", () => {
    const back = parsePrototype(tsx);
    expect(back.ok).toBe(false);
    if (back.ok || !("tsx" in back)) throw new Error("expected a TSX refusal");
    expect(back.tsx).toEqual(tsx);
    expect(back.error[0]?.path).toBe("$.format");
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

describe("each illegal Nook spec is exported", () => {
  for (const item of loadCases(legal, join(SPEC, "illegal"))) {
    it(item.name, () => {
      const tsx = exported(item.prototype);
      expect(tsx.pages.map((page) => page.id)).toEqual(item.prototype.pages.map((page) => page.id));
      expect(exported(item.prototype)).toEqual(tsx);
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

});

describe("a layout that reads its parameters in conditions and templates, exported", () => {
  // The room details, shown with the room's floor when the page asks, and a line that compares the page's seats with a parameter.
  const layout = JSON.parse(legal.files["layouts/room-details.json"] as string) as { params: Record<string, unknown>; elements: Record<string, Record<string, unknown>> };
  layout.params = { ...layout.params, floor: { type: "text", required: false }, "floor-shown": { type: "boolean", default: false }, "min-seats": { type: "number", default: 4 } };
  (layout.elements.details as { children: string[] }).children.push("floor", "big");
  layout.elements.floor = { type: "Text.Root", props: { as: "p", text: { $template: "On the ${$param:floor}" } }, visible: { $param: "floor-shown" }, children: [] };
  layout.elements.big = { type: "Text.Root", props: { as: "p", text: { $cond: { $param: "min-seats", lte: { $state: "/room/seats" } }, $then: "A big room", $else: "A small room" } }, visible: { $state: "/room/seats", gte: { $param: "min-seats" } }, children: [] };
  const page = (legal.files["pages/booking.json"] as string).replace('"items": { "$state": "/room/details" } }', '"items": { "$state": "/room/details" }, "floor": { "$state": "/room/floor" }, "floor-shown": true }');
  const prototype = { ...legal, files: { ...legal.files, "layouts/room-details.json": JSON.stringify(layout), "pages/booking.json": page } };
  const tsx = exported(prototype);

  it("writes each parameter as its prop, in a condition and in a template", () => {
    const details = tsx.files["layouts/room-details.tsx"] as string;
    expect(details).toContain("readonly floor?: string;");
    expect(details).toContain('{floorShown && <Text.Root as="p">On the {floor}</Text.Root>}');
    expect(details).toContain('{room.seats >= minSeats && <Text.Root as="p">{minSeats <= room.seats ? "A big room" : "A small room"}</Text.Root>}');
    expect(tsx.files["pages/booking.tsx"]).toContain("floorShown");
    const cards = tsx.files["layouts/room-cards.tsx"] as string;
    expect(cards).toContain('{detail === "seats" && <Text.Root as="p">{room.seats} seats</Text.Root>}');
    expect(cards).toContain('<Button.Root variant="secondary">{verb}{" "}{room.name}</Button.Root>');
  });

  it("is written from a spec that passes every rule", () => {
    expect(checkPrototype({ config: nook, prototype }).findings).toEqual([]);
  });
});

describe("each refused Nook spec, exported, leaves out what the catalog refused and says so", () => {
  for (const item of loadCases(legal, join(SPEC, "refused"))) {
    it(item.name, () => {
      const result = specToTsx(item.prototype, nook);
      if (!result.ok) throw new Error(result.error);
      expect(result.value.notes.some((note) => note.includes("Core refused") || note.includes("could not be read") || note.includes("not a page or layout"))).toBe(true);
    });
  }
});
