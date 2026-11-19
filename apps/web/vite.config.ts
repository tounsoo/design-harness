import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const FRAME_RUNTIME = "virtual:frame-runtime";
const RESOLVED = `\0${FRAME_RUNTIME}`;
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Builds the code that runs inside a frame, which Vite cannot serve as a
 * module there (a frame has an opaque origin and loads nothing from the
 * app): the boot script as one classic IIFE, inlined into each frame's
 * document, the page kit as one ES module whose React imports the frame's
 * import map resolves, and the spec renderer, which a spec prototype's
 * frames import. `virtual:frame-runtime` exports the three as text.
 */
function frameRuntime(): Plugin {
  const bundle = async (entry: string, format: "iife" | "esm", external: string[]) => {
    const result = await build({
      absWorkingDir: source("."),
      entryPoints: [source(entry)],
      bundle: true,
      format,
      platform: "browser",
      target: "es2022",
      minify: true,
      legalComments: "none",
      write: false,
      external,
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      metafile: true,
      logLevel: "silent",
    });
    return { code: result.outputFiles[0]?.text ?? "", inputs: Object.keys(result.metafile.inputs) };
  };
  return {
    name: "design-harness:frame-runtime",
    resolveId(id) {
      return id === FRAME_RUNTIME ? RESOLVED : null;
    },
    async load(id) {
      if (id !== RESOLVED) return null;
      const [boot, kit, spec] = await Promise.all([
        bundle("./src/frame/boot.ts", "iife", []),
        bundle("./src/frame/kit.tsx", "esm", ["react", "react/jsx-runtime", "react-dom", "react-dom/client"]),
        // The spec renderer: a registry over the library, and json-render's Renderer, which the import map supplies.
        bundle("./src/frame/spec.tsx", "esm", ["react", "react/jsx-runtime", "react-dom", "@json-render/react"]),
      ]);
      for (const input of [...boot.inputs, ...kit.inputs, ...spec.inputs]) if (!input.includes("node_modules")) this.addWatchFile(source(`./${input}`));
      return `export const boot = ${JSON.stringify(boot.code)};\nexport const kit = ${JSON.stringify(kit.code)};\nexport const spec = ${JSON.stringify(spec.code)};\n`;
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [frameRuntime()],
  esbuild: { jsx: "automatic" },
  // The check worker is a module worker (src/runtime/check-worker.ts), split into chunks like the app.
  worker: { format: "es" },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      // Todae marks its entry "use client", which means nothing in a client-only app.
      onwarn(warning, warn) {
        if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
      },
    },
  },
  preview: { port: 4173, strictPort: false },
});
