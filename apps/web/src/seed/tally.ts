import { parseProjectConfig, parsePrototype, type ProjectConfig, type Prototype } from "@design-harness/core";
import { tally } from "../../../../packages/core/examples/tally/project";

/**
 * Core's second worked example, Tally on Mantine, as a project a person can
 * add from the New project page: its config and its legal expense prototype,
 * read from the files core's own tests read. Loaded only when asked for,
 * since it carries Mantine's part descriptions.
 */
const ROOT = "../../../../packages/core/examples/tally/prototypes/spec/legal/expense/";
const raw = import.meta.glob("../../../../packages/core/examples/tally/prototypes/spec/legal/expense/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export const TALLY_PROTOTYPE_ID = "expense";

export function tallyProject(): { readonly config: ProjectConfig; readonly prototype: Prototype } {
  const files: Record<string, string> = {};
  let manifest: unknown = null;
  for (const [path, text] of Object.entries(raw)) {
    const relative = path.slice(ROOT.length);
    if (relative === "manifest.json") manifest = JSON.parse(text);
    else files[relative] = text;
  }
  const config = parseProjectConfig(JSON.parse(JSON.stringify(tally)));
  const prototype = parsePrototype({ ...(manifest as object), files });
  if (!config.ok || !prototype.ok) throw new Error("the Tally example does not validate");
  return { config: config.value, prototype: prototype.value };
}
