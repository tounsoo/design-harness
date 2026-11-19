import { describe, expect, it } from "vitest";
import { fakeHost } from "../../test/agent-host";
import { seedSpec } from "../../test/nook";
import { runTool, TOOL_DEFINITIONS } from "./tools";

const signal = new AbortController().signal;
const call = (name: string, input: unknown) => ({ id: "toolu_1", name, input });

type Spec = { root: string; elements: Record<string, { type: string; props: Record<string, unknown>; children: string[]; slots?: Record<string, string[]> }>; state?: Record<string, unknown> };
const booking = (): Spec => JSON.parse(seedSpec().files["pages/booking.json"] as string) as Spec;

/** Three pages: one asks "For how long?", one names the room in its title, one makes Hold room primary (which breaks one-primary-per-page). */
function three(): { note: string; spec: Spec }[] {
  const asks = booking();
  asks.elements.question!.props.label = "For how long?";
  const titled = booking();
  titled.elements.name!.props.text = { $template: "Book ${/room/name}" };
  const twoPrimaries = booking();
  twoPrimaries.elements.hold!.props.variant = "primary";
  return [
    { note: "Asks for how long", spec: asks },
    { note: "Says Book in the title", spec: titled },
    { note: "Both actions primary", spec: twoPrimaries },
  ];
}

