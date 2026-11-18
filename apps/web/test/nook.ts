import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Prototype } from "@design-harness/core";

const PROTOTYPES = join(import.meta.dirname, "..", "..", "..", "packages", "core", "examples", "nook", "prototypes");

/** The legal Nook prototype read from core's example folder, for tests that run in Node. */
export function seedLegal(): Prototype {
  return readPrototype(join(PROTOTYPES, "legal", "booking"));
}

/** The legal Nook prototype as json-render specs. */
export function seedSpec(): Prototype {
  return readPrototype(join(PROTOTYPES, "spec", "legal", "booking"));
}

function readPrototype(root: string): Prototype {
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
