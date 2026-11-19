import type { LibraryDescription, ProjectConfig } from "@design-harness/core";
import { SHIPPED_LIBRARIES } from "./registry";
import todae0101 from "../../../../packages/core/libraries/todae-0.10.1.json";

/**
 * Every library version this app has a description of, the ones New project
 * offers (`SHIPPED_LIBRARIES`) and older ones a stored project may still be
 * on, such as Todae 0.10.1. A project can be moved between the versions
 * here that the page's package source serves; the dry run compares their
 * descriptions. `versions.test.ts` holds each one to the vendor build's
 * config, so a version described here is a version served.
 */
export type DescribedVersion = { readonly package: string; readonly version: string; readonly describe: () => Promise<LibraryDescription> };

export const DESCRIBED_VERSIONS: readonly DescribedVersion[] = [
  ...SHIPPED_LIBRARIES.map((library) => ({ package: library.package, version: library.version, describe: library.describe })),
  // The Todae a project made before the 0.11.3 upgrade is on. It is also bundled for the stored-project migration (`store/migrate.ts`).
  { package: "@tounsoo/todae", version: "0.10.1", describe: () => Promise.resolve(todae0101 as unknown as LibraryDescription) },
];

/** The versions of a package this app describes. */
export function describedVersions(name: string): readonly DescribedVersion[] {
  return DESCRIBED_VERSIONS.filter((entry) => entry.package === name);
}

/**
 * The whole description of the version a project is on: the one this app
 * ships for that version, else the project's own `library.parts` (which a
 * project New project built cuts to what it inventories), else null.
 */
export async function currentDescription(config: ProjectConfig): Promise<LibraryDescription | null> {
  const { package: name, version, parts } = config.library;
  const shipped = DESCRIBED_VERSIONS.find((entry) => entry.package === name && entry.version === version);
  if (shipped) return shipped.describe();
  return parts ? { package: name, version, parts } : null;
}
