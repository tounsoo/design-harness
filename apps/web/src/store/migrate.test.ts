import { describe, expect, it } from "vitest";
import { checkPrototype, parseProjectConfig, type ProjectConfig } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { seedSpec, seedTsx } from "../../test/nook";
import todae0101 from "../../../../packages/core/libraries/todae-0.10.1.json";
import { tsxRulesNote, withLibraryParts, withoutTsxRules } from "./migrate";

/** Nook as a project stored before spec prototypes: the same config with no part description. */
function stored(version = nook.library.version): ProjectConfig {
  const { parts: _parts, ...library } = nook.library;
  return { ...nook, library: { ...library, version } };
}

describe("a stored project without library.parts", () => {
  it("cannot check a spec prototype until it has them", () => {
    const report = checkPrototype({ config: stored(), prototype: seedSpec() });
    expect(report.findings.map((finding) => finding.message)).toContain("The project's library (@tounsoo/todae) has no part descriptions (library.parts), so no catalog can be made and a spec prototype cannot be checked.");
  });

  it("gets the description bundled for its library version, and then checks the spec prototype", () => {
    const migration = withLibraryParts(stored());
    expect(migration.kind).toBe("added-parts");
    expect(migration.config.library.parts).toEqual(nook.library.parts);
    expect(parseProjectConfig(JSON.parse(JSON.stringify(migration.config))).ok).toBe(true);
    expect(migration.kind === "added-parts" && migration.note).toMatch(/added the one it ships for @tounsoo\/todae 0\.11\.3 \(203 parts\)/);
    expect(checkPrototype({ config: migration.config, prototype: seedSpec() }).findings).toEqual(checkPrototype({ config: nook, prototype: seedSpec() }).findings);
  });

  it("picks the description of the project's own library version", () => {
    const older = withLibraryParts(stored("0.10.1"));
    expect(older.kind).toBe("added-parts");
    expect(older.kind === "added-parts" && older.note).toMatch(/added the one it ships for @tounsoo\/todae 0\.10\.1 \(203 parts\)/);
    expect(older.config.library.parts).toEqual(todae0101.parts);
    expect(older.config.library.parts).not.toBe(nook.library.parts);
  });

  it("says plainly when the app has no description for its version, and changes nothing", () => {
    const config = stored("0.11.0");
    const migration = withLibraryParts(config);
    expect(migration.kind).toBe("no-parts");
    expect(migration.config).toBe(config);
    expect(migration.kind === "no-parts" && migration.note).toBe('Project "Nook" uses @tounsoo/todae 0.11.0, and this app has no description of that library\'s parts, so no prototype can be made or edited in it, and its spec prototypes cannot be checked. Import a project file whose config has library.parts for @tounsoo/todae 0.11.0 to use specs.');
  });

  it("leaves a project that has them alone", () => {
    expect(withLibraryParts(nook)).toEqual({ kind: "unchanged", config: nook });
  });
});

describe("a stored project with rules only TSX had", () => {
  const json = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));
  const isolation = { type: "isolation", id: "no-ambient-globals" };
  const styles = { type: "style-props", id: "no-inline-styles" };
  const imports = { type: "membership", id: "imports-from-library", of: "imports" };
  const example = (name: string, prototype: unknown, flaggedBy?: string) => ({ name, prototype, ...(flaggedBy ? { flaggedBy: { rule: flaggedBy } } : {}) });
  const proposal = (id: string, add: unknown[], pass: unknown[], fail: unknown[]) => ({
    id,
    title: "t",
    reason: "r",
    states: [],
    inventory: [],
    rules: { add, remove: [] },
    examples: { pass, fail },
    status: "open",
    history: [{ status: "open", at: "2026-11-01T00:00:00Z" }],
  });

  it("loads without them, in its rules and in every proposal, and says what went", () => {
    const toast = { type: "count", id: "one-toast", scope: "page", select: { component: "Toast.Root" }, max: 1 };
    const spec = seedSpec();
    const kept = proposal("toast", [toast], [example("one", spec)], [example("two", spec, "one-toast")]);
    const mixed = proposal("frames", [toast, isolation], [example("tsx-pass", seedTsx()), example("spec-pass", spec)], [example("timer", seedTsx(), "no-ambient-globals"), example("spec-isolated", spec, "no-ambient-globals"), example("two", spec, "one-toast")]);
    const revised = { ...proposal("revised", [toast], [example("one", spec)], [example("two", spec, "one-toast")]), events: [{ kind: "revised", at: "2026-11-02T00:00:00Z", previous: { title: "t", reason: "r", states: [], inventory: [], rules: { add: [styles], remove: [] }, examples: { pass: [example("old", { ...seedTsx(), format: undefined })], fail: [] } } }] };
    const stored = json({ ...nook, rules: [...nook.rules, isolation, styles, imports], proposals: [kept, mixed, revised] });
    const migrated = withoutTsxRules(stored);
    expect(migrated.removed).toEqual([
      'rule "no-ambient-globals", which only TSX had',
      'rule "no-inline-styles", which only TSX had',
      'rule "imports-from-library", which only TSX had',
      'proposal "frames" added rule "no-ambient-globals", which only TSX had',
      'proposal "frames"\'s passing example "tsx-pass", written as TSX, which core no longer reads',
      'proposal "frames"\'s failing example "timer", written as TSX, which core no longer reads',
      'proposal "frames"\'s failing example "spec-isolated", flagged by "no-ambient-globals", a rule only TSX had',
      'proposal "revised"\'s earlier version added rule "no-inline-styles", which only TSX had',
      'proposal "revised"\'s earlier version\'s passing example "old", written as TSX, which core no longer reads',
    ]);
    const parsed = parseProjectConfig(migrated.json);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    expect(parsed.value.rules).toEqual(nook.rules);
    const [first, second, third] = parsed.value.proposals;
    expect(first).toEqual(kept);
    expect(second?.rules.add).toEqual([toast]);
    expect([second?.examples.pass.map((item) => item.name), second?.examples.fail.map((item) => item.name)]).toEqual([["spec-pass"], ["two"]]);
    expect(third?.events?.[0]).toMatchObject({ previous: { rules: { add: [] }, examples: { pass: [], fail: [] } } });
    // Without the migration, core refuses the stored config whole.
    expect(parseProjectConfig(stored).ok).toBe(false);
    expect(tsxRulesNote("Nook", migrated.removed.slice(0, 1))).toEqual({ tone: "info", title: "Rules that only applied to TSX were taken out", text: 'Project "Nook" listed rules core no longer has: every prototype is a spec now, so they had nothing left to check. The app took out rule "no-ambient-globals", which only TSX had.' });
  });

  it("leaves a config that has none as it was, the very same value", () => {
    const stored = json(nook);
    expect(withoutTsxRules(stored)).toEqual({ json: stored, removed: [] });
    expect(withoutTsxRules(stored).json).toBe(stored);
  });
});

