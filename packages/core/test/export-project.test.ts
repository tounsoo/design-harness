import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nook } from "../examples/nook/project";
import { checkPrototype } from "../src/engine/check";
import { EXPORT_TOOLING, exportReactProject } from "../src/export/project";
import { parsePrototype } from "../src/parse";
import { EXAMPLES, loadPrototype } from "./fixtures";

/** A prototype as a runnable React project: its files, its pins, and its prototype read back by core. */

const spec = loadPrototype(join(EXAMPLES, "spec", "legal", "booking"));
const tsx = loadPrototype(join(EXAMPLES, "legal", "booking"));
const at = "2026-11-18T12:00:00.000Z";
const root = join(import.meta.dirname, "..", "..", "..");

function project(prototype = spec, name = "Booking (spec)") {
  const result = exportReactProject({ config: nook, prototype, name, at, checks: "pass: every rule passes" });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("a spec prototype exported as a React project", () => {
  const exported = project();

  it("has the project's files around one TSX file per page and layout", () => {
    expect(exported.folder).toBe("nook-booking-spec");
    expect(Object.keys(exported.files).sort()).toEqual([
      "README.md",
      "index.html",
      "package.json",
      "src/main.tsx",
      "src/page-kit.tsx",
      "src/prototype/layouts/room-cards.tsx",
      "src/prototype/layouts/room-details.tsx",
      "src/prototype/layouts/select-question.tsx",
      "src/prototype/manifest.json",
      "src/prototype/pages/booking.tsx",
      "src/prototype/pages/rooms.tsx",
      "src/scenarios.ts",
      "src/shell.css",
      "tsconfig.json",
      "vite.config.ts",
    ]);
  });

  it("pins the exact library and React versions of the project config, and the tools this repository builds with", () => {
    const manifest = JSON.parse(exported.files["package.json"] as string) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(manifest.dependencies).toEqual({ "@tounsoo/todae": "0.11.3", react: "19.3.1", "react-dom": "19.3.1" });
    for (const [name, version] of Object.entries(EXPORT_TOOLING)) {
      expect(manifest.devDependencies[name]).toBe(version);
      const installed = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")) as { version: string };
      expect(installed.version, `${name} is installed at the version the export pins`).toBe(version);
    }
  });

  it("holds a TSX prototype core reads back and passes, with the spec's manifest", () => {
    const files = Object.fromEntries(Object.entries(exported.files).filter(([path]) => path.startsWith("src/prototype/") && path !== "src/prototype/manifest.json").map(([path, text]) => [path.slice("src/prototype/".length), text]));
    const manifest = JSON.parse(exported.files["src/prototype/manifest.json"] as string) as Record<string, unknown>;
    const parsed = parsePrototype({ ...manifest, files });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.scenarios).toEqual(spec.scenarios);
    expect(checkPrototype({ config: nook, prototype: parsed.value }).findings).toEqual([]);
  });

  it("says where it came from, and wires the page kit and the library's stylesheet", () => {
    expect(exported.files["README.md"]).toMatch(/^# Booking \(spec\)\n\nExported from design-harness on 2026-11-18T12:00:00\.000Z: prototype "Booking \(spec\)" of project "Nook" \(`nook`\), on @tounsoo\/todae 0\.11\.3 and React 19\.3\.1\./);
    expect(exported.files["README.md"]).toContain("Core's checks at export: pass: every rule passes.");
    expect(exported.files["vite.config.ts"]).toContain('"@design-harness/page": fileURLToPath(new URL("./src/page-kit.tsx", import.meta.url))');
    expect(exported.files["src/main.tsx"]).toContain('import "@tounsoo/todae/dist/todae.css";');
    // TypeScript 6 checks side-effect imports, so the project's tsconfig names the types that declare a stylesheet.
    expect((JSON.parse(exported.files["tsconfig.json"] as string) as { compilerOptions: { types: string[] } }).compilerOptions.types).toEqual(["vite/client"]);
    expect(exported.files["src/main.tsx"]).toContain('document.documentElement.setAttribute("data-appearance", "light");');
    expect(exported.files["src/scenarios.ts"]).toContain('import BookingPage from "./prototype/pages/booking";');
  });

  it("is the same project for the same input", () => {
    expect(project()).toEqual(exported);
  });
});

describe("a TSX prototype exported as a React project", () => {
  it("has the same shape, with the prototype's files as they are", () => {
    const exported = project(tsx, "Booking");
    for (const [path, text] of Object.entries(tsx.files)) expect(exported.files[`src/prototype/${path}`]).toBe(text);
    expect(exported.files["src/scenarios.ts"]).toContain('import { BookingPage } from "./prototype/pages/booking";');
    expect(exported.files["src/scenarios.ts"]).toContain('import RoomsPage from "./prototype/pages/rooms";');
    expect(exported.notes).toEqual([]);
  });
});
