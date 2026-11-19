import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProject, confirmationFrom, defaultStarterRules, draftRoles, parseLibraryDescription } from "@design-harness/core";
import { vendoredLibraries } from "../../scripts/vendor-libraries.mjs";
import { FRAME_REACT, SHIPPED_LIBRARIES } from "./registry";

const web = join(import.meta.dirname, "..", "..");
const packageJson = JSON.parse(readFileSync(join(web, "package.json"), "utf8")) as { dependencies: Record<string, string>; designHarness: { libraries: Record<string, Record<string, string[]>> } };

describe("the libraries this deployment ships", () => {
  it("are each served by the vendor build at their version, with the stylesheets it copies", () => {
    for (const library of SHIPPED_LIBRARIES) expect([library.package, packageJson.designHarness.libraries[library.package]?.[library.version]]).toEqual([library.package, library.setup.stylesheets]);
  });

  for (const library of SHIPPED_LIBRARIES) {
    it(`${library.name}: its description is of the version installed, and a project built on its draft has a starter that follows the rules`, async () => {
      // Installed at that version: under its own name, or, beside another version of it, under its npm alias.
      const install = vendoredLibraries(packageJson).find((entry) => entry.package === library.package && entry.version === library.version)?.install;
      expect(install && JSON.parse(readFileSync(join(web, "..", "..", "node_modules", install, "package.json"), "utf8")).version).toBe(library.version);
      expect(packageJson.dependencies.react).toBe(FRAME_REACT);
      const description = await library.describe();
      const parsed = parseLibraryDescription(JSON.parse(JSON.stringify(description)));
      expect(parsed.ok ? [] : parsed.error.slice(0, 3)).toEqual([]);
      expect([description.package, description.version]).toEqual([library.package, library.version]);
      const draft = draftRoles(description);
      const built = buildProject({
        name: `On ${library.name}`,
        takenIds: [],
        description,
        setup: library.setup,
        confirmation: confirmationFrom(draft, Object.fromEntries(draft.guesses.map((guess) => [guess.role, { mapping: guess.mapping }])), "accept"),
        rules: defaultStarterRules(),
      });
      if (!built.ok) throw new Error(JSON.stringify(built.error));
      expect(built.value.starter.ok ? "" : built.value.starter.error).toBe("");
      // Each of the library's own rules names a part the starting inventory has, so it is in force.
      expect(built.value.config.rules.map((rule) => rule.id)).toEqual(expect.arrayContaining((library.setup.rules ?? []).map((rule) => rule.id)));
    });
  }
});
