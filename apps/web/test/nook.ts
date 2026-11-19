import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { specToTsx, type Prototype, type TsxPrototype } from "@design-harness/core";
import { nook } from "../../../packages/core/examples/nook/project";

const PROTOTYPES = join(import.meta.dirname, "..", "..", "..", "packages", "core", "examples", "nook", "prototypes");

/** The legal Nook prototype as json-render specs, read from core's example folder, for tests that run in Node. */
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

/**
 * A stored TSX prototype, as one was kept before every prototype was a spec:
 * here the legal spec as code export writes it, so its files are real TSX.
 * Core no longer reads it; the app keeps it for its files alone.
 */
export function seedTsx(): TsxPrototype {
  const written = specToTsx(seedSpec(), nook);
  if (!written.ok) throw new Error(written.error);
  return written.value.prototype;
}
