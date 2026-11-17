import { parseProjectConfig, parsePrototype, type ProjectConfig, type Prototype } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";

/**
 * The project the app opens with when it has none: core's worked example,
 * Nook on Todae, and its legal booking prototype, read from the files core's
 * own tests read, so the seed and the regression fixtures cannot drift apart.
 */
const ROOT = "../../../../packages/core/examples/nook/prototypes/legal/booking/";
const raw = import.meta.glob("../../../../packages/core/examples/nook/prototypes/legal/booking/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export const SEED_PROTOTYPE_ID = "booking";

export function seedProject(): { readonly config: ProjectConfig; readonly prototype: Prototype } {
  const files: Record<string, string> = {};
  let manifest: unknown = null;
  for (const [path, text] of Object.entries(raw)) {
    const relative = path.slice(ROOT.length);
    if (relative === "manifest.json") manifest = JSON.parse(text);
    else files[relative] = text;
  }
  const config = parseProjectConfig(JSON.parse(JSON.stringify(nook)));
  const prototype = parsePrototype({ ...(manifest as object), files });
  if (!config.ok || !prototype.ok) throw new Error("the Nook seed does not validate");
  return { config: config.value, prototype: prototype.value };
}
