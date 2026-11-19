import { specCatalog, type ProjectConfig, type Prototype } from "@design-harness/core";

/** Making a new prototype: its empty start, whether the project can take one, and its id. */

/**
 * Why a new prototype cannot be made in this project, or null when it can. A
 * prototype is a spec, and a spec is checked against the catalog the
 * project's library description gives; a project with no description has
 * none.
 */
export function cannotCreate(config: ProjectConfig): string | null {
  return specCatalog(config) ? null : "The project's library has no part description, so a spec prototype cannot be checked here. Import a project file whose config has library.parts to make one.";
}

/** An empty spec prototype: no files, pages, layouts or scenarios yet, for the agent or the code view to build. */
export function blankPrototype(): Prototype {
  return { format: "spec", files: {}, pages: [], layouts: [], scenarios: [], flow: { states: [], tasks: [] } };
}

/** A prototype id from its name, unique among `taken`: "Booking (spec)" is "booking-spec", then "booking-spec-2". */
export function prototypeId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "prototype";
  let id = base;
  for (let count = 2; taken.includes(id); count += 1) id = `${base}-${count}`;
  return id;
}
