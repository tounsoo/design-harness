import type { PageType, ProjectConfig } from "../config/types";
import { PAGE_KIT } from "../extract/evaluator";
import type { Prototype } from "../prototype/types";
import { fresh, isIdentifier, pascal } from "./names";
import { specToTsx } from "./tsx";

/**
 * A prototype as a runnable React project: the place the spec format turns
 * back into product code. A spec prototype is written as TSX first
 * (tsx.ts); a TSX prototype's files go in as they are. Around them, the
 * least a Vite app needs: an entry with a scenario switcher, the page kit
 * the pages import, and a package.json pinning the exact library and React
 * versions of the project config. Pure: the caller gives the time.
 */

/** Development tools the project builds with, pinned exactly: the versions this repository builds and tests the export with. */
export const EXPORT_TOOLING = { vite: "7.3.8", typescript: "5.9.3", "@types/react": "19.3.0", "@types/react-dom": "19.3.0" } as const;

/** Where the prototype's own files go in the project, beside the entry and the page kit. */
export const EXPORT_PROTOTYPE_DIR = "src/prototype";

export type ProjectExportInput = {
  readonly config: ProjectConfig;
  readonly prototype: Prototype;
  /** The prototype's name, as the app shows it. */
  readonly name: string;
  /** When it was exported, ISO 8601. */
  readonly at: string;
  /** Core's report at export, in a few words, such as "pass: every rule passes". */
  readonly checks?: string;
};

export type ProjectExport = {
  /** The project's folder name: the prototype's name as a slug. */
  readonly folder: string;
  /** Path inside the folder → text. */
  readonly files: Readonly<Record<string, string>>;
  /** The prototype as it is in the project: TSX, with the same manifest. */
  readonly prototype: Prototype;
  readonly notes: readonly string[];
};

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function slugOf(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "prototype"
  );
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function pageKit(): string {
  return `import { createContext, useContext, type CSSProperties, type ReactNode } from "react";

/**
 * The page kit the pages import as "${PAGE_KIT}" (vite.config.ts and
 * tsconfig.json point that name here). A page fills its page type's slots
 * with Slot, and PageShell arranges them the way design-harness's frames
 * do: the page type's order, and on a wide screen the slots after the last
 * body slot (an action page's primary action and its alternates) side by
 * side under the body.
 */

/** What a page component receives: the scenario it is rendered for, and that scenario's flow state. */
export type PageProps = { readonly scenario: string; readonly state: string };

/** A page type as the project config describes it. */
export type PageType = { readonly id: string; readonly slots: readonly string[]; readonly chrome: readonly string[]; readonly primarySlot?: string };

type Place = { readonly order: number; readonly trail: boolean; readonly known: boolean };

const UNKNOWN: Place = { order: 10000, trail: false, known: false };
const Places = createContext<(name: string) => Place>(() => UNKNOWN);

function placesOf(type: PageType): Map<string, Place> {
  const isBody = (slot: string) => !type.chrome.includes(slot) && slot !== type.primarySlot;
  const body = type.slots.map((slot, index) => (isBody(slot) ? index : -1)).filter((index) => index >= 0);
  const last = body.length > 0 ? Math.max(...body) : type.slots.length - 1;
  return new Map(type.slots.map((slot, index) => [slot, { order: index, trail: index > last, known: true }]));
}

/** Fills the page type's slot \`name\`. */
export function Slot({ name, children }: { readonly name: string; readonly children?: ReactNode }) {
  const place = useContext(Places)(name);
  return (
    <div className="page-slot" data-slot={name} data-trail={place.trail ? "" : undefined} style={{ order: place.order }}>
      {children}
    </div>
  );
}

/** Lays out a page of this type. */
export function PageShell({ type, children }: { readonly type: PageType; readonly children: ReactNode }) {
  const places = placesOf(type);
  const trail = [...places.values()].filter((place) => place.trail).length;
  return (
    <Places.Provider value={(name) => places.get(name) ?? UNKNOWN}>
      <div className="page-shell" data-page-type={type.id} style={{ "--page-trail": String(trail) } as CSSProperties}>
        {children}
      </div>
    </Places.Provider>
  );
}
`;
}

const SHELL_CSS = `/* The page shell's layout, as design-harness's frames draw it. */
:where(html) { font-family: system-ui, sans-serif; line-height: 1.5; }
body { margin: 0; }
.page-shell { box-sizing: border-box; display: grid; grid-template-columns: repeat(var(--page-trail, 0), auto) 1fr; align-items: start; column-gap: 12px; row-gap: 16px; max-width: 760px; margin: 0 auto; padding: 40px 24px; }
.page-slot { grid-column: 1 / -1; min-width: 0; }
.page-slot[data-trail] { grid-column: auto; }
.scenario-bar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 8px 24px; border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent); font-size: 14px; }
.scenario-bar select { font: inherit; min-height: 24px; }
@media (max-width: 599.98px) {
  .page-shell { grid-template-columns: 1fr; padding: 24px 16px; row-gap: 12px; }
  .page-slot[data-trail] { grid-column: 1 / -1; }
}
`;

