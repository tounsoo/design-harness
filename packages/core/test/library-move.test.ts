import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nook } from "../examples/nook/project";
import type { PartDescription, ProjectConfig } from "../src/config/types";
import { chooseLibrarySource, compareLibraries, moveLibrary, planLibraryMove, reportChanges } from "../src/library/move";
import type { LibraryDescription } from "../src/library/roles";
import { parseProjectConfig } from "../src/parse";
import { EXAMPLES, loadPrototype } from "./fixtures";

/**
 * Moving a project to another version of its library: what the two
 * descriptions say differently, whether the roles still hold, how each
 * prototype's report would change, and the move itself, recorded. Pure and
 * deterministic, like every check.
 */
const LIBRARIES = join(import.meta.dirname, "..", "libraries");
const read = (file: string) => JSON.parse(readFileSync(join(LIBRARIES, file), "utf8")) as LibraryDescription;
const older = read("todae-0.10.1.json");
const newer = read("todae-0.11.3.json");

/** Nook as a project stored on Todae 0.10.1, the one Ben's deployed app holds. */
const onOlder: ProjectConfig = { ...nook, library: { ...nook.library, version: "0.10.1", parts: older.parts } };
const prototypes = [
  { id: "booking", name: "Booking", prototype: loadPrototype(join(EXAMPLES, "legal", "booking")) },
  { id: "booking-spec", name: "Booking (spec)", prototype: loadPrototype(join(EXAMPLES, "spec", "legal", "booking")) },
];

/** A copy of a description with some parts changed. */
function edited(description: LibraryDescription, version: string, change: (parts: Record<string, PartDescription>) => void): LibraryDescription {
  const parts = JSON.parse(JSON.stringify(description.parts)) as Record<string, PartDescription>;
  change(parts);
  return { ...description, version, parts };
}

describe("comparing two versions of a library", () => {
  it("finds what Todae 0.11.3 changed from 0.10.1: Slider.Root's props, and nothing else", () => {
    const diff = compareLibraries(older, newer);
    expect([diff.from, diff.to, diff.added, diff.removed, diff.renamed]).toEqual(["0.10.1", "0.11.3", [], [], []]);
    expect(diff.changed.map((change) => change.part)).toEqual(["Slider.Root"]);
    expect(diff.changed[0]?.added).toEqual(expect.arrayContaining(["disabled", "max", "min"]));
    expect(diff.changed[0]?.removed).toEqual([]);
    expect(diff.unchanged).toBe(Object.keys(older.parts).length - 1);
  });

  it("names parts added and removed, and a removed part described exactly like an added one as renamed", () => {
    const next = edited(newer, "0.12.0", (parts) => {
      parts["Callout.Root"] = parts["Alert.Root"] as PartDescription;
      delete parts["Alert.Root"];
      delete parts["Kbd.Root"];
      parts["Zebra.Root"] = { props: { label: { type: "string", required: true } }, content: "none" };
    });
    const diff = compareLibraries(newer, next);
    expect(diff.renamed).toEqual([{ from: "Alert.Root", to: "Callout.Root" }]);
    expect(diff.added).toEqual(["Zebra.Root"]);
    expect(diff.removed).toEqual(["Kbd.Root"]);
  });

  it("gives the same diff whatever order the parts come in", () => {
    const reversed = { ...newer, parts: Object.fromEntries(Object.entries(newer.parts).reverse()) };
    expect(compareLibraries(older, reversed)).toEqual(compareLibraries(older, newer));
  });
});

