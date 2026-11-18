import { describe, expect, it } from "vitest";
import { nook } from "../../../../packages/core/examples/nook/project";
import { seedLegal, seedSpec } from "../../test/nook";
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
});
