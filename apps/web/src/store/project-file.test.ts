import { describe, expect, it } from "vitest";
import { nook } from "../../../../packages/core/examples/nook/project";
import { seedLegal, seedSpec } from "../../test/nook";
import { NO_PINS, addPin, addressPin, closePin, type PinState } from "../pins/model";
import { PROJECT_FILE_FORMAT, exportFileName, exportProject, importProject, type PrototypeRecord } from "./project-file";

const records: PrototypeRecord[] = [{ projectId: "nook", id: "booking", name: "Booking", prototype: seedLegal() }];

describe("a project file", () => {
  it("round-trips a project and its prototypes through export and import", () => {
    const text = exportProject(nook, records);
    expect(JSON.parse(text)).toMatchObject({ format: PROJECT_FILE_FORMAT, version: 1, project: { id: "nook" } });
    const imported = importProject(text);
    expect(imported).toEqual({ ok: true, value: { config: nook, prototypes: records } });
    expect(exportProject(nook, [...records].reverse())).toBe(text);
    expect(exportFileName(nook)).toBe("nook.design-harness.json");
  });

  it("refuses what is not a project file, saying why", () => {
    expect(importProject("{")).toMatchObject({ ok: false, error: [expect.stringMatching(/^The file is not JSON: /)] });
    expect(importProject(JSON.stringify({ format: "other" }))).toMatchObject({ ok: false, error: [`The file is not a design-harness project: its "format" is not "${PROJECT_FILE_FORMAT}".`] });
    expect(importProject(JSON.stringify({ format: PROJECT_FILE_FORMAT, version: 2 }))).toMatchObject({ ok: false, error: ["The file is version 2; this app reads version 1."] });
  });

  it("validates the config and every prototype with core, and lists every problem with its path", () => {
    const file = JSON.parse(exportProject(nook, records)) as { project: Record<string, unknown>; prototypes: Record<string, unknown>[] };
    file.project = { ...file.project, views: [{ name: "Phone", width: 0, height: 844, scheme: "light" }] };
    const prototype = file.prototypes[0]?.prototype as Record<string, unknown>;
    file.prototypes = [
      { id: "booking", name: "Booking", prototype: { ...prototype, scenarios: "none" } },
      { id: "booking", name: "", prototype, extra: 1 },
    ];
    const result = importProject(JSON.stringify(file));
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.error).toEqual([
      'project: $.project.views[0].name: expected a lowercase slug such as "book-room", got "Phone"',
      "project: $.project.views[0].width: expected a whole number of at least 1, got 0",
      "$.prototypes[0].prototype.scenarios: expected an array, got a string",
      '$.prototypes[1]: has unknown fields "extra"',
      '$.prototypes[1].id: prototype "booking" appears twice',
      "$.prototypes[1].name: expected a non-empty string",
    ]);
  });

  it("keeps a prototype's variants and picks through export and import, and refuses ones that do not validate", () => {
    const variants = { variants: [{ id: "b", page: "booking", note: "Asks for how long first", spec: seedSpec().files["pages/booking.json"] as string, like: "a" }], picks: [{ at: "2026-11-18T12:00:00.000Z", page: "booking", slots: { body: "b" }, notes: { b: "Asks for how long first" }, before: "{}", after: "{}" }] };
    const withVariants: PrototypeRecord[] = [{ projectId: "nook", id: "booking-spec", name: "Booking (spec)", prototype: seedSpec(), variants }];
    const text = exportProject(nook, withVariants);
    expect(importProject(text)).toEqual({ ok: true, value: { config: nook, prototypes: withVariants } });
    const file = JSON.parse(text) as { prototypes: { variants: { variants: Record<string, unknown>[] } }[] };
    (file.prototypes[0] as { variants: { variants: Record<string, unknown>[] } }).variants.variants[0] = { id: "B!", page: "booking", note: "", spec: "{}" };
    expect(importProject(JSON.stringify(file))).toEqual({ ok: false, error: ['$.prototypes[0].variants.variants[0].id: expected a variant id such as "b", got "B!"', "$.prototypes[0].variants.variants[0].note: expected a non-empty string"] });
    expect(JSON.parse(exportProject(nook, records)).prototypes[0]).not.toHaveProperty("variants");
  });

  it("keeps a prototype's pinned notes and their history through export and import, and refuses ones that cannot be read", () => {
    const anchor = { scenario: "lantern-open", view: "desktop", revision: "rev-1", seen: "rev-1", point: { x: 270, y: 210 }, element: { label: { role: "button", name: "Book room", html: "button", rect: { x: 240, y: 200, width: 120, height: 40 }, within: { x: 0.25, y: 0.25 } } } };
    let pins = NO_PINS;
    for (const step of [(state: PinState) => addPin(state, anchor, "Make this bigger", "2026-11-19T10:00:00.000Z"), (state: PinState) => addPin(state, { ...anchor, lost: true as const }, "And this", "2026-11-19T10:01:00.000Z"), (state: PinState) => addressPin(state, 1, "Done.", "2026-11-19T10:02:00.000Z"), (state: PinState) => closePin(state, 1, "2026-11-19T10:03:00.000Z")]) {
      const next = step(pins);
      if (!next.ok) throw new Error(next.error);
      pins = next.value;
    }
    const pinned: PrototypeRecord[] = [{ ...(records[0] as PrototypeRecord), pins }];
    const text = exportProject(nook, pinned);
    expect((JSON.parse(text) as { prototypes: { pins: unknown }[] }).prototypes[0]?.pins).toEqual(pins);
    expect(importProject(text)).toEqual({ ok: true, value: { config: nook, prototypes: pinned } });
    // A second trip gives the same file.
    const again = importProject(text);
    expect(again.ok && JSON.parse(exportProject(again.value.config, again.value.prototypes))).toEqual(JSON.parse(text));
    // No pins, no key: a prototype without notes exports as it always did.
    expect(exportProject(nook, [{ ...(records[0] as PrototypeRecord), pins: NO_PINS }])).toBe(exportProject(nook, records));
    const file = JSON.parse(text) as { prototypes: { pins: { pins: Record<string, unknown>[] } }[] };
    (file.prototypes[0] as { pins: { pins: Record<string, unknown>[] } }).pins.pins[0] = { ...file.prototypes[0]?.pins.pins[0], status: "passed" };
    expect(importProject(JSON.stringify(file))).toEqual({ ok: false, error: ['$.prototypes[0].pins.pins[0].status: expected "open", "addressed" or "closed"'] });
  });
});