describe("planning a move", () => {
  // Checked without snapshots on both sides, so the rendered rules are not run and each report is incomplete: the frames measure them after the move.
  it("moves Nook from 0.10.1 to 0.11.3 with every role holding and no prototype's report changing", () => {
    const plan = planLibraryMove(onOlder, older, newer, prototypes);
    expect(plan.refusals).toEqual([]);
    expect(plan.roles.every((role) => role.problems.length === 0)).toBe(true);
    expect(plan.missingComponents).toEqual([]);
    expect(plan.config?.library.version).toBe("0.11.3");
    expect(plan.config?.library.parts).toEqual(newer.parts);
    expect(plan.prototypes.map((change) => [change.id, change.before, change.after, reportChanges(change)])).toEqual([
      ["booking", "incomplete", "incomplete", false],
      ["booking-spec", "incomplete", "incomplete", false],
    ]);
  });

  it("shows which prototypes' reports change, finding by finding", () => {
    // A version whose Text.Root no longer takes as="h2": the spec prototype's room cards use it.
    const next = edited(newer, "0.12.0", (parts) => {
      const text = parts["Text.Root"] as PartDescription;
      parts["Text.Root"] = { ...text, props: { ...text.props, as: { type: "enum", values: ["h1", "p", "span"], required: false } } };
    });
    const plan = planLibraryMove(nook, newer, next, prototypes);
    expect(plan.refusals).toEqual([]);
    const spec = plan.prototypes.find((change) => change.id === "booking-spec");
    expect(spec && reportChanges(spec)).toBe(true);
    expect(spec?.after).toBe("fail");
    expect(spec?.added.length).toBeGreaterThan(0);
    expect(spec?.added.map((finding) => finding.message).join("\n")).toContain("h2");
    expect(spec?.removed).toEqual([]);
    expect(plan.diff.changed.map((change) => [change.part, change.changed])).toEqual([["Text.Root", ["as"]]]);
  });

  it("carries the new version's parts of only the families a project carried, or all of them when it carried every one", () => {
    const some = Object.fromEntries(Object.entries(older.parts).filter(([part]) => ["Button", "Text", "Disclosure", "Field", "Card", "Stack", "Alert", "EmptyState", "Label"].includes(part.split(".")[0] as string)));
    const plan = planLibraryMove({ ...onOlder, library: { ...onOlder.library, parts: some } }, older, newer, []);
    expect(Object.keys(plan.config?.library.parts ?? {})).toEqual(Object.keys(newer.parts).filter((part) => part in some).sort());
    expect(Object.keys(planLibraryMove(onOlder, older, newer, []).config?.library.parts ?? {}).length).toBe(Object.keys(newer.parts).length);
  });

  it("refuses a move that would leave a role or an inventoried component without a part, saying which", () => {
    const next = edited(newer, "0.12.0", (parts) => {
      for (const part of Object.keys(parts)) if (part.startsWith("Disclosure")) delete parts[part];
    });
    const plan = planLibraryMove(nook, newer, next, prototypes);
    expect(plan.config).toBeNull();
    expect(plan.prototypes).toEqual([]);
    expect(plan.roles.find((role) => role.role === "disclosure")?.problems).toEqual(["names Disclosure.Root, which @tounsoo/todae 0.12.0 has no part of"]);
    expect(plan.missingComponents).toEqual(["Disclosure"]);
    expect(plan.refusals).toEqual(expect.arrayContaining([expect.stringContaining('role "disclosure" names Disclosure.Root'), expect.stringContaining("Disclosure is an inventoried component")]));
  });

  it("refuses a move to the same version, to another library, or from a description that is not the project's", () => {
    expect(planLibraryMove(nook, newer, newer, []).refusals).toEqual(["the project is already on @tounsoo/todae 0.11.3"]);
    expect(planLibraryMove(nook, newer, { ...older, package: "@acme/ui" }, []).refusals[0]).toContain("@acme/ui is another library");
    expect(planLibraryMove(nook, older, newer, []).refusals[0]).toContain("the project is on @tounsoo/todae 0.11.3");
  });

  it("is deterministic: the same plan whatever order the prototypes come in", () => {
    expect(planLibraryMove(onOlder, older, newer, [...prototypes].reverse())).toEqual(planLibraryMove(onOlder, older, newer, prototypes));
  });
});

describe("making the move", () => {
  it("records it in library.history with the caller's stamp, and the config still validates", () => {
    const moved = moveLibrary(onOlder, older, newer, { at: "2026-11-19T10:00:00.000Z", by: "you" });
    if (!moved.ok) throw new Error(moved.error.join("\n"));
    expect(moved.value.library.version).toBe("0.11.3");
    expect(moved.value.library.history).toEqual([{ kind: "moved", from: "0.10.1", to: "0.11.3", at: "2026-11-19T10:00:00.000Z", by: "you" }]);
    expect(parseProjectConfig(JSON.parse(JSON.stringify(moved.value))).ok).toBe(true);
    // Everything but the library is as it was.
    expect({ ...moved.value, library: null }).toEqual({ ...onOlder, library: null });
  });

  it("drops a project's own esm.sh source on a move, unless the move asks for one", () => {
    const fromCdn = chooseLibrarySource(onOlder, "esm.sh", { at: "t1", by: "you" });
    const moved = moveLibrary(fromCdn, older, newer, { at: "t2" });
    expect(moved.ok && moved.value.library.source).toBe(undefined);
    expect(moved.ok && moved.value.library.history?.map((entry) => entry.kind)).toEqual(["source", "moved"]);
  });

  it("refuses what the plan refuses", () => {
    expect(moveLibrary(nook, newer, newer, { at: "t" })).toEqual({ ok: false, error: ["the project is already on @tounsoo/todae 0.11.3"] });
  });
});

describe("choosing where a project's library loads from", () => {
  it("sets esm.sh and back, recording each choice, and the config validates", () => {
    const cdn = chooseLibrarySource(onOlder, "esm.sh", { at: "t1", by: "you" });
    expect(cdn.library.source).toBe("esm.sh");
    const back = chooseLibrarySource(cdn, "deployment", { at: "t2", by: "you" });
    expect("source" in back.library).toBe(false);
    expect(back.library.history).toEqual([
      { kind: "source", source: "esm.sh", version: "0.10.1", at: "t1", by: "you" },
      { kind: "source", source: "deployment", version: "0.10.1", at: "t2", by: "you" },
    ]);
    expect(parseProjectConfig(JSON.parse(JSON.stringify(cdn))).ok).toBe(true);
    expect(parseProjectConfig({ ...nook, library: { ...nook.library, source: "unpkg" } }).ok).toBe(false);
  });
});
