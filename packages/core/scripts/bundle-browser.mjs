// Bundles @design-harness/core for the browser and reports its size. esbuild's
// browser platform refuses to resolve Node built-ins, so a library import of
// one fails this build instead of shipping. Run with `npm run bundle:core`.
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  entryPoints: [join(root, "src/index.ts")],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  write: false,
  metafile: true,
  logLevel: "error",
});
const code = result.outputFiles[0].contents;
mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist/core.browser.min.js"), code);

const inputs = Object.entries(result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].inputs);
const parser = inputs.filter(([path]) => path.includes("@babel/parser")).reduce((sum, [, input]) => sum + input.bytesInOutput, 0);
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
console.log(`core, browser, minified: ${kb(code.byteLength)} (${code.byteLength} bytes)`);
console.log(`core, browser, minified and gzipped: ${kb(gzipSync(code).byteLength)} (${gzipSync(code).byteLength} bytes)`);
console.log(`of which @babel/parser, minified: ${kb(parser)}`);
console.log(`written to ${join("packages/core/dist/core.browser.min.js")}`);
