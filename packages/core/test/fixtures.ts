import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Prototype } from "../src/prototype/types";

/**
 * Reads prototypes written as folders, so the fixtures are real TSX files a
 * person can open: every file but `manifest.json` and `case.json` is a source
 * file, keyed by its path inside the folder.
 */

export const EXAMPLES = join(import.meta.dirname, "..", "examples", "nook", "prototypes");

function filesUnder(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(root, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}

type Manifest = Omit<Prototype, "files">;

export function loadPrototype(dir: string): Prototype {
  const files = filesUnder(dir);
  const manifest = JSON.parse(files["manifest.json"] ?? "{}") as Manifest;
  delete files["manifest.json"];
  return { ...manifest, files };
}

/** One expected failure: the rule, and a fragment of one of its findings' messages. */
export type Expected = { readonly rule: string; readonly message: string };

/**
 * An illegal case: the legal prototype with some files replaced (under the
 * case's `files/`), some removed, parts of the manifest replaced, and caps
 * changed, failing for the reasons `expect` names and no other.
 */
export type CaseFile = {
  readonly what: string;
  readonly expect: readonly Expected[];
  readonly remove?: readonly string[];
  readonly manifest?: Partial<Manifest>;
  readonly caps?: Readonly<Record<string, number>>;
};

export type IllegalCase = CaseFile & { readonly name: string; readonly prototype: Prototype };

export function loadCases(base: Prototype, root: string): IllegalCase[] {
  return readdirSync(root)
    .sort()
    .map((name) => {
      const dir = join(root, name);
      const spec = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as CaseFile;
      let overrides: Record<string, string> = {};
      try {
        overrides = filesUnder(join(dir, "files"));
      } catch {
        overrides = {};
      }
      const files = { ...base.files, ...overrides };
      for (const path of spec.remove ?? []) delete files[path];
      return { ...spec, name, prototype: { ...base, ...spec.manifest, files } };
    });
}