function mainFile(config: ProjectConfig): string {
  const styles = (config.library.stylesheets ?? []).map((path) => `import "${config.library.package}/${path}";`);
  const scheme = config.library.schemeAttribute ? `\ndocument.documentElement.setAttribute(${JSON.stringify(config.library.schemeAttribute)}, "light");` : "";
  return `import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
${styles.join("\n")}${styles.length > 0 ? "\n" : ""}import "./shell.css";
import { PageShell } from "./page-kit";
import { pages, scenarios } from "./scenarios";

/**
 * The prototype's scenarios, one at a time: pick one, and its page renders
 * with that scenario's flow state, as design-harness renders each frame.
 * ?scenario=<id> opens one directly.
 */
function App() {
  const [id, setId] = useState(() => new URLSearchParams(window.location.search).get("scenario") ?? scenarios[0]?.id ?? "");
  const scenario = scenarios.find((item) => item.id === id) ?? scenarios[0];
  if (!scenario) return <p>This prototype has no scenarios.</p>;
  const page = pages[scenario.page];
  const choose = (next: string) => {
    setId(next);
    const url = new URL(window.location.href);
    url.searchParams.set("scenario", next);
    window.history.replaceState(null, "", url);
  };
  return (
    <>
      <div className="scenario-bar">
        <label>
          Scenario{" "}
          <select value={scenario.id} onChange={(event) => choose(event.target.value)}>
            {scenarios.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} (state {item.state}, page {item.page})
              </option>
            ))}
          </select>
        </label>
      </div>
      <main>
        {page ? (
          <PageShell type={page.type}>
            <page.component key={scenario.id} scenario={scenario.id} state={scenario.state} />
          </PageShell>
        ) : (
          <p>Scenario {scenario.id} names page {scenario.page}, which this prototype does not have.</p>
        )}
      </main>
    </>
  );
}
${scheme}
const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);
`;
}

function scenariosFile(prototype: Prototype, config: ProjectConfig): string {
  const taken = new Set<string>(["pages", "scenarios", "PageProps", "PageType", "ComponentType"]);
  const imports: string[] = [];
  const entries: string[] = [];
  for (const page of [...prototype.pages].sort((a, b) => compare(a.id, b.id))) {
    const local = fresh(pascal(`${page.id}-page`), taken);
    const from = `./prototype/${page.component.file.replace(/\.(tsx|ts|jsx|js)$/, "")}`;
    const exported = page.component.export;
    imports.push(exported === "default" ? `import ${local} from "${from}";` : `import { ${exported === local ? local : `${exported} as ${local}`} } from "${from}";`);
    const type = config.inventories.pageTypes.find((item) => item.id === page.pageType);
    const shape: PageType | { id: string; slots: readonly string[]; chrome: readonly string[] } = type ?? { id: page.pageType, slots: [], chrome: [] };
    const fields = [`id: ${JSON.stringify(shape.id)}`, `slots: ${JSON.stringify(shape.slots)}`, `chrome: ${JSON.stringify(shape.chrome)}`, ...("primarySlot" in shape ? [`primarySlot: ${JSON.stringify(shape.primarySlot)}`] : [])];
    entries.push(`  ${isIdentifier(page.id) ? page.id : JSON.stringify(page.id)}: { component: ${local}, type: { ${fields.join(", ")} } },`);
  }
  const scenarios = prototype.scenarios.map((scenario) => `  { id: ${JSON.stringify(scenario.id)}, state: ${JSON.stringify(scenario.state)}, page: ${JSON.stringify(scenario.page)} },`);
  return `import type { ComponentType } from "react";
import type { PageProps, PageType } from "./page-kit";
${imports.join("\n")}

/** Each page of the prototype, with its page type's slots, as the project config describes them. */
export const pages: Readonly<Record<string, { readonly component: ComponentType<PageProps>; readonly type: PageType }>> = {
${entries.join("\n")}
};

/** The prototype's scenarios: a page rendered in one flow state. */
export const scenarios: readonly { readonly id: string; readonly state: string; readonly page: string }[] = [
${scenarios.join("\n")}
];
`;
}

