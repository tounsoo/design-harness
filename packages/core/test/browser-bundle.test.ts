import { build } from "esbuild";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { nook } from "../examples/nook/project";
import { legalSnapshots } from "../examples/nook/snapshots";
import { checkPrototype } from "../src/engine/check";
import { EXAMPLES, loadCases, loadPrototype } from "./fixtures";

/**
 * Proves the library is environment-neutral by running it where neither Node
 * nor a browser is: the bundle esbuild makes for the browser platform (which
 * refuses Node built-ins), evaluated in a fresh realm that has only the
 * ECMAScript globals: no process, require, console, window, document or fetch.
 */
async function bundle(): Promise<string> {
  const result = await build({
    entryPoints: [join(import.meta.dirname, "../src/index.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "core",
    target: "es2022",
    minify: true,
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0]?.text ?? "";
}

describe("the browser bundle", () => {
  it("runs in a realm with no Node or DOM globals and reports exactly what Node does", async () => {
    const code = await bundle();
    const realm = createContext({});
    // V8 gives every context a console; take it away so nothing can lean on it.
    runInContext("delete globalThis.console", realm);
    runInContext(code, realm);
    expect(runInContext("[typeof process, typeof require, typeof window, typeof document, typeof console, typeof fetch].join()", realm)).toBe("undefined,undefined,undefined,undefined,undefined,undefined");

    const legal = loadPrototype(join(EXAMPLES, "legal", "booking"));
    const spec = loadPrototype(join(EXAMPLES, "spec", "legal", "booking"));
    const inputs = [
      { config: nook, prototype: legal, snapshots: legalSnapshots() },
      ...loadCases(legal, join(EXAMPLES, "illegal")).map((item) => ({ config: nook, prototype: item.prototype })),
      // Spec prototypes: read with core's own JSON parser, so a file that does not parse reads the same in every engine.
      { config: nook, prototype: spec, snapshots: legalSnapshots() },
      ...["illegal", "refused"].flatMap((kind) => loadCases(spec, join(EXAMPLES, "spec", kind)).map((item) => ({ config: nook, prototype: item.prototype }))),
    ];
    for (const input of inputs) {
      realm.input = JSON.stringify(input);
      const inRealm = runInContext("JSON.stringify(core.checkPrototype(JSON.parse(input)))", realm) as string;
      expect(inRealm).toBe(JSON.stringify(checkPrototype(input)));
    }
  });
});
