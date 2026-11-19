import { describe, expect, it } from "vitest";
import { checkPrototype, parseProjectConfig, type ProjectConfig } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { seedSpec } from "../../test/nook";
import todae0101 from "../../../../packages/core/libraries/todae-0.10.1.json";
import { withLibraryParts } from "./migrate";

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
    expect(migration.kind === "no-parts" && migration.note).toBe('Project "Nook" uses @tounsoo/todae 0.11.0, and this app has no description of that library\'s parts, so its spec prototypes cannot be checked or written. Its TSX prototypes work as before. Import a project file whose config has library.parts for @tounsoo/todae 0.11.0 to use specs.');
  });

  it("leaves a project that has them alone", () => {
    expect(withLibraryParts(nook)).toEqual({ kind: "unchanged", config: nook });
  });
});