function readme(input: ProjectExportInput, folder: string, prototype: Prototype, notes: readonly string[]): string {
  const { config } = input;
  const spec = input.prototype.format === "spec";
  const files = Object.keys(prototype.files)
    .sort(compare)
    .map((path) => `- \`${EXPORT_PROTOTYPE_DIR}/${path}\``);
  const scenarios = prototype.scenarios.map((scenario) => `- \`${scenario.id}\`: page \`${scenario.page}\` in flow state \`${scenario.state}\``);
  return `# ${input.name}

Exported from design-harness on ${input.at}: prototype "${input.name}" of project "${config.name}" (\`${config.id}\`), on ${config.library.package} ${config.library.version} and React ${config.library.react}.

${
  spec
    ? "The prototype was written as json-render specs. design-harness core wrote each page and each layout as React: a layout is a component whose props are its parameters, a page's state is data (and `useState` for what the person can change), and a page reads its scenario from its `scenario` and `state` props."
    : "The prototype was written as TSX; its files are here as they were."
}${input.checks ? `\n\nCore's checks at export: ${input.checks}.` : ""}

## Run it

\`\`\`sh
npm install
npm run dev        # Vite's dev server; pick a scenario at the top
npm run build      # a static build in dist/
npm run typecheck  # TypeScript, no output
\`\`\`

\`?scenario=<id>\` opens one scenario directly.

## What is here

- \`${EXPORT_PROTOTYPE_DIR}/\`: the prototype. Its pages and layouts import only ${config.library.package}, React, and \`${PAGE_KIT}\`, the page kit.
${files.join("\n")}
- \`${EXPORT_PROTOTYPE_DIR}/manifest.json\`: the prototype's pages, layouts, scenarios and flow, as design-harness reads them. Together with the files above it is a TSX prototype design-harness can check: core gives it the same report as the prototype it was exported from, unless core refused part of a spec (then the next section says so).
- \`src/page-kit.tsx\`: \`Slot\`, \`PageProps\` and the page shell, which arranges a page type's slots. \`vite.config.ts\` and \`tsconfig.json\` point \`${PAGE_KIT}\` at it.
- \`src/scenarios.ts\`: each page with its page type, and the scenarios.
- \`src/main.tsx\`: the entry, with the scenario switcher.

## Scenarios

${scenarios.join("\n") || "None."}
${notes.length > 0 ? `\n## What the export could not carry over\n\n${notes.map((note) => `- ${note}`).join("\n")}\n` : ""}
The folder is \`${folder}\`.
`;
}

/** The whole project: every file by path inside its folder. Refused only when a spec prototype cannot be read. */
export function exportReactProject(input: ProjectExportInput): { ok: true; value: ProjectExport } | { ok: false; error: string } {
  const { config } = input;
  let prototype = input.prototype;
  let notes: readonly string[] = [];
  if (prototype.format === "spec") {
    const written = specToTsx(prototype, config);
    if (!written.ok) return written;
    prototype = written.value.prototype;
    notes = written.value.notes;
  }
  const folder = slugOf(`${config.id} ${input.name}`);
  const { files: source, ...manifest } = prototype;
  const tsxManifest = { ...manifest, format: "tsx" as const };
  const files: Record<string, string> = {};
  files["package.json"] = json({
    name: folder,
    private: true,
    version: "0.0.0",
    type: "module",
    description: `${input.name}, a ${config.name} prototype exported from design-harness.`,
    scripts: { dev: "vite", build: "vite build", preview: "vite preview", typecheck: "tsc --noEmit" },
    dependencies: { [config.library.package]: config.library.version, react: config.library.react, "react-dom": config.library.react },
    devDependencies: { ...EXPORT_TOOLING },
  });
  files["README.md"] = readme(input, folder, prototype, notes);
  files["index.html"] = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="data:," />
    <title>${input.name.replace(/[<&]/g, "")} (${config.name.replace(/[<&]/g, "")})</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
  files["vite.config.ts"] = `import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The pages import their page kit as "${PAGE_KIT}": here it is src/page-kit.tsx.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "${PAGE_KIT}": fileURLToPath(new URL("./src/page-kit.tsx", import.meta.url)) } },
});
`;
  files["tsconfig.json"] = json({
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      module: "ESNext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      isolatedModules: true,
      allowImportingTsExtensions: false,
      paths: { [PAGE_KIT]: ["./src/page-kit.tsx"] },
    },
    include: ["src"],
  });
  files["src/main.tsx"] = mainFile(config);
  files["src/shell.css"] = SHELL_CSS;
  files["src/page-kit.tsx"] = pageKit();
  files["src/scenarios.ts"] = scenariosFile(prototype, config);
  files[`${EXPORT_PROTOTYPE_DIR}/manifest.json`] = json(tsxManifest);
  for (const path of Object.keys(source).sort(compare)) files[`${EXPORT_PROTOTYPE_DIR}/${path}`] = source[path] as string;
  return { ok: true, value: { folder, files, prototype, notes } };
}
