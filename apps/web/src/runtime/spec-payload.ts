import { resolvePageSpec, specCatalog, type ProjectConfig, type Prototype, type Scenario } from "@design-harness/core";
import type { SpecPart, SpecPayload } from "./protocol";

/** The module a spec prototype's frames import to draw a spec: the registry and json-render's Renderer. */
export const SPEC_RENDERER = "@design-harness/spec";

/** How the frame's registry draws each entry of the config's catalog. Layouts are drawn in by core before a spec is sent, so they have none. */
export function specParts(config: ProjectConfig): Readonly<Record<string, SpecPart>> {
  const catalog = specCatalog(config);
  const parts: Record<string, SpecPart> = {};
  for (const [type, component] of Object.entries(catalog?.components ?? {})) {
    if (component.kind === "layout") continue;
    const binds: Record<string, string> = {};
    for (const [name, schema] of Object.entries(component.props)) if ("bind" in schema && schema.bind) binds[name] = schema.bind;
    parts[type] = {
      kind: component.kind === "page" ? "page" : "part",
      content: component.content,
      props: Object.keys(component.props).filter((name) => name !== "text" && name !== "options"),
      binds,
      events: [...component.events],
    };
  }
  return parts;
}

/** What one frame of a spec prototype renders: the page as one spec for its scenario, as core resolved it, or null when the page's spec could not be read. */
export function specPayload(config: ProjectConfig, prototype: Prototype, scenario: Scenario, parts: Readonly<Record<string, SpecPart>> = specParts(config)): SpecPayload | null {
  const spec = resolvePageSpec(prototype, config, scenario);
  return spec ? { library: config.library.package, spec, parts } : null;
}
