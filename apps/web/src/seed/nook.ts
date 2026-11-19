import { parseProjectConfig, parsePrototype, type ProjectConfig, type Prototype } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";

/**
 * The project the app opens with when it has none: core's worked example,
 * Nook on Todae, with its legal booking prototype twice: in TSX, and as
 * json-render specs. Both are read from the files core's own tests read, so
 * the seed and the regression fixtures cannot drift apart.
 */
const ROOT = "../../../../packages/core/examples/nook/prototypes/legal/booking/";
const raw = import.meta.glob("../../../../packages/core/examples/nook/prototypes/legal/booking/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const SPEC_ROOT = "../../../../packages/core/examples/nook/prototypes/spec/legal/booking/";
const specRaw = import.meta.glob("../../../../packages/core/examples/nook/prototypes/spec/legal/booking/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export const SEED_PROTOTYPE_ID = "booking";
export const SEED_SPEC_PROTOTYPE_ID = "booking-spec";

function prototypeFrom(root: string, texts: Record<string, string>): Prototype {
  const files: Record<string, string> = {};
  let manifest: unknown = null;
  for (const [path, text] of Object.entries(texts)) {
    const relative = path.slice(root.length);
    if (relative === "manifest.json") manifest = JSON.parse(text);
    else files[relative] = text;
  }
  const prototype = parsePrototype({ ...(manifest as object), files });
  if (!prototype.ok) throw new Error("the Nook seed does not validate");
  return prototype.value;
}

/**
 * The seed's views: core's two light ones, and the same two in the dark
 * scheme, so "AA in light and dark" is something the board shows. Core's
 * own example keeps two views: its hand-written snapshots are light.
 */
export const SEED_VIEWS: ProjectConfig["views"] = [...nook.views, ...nook.views.map((view) => ({ ...view, name: `${view.name}-dark`, scheme: "dark" as const }))];

export function seedProject(): { readonly config: ProjectConfig; readonly prototype: Prototype; readonly spec: Prototype } {
  const config = parseProjectConfig(JSON.parse(JSON.stringify({ ...nook, views: SEED_VIEWS })));
  if (!config.ok) throw new Error("the Nook seed does not validate");
  return { config: config.value, prototype: prototypeFrom(ROOT, raw), spec: prototypeFrom(SPEC_ROOT, specRaw) };
}
