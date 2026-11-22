// Turns the built app into Vercel's prebuilt output (Build Output API v3), so
// Vercel serves what CI built and tested and never builds anything itself.
// Usage: node scripts/vercel-output.mjs <built app dir> <output dir>
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_HEADERS } from "./app-headers.mjs";

const [from, to] = process.argv.slice(2);
if (!from || !to) throw new Error("Usage: node scripts/vercel-output.mjs <built app dir> <output dir>");
if (!existsSync(join(from, "index.html"))) throw new Error(`${from} has no index.html: build the app first.`);

rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
cpSync(from, join(to, "static"), { recursive: true });

const config = {
  version: 3,
  routes: [
    {
      src: "/(.*)",
      headers: APP_HEADERS,
      continue: true,
    },
    // Vite names these files by content hash, so they never change.
    { src: "/assets/(.*)", headers: { "Cache-Control": "public, max-age=31536000, immutable" }, continue: true },
    { handle: "filesystem" },
  ],
};
writeFileSync(join(to, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
console.log(`Prebuilt output for Vercel written to ${to}.`);
