import { describe, expect, it } from "vitest";
import { nook } from "../../../../packages/core/examples/nook/project";
import { seedLegal } from "../../test/nook";
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
});
