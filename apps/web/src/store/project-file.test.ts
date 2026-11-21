import { describe, expect, it } from "vitest";
import { carryWithPick, returnFromPick } from "../pins/pick";
import { nook } from "../../../../packages/core/examples/nook/project";
import { seedSpec, seedTsx } from "../../test/nook";
import { NO_PINS, addPin, addressPin, closePin, type PinState } from "../pins/model";
import { PROJECT_FILE_FORMAT, exportFileName, exportProject, importProject, type PrototypeRecord } from "./project-file";

const records: PrototypeRecord[] = [{ projectId: "nook", id: "booking", name: "Booking", prototype: seedSpec() }];

describe("a project file", () => {
  it("round-trips a project and its prototypes through export and import", () => {
    const text = exportProject(nook, records);
    expect(JSON.parse(text)).toMatchObject({ format: PROJECT_FILE_FORMAT, version: 1, project: { id: "nook" } });
    const imported = importProject(text);
    expect(imported).toEqual({ ok: true, value: { config: nook, prototypes: records, removed: [], docs: [] } });
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
    expect(importProject(text)).toEqual({ ok: true, value: { config: nook, prototypes: withVariants, removed: [], docs: [] } });
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
    expect(importProject(text)).toEqual({ ok: true, value: { config: nook, prototypes: pinned, removed: [], docs: [] } });
    // A second trip gives the same file.
    const again = importProject(text);
    expect(again.ok && JSON.parse(exportProject(again.value.config, again.value.prototypes))).toEqual(JSON.parse(text));
    // No pins, no key: a prototype without notes exports as it always did.
    expect(exportProject(nook, [{ ...(records[0] as PrototypeRecord), pins: NO_PINS }])).toBe(exportProject(nook, records));
    const file = JSON.parse(text) as { prototypes: { pins: { pins: Record<string, unknown>[] } }[] };
    (file.prototypes[0] as { pins: { pins: Record<string, unknown>[] } }).pins.pins[0] = { ...file.prototypes[0]?.pins.pins[0], status: "passed" };
    expect(importProject(JSON.stringify(file))).toEqual({ ok: false, error: ['$.prototypes[0].pins.pins[0].status: expected "open", "addressed" or "closed"'] });
  });

  it("keeps a note a pick moved onto the prototype, and one its undoing put back, through export and import", () => {
    const box = { rect: { x: 240, y: 200, width: 120, height: 40 }, within: { x: 0.25, y: 0.25 } };
    const anchor = { scenario: "lantern-open", view: "desktop", variant: "b", revision: "rev-b", seen: "rev-b", point: { x: 270, y: 210 }, element: { source: { tag: "hold", kind: "key" as const, nth: 0, ...box } } };
    const added = addPin(NO_PINS, anchor, "Make this bigger", "2026-11-19T10:00:00.000Z");
    if (!added.ok) throw new Error(added.error);
    const moved = carryWithPick(added.value, { scenarios: ["lantern-open"], slots: { alternate: "b" }, keyOf: (_source, key) => `${key}-b` }, "2026-11-19T11:00:00.000Z").state;
    expect(moved.pins[0]?.anchor).toMatchObject({ element: { source: { tag: "hold-b" } } });
    expect(moved.pins[0]?.anchor.variant).toBeUndefined();
    const back = returnFromPick(moved, "2026-11-19T11:00:00.000Z", "2026-11-19T12:00:00.000Z").state;
    expect(back.pins[0]?.anchor).toEqual(anchor);
    for (const pins of [moved, back]) {
      const kept: PrototypeRecord[] = [{ ...(records[0] as PrototypeRecord), pins }];
      const text = exportProject(nook, kept);
      expect(importProject(text)).toEqual({ ok: true, value: { config: nook, prototypes: kept, removed: [], docs: [] } });
    }
    // A moved note that says it is still on its variant is refused, with where.
    const file = JSON.parse(exportProject(nook, [{ ...(records[0] as PrototypeRecord), pins: moved }])) as { prototypes: { pins: { pins: { anchor: Record<string, unknown> }[] } }[] };
    (file.prototypes[0]?.pins.pins[0] as { anchor: Record<string, unknown> }).anchor.variant = "b";
    expect(importProject(JSON.stringify(file))).toEqual({ ok: false, error: ["$.prototypes[0].pins.pins[0].anchor: a note that came with a pick is on the prototype, not on a variant"] });
  });

  it("imports a TSX prototype as it was stored, for its files alone, and takes rules only TSX had out of the config, saying which", () => {
    const tsx = seedTsx();
    const { format: _format, ...unformatted } = tsx;
    const legacy = {
      ...nook,
      rules: [...nook.rules, { type: "isolation", id: "no-ambient-globals" }, { type: "style-props", id: "no-inline-styles" }, { type: "membership", id: "imports-from-library", of: "imports" }],
    };
    const file = { format: PROJECT_FILE_FORMAT, version: 1, project: legacy, prototypes: [{ id: "booking", name: "Booking", prototype: seedSpec() }, { id: "old", name: "Old", prototype: unformatted }] };
    const imported = importProject(JSON.stringify(file));
    if (!imported.ok) throw new Error(imported.error.join("\n"));
    expect(imported.value.config).toEqual(nook);
    expect(imported.value.removed).toEqual(['rule "no-ambient-globals", which only TSX had', 'rule "no-inline-styles", which only TSX had', 'rule "imports-from-library", which only TSX had']);
    // A prototype with no format was TSX: it comes back said so, with its files as they were.
    expect(imported.value.prototypes.map((record) => [record.id, record.prototype.format])).toEqual([["booking", "spec"], ["old", "tsx"]]);
    expect(imported.value.prototypes[1]?.prototype).toEqual(tsx);
    // A TSX prototype that is not whole is refused, with core's words for why.
    const broken = importProject(JSON.stringify({ ...file, prototypes: [{ id: "old", name: "Old", prototype: { ...tsx, pages: "none" } }] }));
    expect(broken).toMatchObject({ ok: false, error: [expect.stringContaining("$.prototypes[0].prototype.format: says the prototype is TSX"), "$.prototypes[0].prototype.pages: expected an array, got a string"] });
  });

  it("keeps the project's doc sources beside its config through export and import, and never a token", () => {
    const docs = [
      { kind: "website" as const, url: "https://todae.design/docs", label: "Todae docs" },
      { kind: "mcp" as const, url: "https://mcp.example.com/mcp", name: "design-docs" },
    ];
    // A source that somehow carried a token is written field by field, so the token stays behind.
    const leaky = [docs[0], { ...docs[1], authorization_token: "mcp-secret-token-0123456789" }] as unknown as typeof docs;
    const text = exportProject(nook, records, leaky);
    expect(text).not.toContain("mcp-secret-token-0123456789");
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["format", "version", "project", "docs", "prototypes"]);
    expect(JSON.parse(text).project).toEqual(nook);
    expect(importProject(text)).toEqual({ ok: true, value: { config: nook, prototypes: records, removed: [], docs } });
    // No sources, no key: a project without docs exports as it did before them.
    expect(exportProject(nook, records, [])).toBe(exportProject(nook, records));
  });

  it("refuses a file whose doc sources carry a token or do not read, saying where", () => {
    const file = JSON.parse(exportProject(nook, records)) as Record<string, unknown>;
    const withToken = importProject(JSON.stringify({ ...file, docs: [{ kind: "mcp", url: "https://mcp.example.com/mcp", name: "design-docs", authorization_token: "x" }] }));
    expect(withToken).toEqual({ ok: false, error: ['$.docs[0]: has unknown fields "authorization_token"'] });
    const insecure = importProject(JSON.stringify({ ...file, docs: [{ kind: "website", url: "http://todae.design" }] }));
    expect(insecure).toEqual({ ok: false, error: ["$.docs[0].url: Use an https:// address."] });
  });
});
