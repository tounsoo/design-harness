import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Prototype } from "@design-harness/core";

/** The legal Nook prototype read from core's example folder, for tests that run in Node. */
export function seedLegal(): Prototype {
  const root = join(import.meta.dirname, "..", "..", "..", "packages", "core", "examples", "nook", "prototypes", "legal", "booking");
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files[relative(root, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  const manifest = JSON.parse(files["manifest.json"] ?? "{}") as Omit<Prototype, "files">;
  delete files["manifest.json"];
  return { ...manifest, files };
}
