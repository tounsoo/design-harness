import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nook } from "../examples/nook/project";
import { checkPrototype } from "../src/engine/check";
import { formatSpec } from "../src/spec/format";
import type { JsonValue } from "../src/spec/json";
import { recombine } from "../src/variants/recombine";
import { CURRENT } from "../src/variants/types";
import { checkVariant, nextVariantIds, parseVariantState, variantLabel, withPageSpec } from "../src/variants/variants";
import { EXAMPLES, loadPrototype } from "./fixtures";

/**
 * Variants of a spec page and recombining them slot by slot: what a variant
 * may be, and that recombination is a pure, deterministic function whose
 * result keeps element keys, ids and state apart and is checked like any
 * other page.
 */

const legal = loadPrototype(join(EXAMPLES, "spec", "legal", "booking"));
const BOOKING = "pages/booking.json";
type Spec = { root: string; elements: Record<string, Record<string, JsonValue>>; state?: Record<string, JsonValue> };
const base = (): Spec => JSON.parse(legal.files[BOOKING] as string) as Spec;
const text = (spec: Spec) => formatSpec(spec as unknown as JsonValue);

/** B: the question asks something else, and the title has an id. */
function variantB(): Spec {
  const spec = base();
  (spec.elements.question!.props as Record<string, JsonValue>).label = "For how long?";
  (spec.elements.name!.props as Record<string, JsonValue>).id = "heading";
  return spec;
}

/** C: the room is Harbor, the facts carry the same id as B's title, and the primary action is keyed "question", as B's body is. */
function variantC(): Spec {
  const spec = base();
  spec.state!.room = { id: "harbor", name: "Harbor", seats: 10, floor: "Ground floor", details: ["Video call kit"] };
  (spec.elements.seats!.props as Record<string, JsonValue>).id = "heading";
  const page = spec.elements.page as { slots: Record<string, string[]> };
  const question = spec.elements.question;
  spec.elements.ask = question!;
  delete spec.elements.question;
  page.slots.body = ["ask", "details"];
  spec.elements.question = spec.elements.book!;
  delete spec.elements.book;
  page.slots.action = ["question"];
  return spec;
}

/** The same spec with its elements, state and slots written in reverse order. */
function reversed(spec: Spec): Spec {
  const flip = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).reverse());
  const elements = flip(spec.elements);
  for (const element of Object.values(elements)) {
    if (element.props && typeof element.props === "object" && !Array.isArray(element.props)) element.props = flip(element.props as Record<string, JsonValue>);
    if (element.slots && typeof element.slots === "object") element.slots = flip(element.slots as Record<string, JsonValue>);
  }
  return { ...(spec.state ? { state: flip(spec.state) } : {}), elements, root: spec.root };
}

const sources = () => ({ [CURRENT]: legal.files[BOOKING] as string, b: text(variantB()), c: text(variantC()) });
const picks = { title: "b", facts: "c", body: "b", alternate: CURRENT, action: "c" };

describe("a variant", () => {
  it("is a whole page the catalog accepts; it may break a rule, and the checks show it", () => {
    const spec = base();
    (spec.elements.hold!.props as Record<string, JsonValue>).variant = "primary";
    const checked = checkVariant(legal, nook, "booking", JSON.stringify(spec));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value).toBe(text(spec));
    const report = checkPrototype({ config: nook, prototype: withPageSpec(legal, "booking", checked.value) });
    expect(report.rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule)).toContain("one-primary-per-page");
  });

  it("is refused, with core's words, when the catalog refuses any part of it", () => {
    const spec = base();
    spec.elements.free = { type: "Badge.Root", props: { text: "Free" }, children: [] };
    (spec.elements.page as { slots: Record<string, string[]> }).slots.facts!.push("free");
    const checked = checkVariant(legal, nook, "booking", JSON.stringify(spec));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.error.join("\n")).toMatch(/^pages\/booking\.json:\d+:\d+: pages\/booking\.json: element "free" is a Badge\.Root, which is not in the catalog/);
  });

  it("is refused when it does not parse, names no page of the manifest, or the prototype is TSX", () => {
    expect(checkVariant(legal, nook, "booking", "{ nope").ok).toBe(false);
    const unknown = checkVariant(legal, nook, "checkout", legal.files[BOOKING] as string);
    expect(!unknown.ok && unknown.error[0]).toMatch(/There is no page "checkout"/);
    const tsx = checkVariant({ ...legal, format: "tsx" }, nook, "booking", legal.files[BOOKING] as string);
    expect(!tsx.ok && tsx.error[0]).toMatch(/spec prototypes/);
  });

  it("is refused for a layout instance with a parameter the layout does not take", () => {
    const spec = base();
    (spec.elements.details!.props as Record<string, JsonValue>).colour = "red";
    const checked = checkVariant(legal, nook, "booking", JSON.stringify(spec));
    expect(!checked.ok && checked.error.join("\n")).toMatch(/sets "colour", which layout "room-details" does not take/);
  });

  it("gets the next unused id, never one used before", () => {
    expect(nextVariantIds([], 3)).toEqual(["a", "b", "c"]);
    expect(nextVariantIds(["a", "c"], 3)).toEqual(["b", "d", "e"]);
    expect(nextVariantIds([], 28).slice(25)).toEqual(["z", "aa", "ab"]);
    expect(variantLabel("b")).toBe("Variant B");
    expect(variantLabel(CURRENT)).toBe("Current");
  });

  it("is stored as validated data", () => {
    const state = { variants: [{ id: "b", page: "booking", note: "Asks for how long", spec: "{}" }], picks: [{ at: "2026-11-18T12:00:00.000Z", page: "booking", slots: { body: "b" }, notes: { b: "Asks for how long" }, before: "{}", after: "{}" }] };
    expect(parseVariantState(state).ok).toBe(true);
    expect(parseVariantState({ ...state, variants: [...state.variants, ...state.variants] }).ok).toBe(false);
    expect(parseVariantState({ ...state, picks: [{ ...state.picks[0], applied: true }] }).ok).toBe(false);
  });
});