describe("propose_variants", () => {
  it("keeps 2 to 4 whole pages beside the prototype, unchanged, each with core's checks", async () => {
    const parts = fakeHost(seedSpec());
    const outcome = await runTool(call("propose_variants", { page: "booking", variants: three() }), parts.host, signal);
    expect(outcome.isError).toBe(false);
    expect(outcome.changed).toBe(false);
    expect(parts.applied).toEqual([]);
    expect(parts.variants().variants.map((variant) => [variant.id, variant.page, variant.note])).toEqual([
      ["a", "booking", "Asks for how long"],
      ["b", "booking", "Says Book in the title"],
      ["c", "booking", "Both actions primary"],
    ]);
    expect(outcome.variants).toEqual({ page: "booking", ids: ["a", "b", "c"] });
    expect(outcome.content).toMatch(/Variant A \(id "a"\): Asks for how long\. Core passes every rule core checks without frames/);
    expect(outcome.content).toMatch(/Variant C \(id "c"\): Both actions primary\. Core fails one-primary-per-page \(Page "booking" has 2 primary actions/);
    expect(parts.variants().picks).toEqual([]);
  });

  it("tells the agent a variant answers for its own page: a failure the rooms page already had is counted, not the variant's", async () => {
    const seed = seedSpec();
    // The rooms page breaks a rule of its own: a primary action on a collection.
    const rooms = JSON.parse(seed.files["pages/rooms.json"] as string) as Spec;
    rooms.elements.extra = { type: "Button.Root", props: { variant: "primary", text: "Book room" }, children: [] };
    const root = rooms.elements[rooms.root]!;
    root.slots = { ...root.slots, body: [...(root.slots?.body ?? []), "extra"] };
    const failingElsewhere = { ...seed, files: { ...seed.files, "pages/rooms.json": JSON.stringify(rooms, null, 2) } };
    const parts = fakeHost(failingElsewhere);
    const outcome = await runTool(call("propose_variants", { page: "booking", variants: three() }), parts.host, signal);
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toMatch(/Variant A \(id "a"\): Asks for how long\. Core passes every rule core checks without frames on its own page; the board measures the rendered ones \(\d+ findings? already on another page (is|are) not this variant's and do not stop a pick\)/);
    expect(outcome.content).toMatch(/Variant C \(id "c"\): Both actions primary\. Core fails one-primary-per-page \(Page "booking" has 2 primary actions/);
    expect(outcome.content).not.toMatch(/Variant A[^\n]*fails/);
  });

  it("keeps none when core refuses any of them, and says why in core's words", async () => {
    const parts = fakeHost(seedSpec());
    const [first, second] = three();
    const refused = booking();
    refused.elements.free = { type: "Badge.Root", props: { text: "Free" }, children: [] };
    refused.elements.page!.slots!.facts!.push("free");
    const outcome = await runTool(call("propose_variants", { page: "booking", variants: [first, second, { note: "With a badge", spec: refused }] }), parts.host, signal);
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toMatch(/None of the variants was kept[\s\S]*Variant 3 \("With a badge"\):\npages\/booking\.json:\d+:\d+: pages\/booking\.json: element "free" is a Badge\.Root, which is not in the catalog/);
    expect(parts.savedVariants).toEqual([]);
  });

  it("refuses fewer than two, a copy of the page as it is, and a TSX prototype", async () => {
    const parts = fakeHost(seedSpec());
    const [first] = three();
    expect((await runTool(call("propose_variants", { page: "booking", variants: [first] }), parts.host, signal)).content).toMatch(/variants: expected at least 2 items/);
    const same = await runTool(call("propose_variants", { page: "booking", variants: [first, { note: "No change", spec: booking() }] }), parts.host, signal);
    expect(same.content).toMatch(/Variant 2 \("No change"\) is the page as it is now/);
    const tsx = fakeHost(seedSpec(), undefined, undefined, { tsx: true });
    expect((await runTool(call("propose_variants", { page: "booking", variants: three() }), tsx.host, signal)).content).toMatch(/^This prototype is TSX\. TSX prototypes are no longer edited or checked here/);
  });

  it("asks for more like one, and gives new ids after the ones in use", async () => {
    const parts = fakeHost(seedSpec());
    await runTool(call("propose_variants", { page: "booking", variants: three() }), parts.host, signal);
    const more = three().map((variant, index) => ({ ...variant, spec: { ...variant.spec, state: { ...variant.spec.state, duration: "60" } }, note: `More like A, ${index}` }));
    const outcome = await runTool(call("propose_variants", { page: "booking", variants: more.slice(0, 2), like: "a" }), parts.host, signal);
    expect(outcome.isError).toBe(false);
    expect(parts.variants().variants.slice(3).map((variant) => [variant.id, variant.like])).toEqual([
      ["d", "a"],
      ["e", "a"],
    ]);
    expect((await runTool(call("propose_variants", { page: "booking", variants: more.slice(0, 2), like: "z" }), parts.host, signal)).content).toMatch(/There is no variant "z"/);
  });
});

describe("revise_variant and list_variants", () => {
  it("fix a failing variant in place, and list each with core's checks", async () => {
    const parts = fakeHost(seedSpec());
    await runTool(call("propose_variants", { page: "booking", variants: three() }), parts.host, signal);
    const fixed = booking();
    fixed.elements.hold!.props.text = "Hold for later";
    const outcome = await runTool(call("revise_variant", { id: "c", spec: fixed, note: "Hold says for later" }), parts.host, signal);
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toMatch(/Revised Variant C of page "booking"\. Core passes every rule/);
    expect(parts.variants().variants.find((variant) => variant.id === "c")?.note).toBe("Hold says for later");
    const listed = JSON.parse((await runTool(call("list_variants", {}), parts.host, signal)).content) as { variants: { id: string; checks: string }[] };
    expect(listed.variants.map((variant) => variant.id)).toEqual(["a", "b", "c"]);
    expect(parts.applied).toEqual([]);
  });
});

describe("the agent never picks", () => {
  it("has no tool that picks, applies or adopts, in either mode", () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name).filter((name) => /pick|apply|choose|select|undo/.test(name))).toEqual([]);
  });

  it("refuses a pick smuggled into a tool's input, and an unknown pick tool", async () => {
    const parts = fakeHost(seedSpec());
    const smuggled = await runTool(call("propose_variants", { page: "booking", variants: three(), pick: { body: "a" } }), parts.host, signal);
    expect(smuggled.content).toMatch(/has unknown field "pick"/);
    const revise = await runTool(call("revise_variant", { id: "a", spec: booking(), apply: true }), parts.host, signal);
    expect(revise.content).toMatch(/has unknown field "apply"/);
    const pick = await runTool(call("pick_variant", { id: "a", slots: { body: "a" } }), parts.host, signal);
    expect(pick.content).toMatch(/There is no tool "pick_variant"/);
    expect(parts.applied).toEqual([]);
    expect(parts.variants().picks).toEqual([]);
  });
});
