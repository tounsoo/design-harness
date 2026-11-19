import { describe, expect, it } from "vitest";
import { checkPrototype, type Finding } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { legalSnapshots } from "../../../../packages/core/examples/nook/snapshots";
import { seedLegal, seedSpec } from "../../test/nook";
import { frameSpecs, type FrameKey, type FrameState } from "./session";
import { describeOutline } from "../app/words";
import { planOutline, sourceTag, tagOf } from "./tags";

/** Every frame of a prototype measured, each having drawn the tags `drawn` gives it. */
function measuredStates(frames: ReturnType<typeof frameSpecs>, drawn: (page: string) => readonly string[]): Record<FrameKey, FrameState> {
  const snapshots = legalSnapshots();
  return Object.fromEntries(
    frames.map((frame) => {
      const snapshot = snapshots.find((item) => item.scenario === frame.scenario.id && item.view === frame.view.name);
      return [frame.key, snapshot ? { state: "measured", snapshot, tags: drawn(frame.scenario.page) } : { state: "waiting" }];
    }),
  );
}

describe("matching a finding to the tags frames drew", () => {
  it("names a TSX element by where it is written and a spec element by its key in the expanded page", () => {
    expect(tagOf({ file: "pages/booking.tsx", line: 34, column: 9, page: "booking" })).toBe("pages/booking.tsx:34:9");
    expect(tagOf({ file: "layouts/room-details.json", line: 8, column: 5, page: "booking", key: "details/summary", via: [{ layout: "room-details", file: "pages/booking.json", line: 21, column: 5 }] })).toBe("details/summary");
    expect(sourceTag({ file: "a.tsx", line: 1, column: 2 })).toBe("a.tsx:1:2");
  });

  it("outlines both primary actions of a TSX page in every frame of that page, and in no other page's frames", () => {
    const prototype = seedLegal();
    const text = (prototype.files["pages/booking.tsx"] ?? "").replace('<Button.Root variant="secondary">Hold room</Button.Root>', '<Button.Root variant="primary">Hold room</Button.Root>');
    const edited = { ...prototype, files: { ...prototype.files, "pages/booking.tsx": text } };
    const finding = checkPrototype({ config: nook, prototype: edited }).findings.find((item) => item.rule === "one-primary-per-page") as Finding;
    const tags = (finding.targets ?? []).map(tagOf);
    expect(tags).toHaveLength(2);
    const frames = frameSpecs(nook, edited);
    const plan = planOutline(finding, frames, measuredStates(frames, (page) => (page === "booking" ? [...tags, "pages/booking.tsx:1:1"] : [])));
    expect(plan?.frames.map((frame) => frame.key)).toEqual(frames.filter((frame) => frame.scenario.page === "booking").map((frame) => frame.key));
    for (const frame of plan?.frames ?? []) expect(frame.tags).toEqual(tags);
    expect(plan?.missing).toEqual([]);
    expect(describeOutline(plan ?? { frames: [], missing: [], unmeasured: [] }, frames)).toBe("Outlined in 6 frames: Booking, room open (Lantern open); Booking, booked (Lantern booked); Booking, held (Lantern held).");
  });

  it("outlines an element inside a spec layout instance by its scoped key, and says where it is not drawn", () => {
    const prototype = seedSpec();
    const finding: Finding = {
      rule: "disclosure-depth",
      kind: "violation",
      message: "nests",
      page: "booking",
      targets: [{ file: "layouts/room-details.json", line: 12, column: 5, via: [{ layout: "room-details", file: "pages/booking.json", line: 21, column: 5 }], page: "booking", key: "details/access" }],
    };
    const frames = frameSpecs(nook, prototype);
    // Drawn while the room is open and held; the booked scenario hides it.
    const states = measuredStates(frames, (page) => (page === "booking" ? ["details/access"] : []));
    for (const frame of frames.filter((item) => item.scenario.id === "lantern-booked")) states[frame.key] = { ...(states[frame.key] as Extract<FrameState, { state: "measured" }>), tags: ["details/details"] };
    const plan = planOutline(finding, frames, states);
    expect(plan?.frames.map((frame) => frame.key)).toEqual(["lantern-open@desktop", "lantern-open@phone", "lantern-held@desktop", "lantern-held@phone"]);
    expect(plan?.missing).toEqual(["lantern-booked"]);
    expect(describeOutline(plan ?? { frames: [], missing: [], unmeasured: [] }, frames)).toBe("Outlined in 4 frames: Booking, room open (Lantern open); Booking, held (Lantern held). Not drawn in Booking, booked (Lantern booked).");
  });

  it("outlines an element read from the source in any page's frames, and says when no page draws it", () => {
    const prototype = seedLegal();
    const frames = frameSpecs(nook, prototype);
    const unrendered: Finding = { rule: "counted-parts-reached", kind: "violation", message: "no page reaches it", targets: [{ file: "pages/booking.tsx", line: 50, column: 7 }] };
    const plan = planOutline(unrendered, frames, measuredStates(frames, () => ["pages/booking.tsx:34:9"]));
    expect(plan?.frames).toEqual([]);
    expect(plan?.missing).toEqual(["rooms-list", "lantern-open", "lantern-booked", "lantern-held"]);
    const unmeasured = planOutline(unrendered, frames, {});
    expect(unmeasured?.unmeasured).toHaveLength(8);
  });

  it("outlines nothing for a finding about a whole page, and keeps a rendered finding to its own frame", () => {
    const prototype = seedLegal();
    const frames = frameSpecs(nook, prototype);
    const states = measuredStates(frames, () => ["pages/booking.tsx:34:9"]);
    expect(planOutline({ rule: "primary-slot", kind: "violation", message: "does not fill its slot", page: "booking", file: "pages/booking.tsx", line: 16, column: 8 }, frames, states)).toBeNull();
    const one: Finding = { rule: "x", kind: "violation", message: "x", scenario: "lantern-open", view: "phone", targets: [{ file: "pages/booking.tsx", line: 34, column: 9, page: "booking" }] };
    expect(planOutline(one, frames, states)?.frames.map((frame) => frame.key)).toEqual(["lantern-open@phone"]);
  });
});