describe("recombining a page slot by slot", () => {
  const result = recombine(legal, nook, "booking", sources(), picks);
  if (!result.ok) throw new Error(result.error);
  const spec = JSON.parse(result.value.spec) as Spec;

  it("takes each slot's elements, and everything under them, from its source", () => {
    const page = spec.elements[spec.root] as { slots: Record<string, string[]>; children: string[] };
    expect(Object.keys(page.slots)).toEqual(["title", "facts", "body", "alternate", "action"]);
    expect(page.children).toEqual([]);
    expect((spec.elements[page.slots.body![0]!]!.props as Record<string, JsonValue>).label).toBe("For how long?");
    expect(spec.elements[page.slots.action![0]!]!.type).toBe("Button.Root");
    expect(spec.elements.hold).toBeDefined();
    expect(result.ok && result.value.slots).toEqual(picks);
  });

  it("keeps element keys unique: a key two sources bring is named for each source", () => {
    const page = spec.elements[spec.root] as { slots: Record<string, string[]> };
    expect(page.slots.body).toEqual(["question-b", "details"]);
    expect(page.slots.action).toEqual(["question-c"]);
    const listed = Object.values(spec.elements).flatMap((element) => [...((element.children as string[]) ?? []), ...Object.values((element.slots as Record<string, string[]>) ?? {}).flat()]);
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.every((key) => key in spec.elements)).toBe(true);
  });

  it("keeps literal ids unique, and state apart where the sources disagree", () => {
    const ids = Object.values(spec.elements).flatMap((element) => (typeof (element.props as Record<string, JsonValue>)?.id === "string" && element.type !== "Layout" ? [(element.props as Record<string, string>).id] : []));
    expect(ids.sort()).toEqual(["heading-b", "heading-c"]);
    expect(Object.keys(spec.state ?? {}).sort()).toEqual(["duration", "durations", "room-b", "room-c"]);
    expect(JSON.stringify(spec.elements.seats)).toContain("${/room-c/seats}");
    expect(result.ok && result.value.renamed.map((item) => `${item.kind}:${item.source}:${item.from}->${item.to}`)).toEqual([
      "element:b:question->question-b",
      "element:c:question->question-c",
      "id:b:heading->heading-b",
      "id:c:heading->heading-c",
      "state:b:room->room-b",
      "state:c:room->room-c",
    ]);
  });

  it("is checked like any other page, and this one passes every rule", () => {
    const report = checkPrototype({ config: nook, prototype: result.ok ? result.value.prototype : legal });
    expect(report.findings).toEqual([]);
  });

  it("is deterministic: the same text whatever order the sources, the picks and each file's keys come in", () => {
    const shuffledSources = Object.fromEntries(Object.entries({ c: text(reversed(variantC())), [CURRENT]: text(reversed(JSON.parse(legal.files[BOOKING] as string) as Spec)), b: text(reversed(variantB())) }));
    const shuffledPicks = Object.fromEntries(Object.entries(picks).reverse());
    const again = recombine(legal, nook, "booking", shuffledSources, shuffledPicks);
    expect(again.ok && again.value.spec).toBe(result.ok && result.value.spec);
  });

  it("gives back one source whole when every slot comes from it", () => {
    const whole = recombine(legal, nook, "booking", sources(), { title: "b", facts: "b", body: "b", alternate: "b", action: "b" });
    expect(whole.ok).toBe(true);
    if (!whole.ok) return;
    expect(JSON.parse(whole.value.spec)).toEqual(JSON.parse(text(variantB())));
    expect(whole.value.renamed).toEqual([]);
    const current = recombine(legal, nook, "booking", sources(), { title: CURRENT, facts: CURRENT, body: CURRENT, alternate: CURRENT, action: CURRENT });
    expect(current.ok && JSON.parse(current.value.spec)).toEqual(JSON.parse(legal.files[BOOKING] as string));
  });

  it("refuses a slot with no pick, a slot the page type lacks, and a source not given", () => {
    const { action: _action, ...short } = picks;
    expect(recombine(legal, nook, "booking", sources(), short)).toEqual({ ok: false, error: 'Say where slot "action" comes from.' });
    expect(recombine(legal, nook, "booking", sources(), { ...picks, sidebar: "b" })).toEqual({ ok: false, error: 'A booking page has no slot "sidebar".' });
    expect(recombine(legal, nook, "booking", sources(), { ...picks, body: "d" })).toEqual({ ok: false, error: 'No source "d" was given.' });
  });
});
