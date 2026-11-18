import { specCatalog, type ProjectConfig, type Prototype } from "@design-harness/core";

/** Making a new prototype: its format, its empty start, and its id. */

/** What a new prototype is written in. Spec is the default; TSX stays selectable. */
export type PrototypeFormat = "spec" | "tsx";

/** The format a new prototype starts in: spec, unless the project's library has no part description to check specs against. */
export function defaultFormat(config: ProjectConfig): PrototypeFormat {
  return specCatalog(config) ? "spec" : "tsx";
}

/**
 * An empty prototype in a format: no files, pages, layouts or scenarios yet,
 * for the agent or the code view to build. A spec prototype says so in its
 * manifest; a TSX one leaves `format` out, as every TSX prototype does.
 */
export function blankPrototype(format: PrototypeFormat): Prototype {
  return { ...(format === "spec" ? { format: "spec" as const } : {}), files: {}, pages: [], layouts: [], scenarios: [], flow: { states: [], tasks: [] } };
}

/** A prototype id from its name, unique among `taken`: "Booking (spec)" is "booking-spec", then "booking-spec-2". */
export function prototypeId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "prototype";
  let id = base;
  for (let count = 2; taken.includes(id); count += 1) id = `${base}-${count}`;
  return id;
}

