/**
 * The library request workflow's logic (.github/workflows/library-request.yml).
 * A designer asks for a library from the New project wizard, which opens the
 * issue form filled in; this script answers the issue by doing what a person
 * did by hand to add a library, and opens a pull request for a person to
 * review. The workflow's YAML only runs its commands, one per job:
 *
 *   node apps/web/scripts/library-request.mjs parse     reads the issue, decides whether to go on (no write access)
 *   node apps/web/scripts/library-request.mjs prepare   checks npm, describes the library, adds it (no write access)
 *   node apps/web/scripts/library-request.mjs verify    runs every check, the build and the end-to-end test of the library (no write access)
 *   node apps/web/scripts/library-request.mjs publish   makes the same edits on a clean checkout, pushes a branch, opens the pull request
 *   node apps/web/scripts/library-request.mjs report    says on the issue why a run stopped
 *   node apps/web/scripts/library-request.mjs dry-run <package> <version> [stylesheet...]
 *                                                       prepare, then the summary a pull request would carry, here, with no GitHub
 *
 * The issue's text is written by anyone. It reaches this script only as the
 * event file GitHub writes (GITHUB_EVENT_PATH), never through the YAML's
 * expressions or a shell. `parseRequestIssue` accepts a package name,
 * version and stylesheet paths only in narrow shapes, and every command runs
 * with an argument list, never a shell. Each job reads the event again, so
 * nothing one job passes another is trusted to be valid.
 *
 * The package itself is untrusted code too. Every npm install runs with
 * --ignore-scripts, so none of it runs in Node: the describer reads its type
 * declarations, the vendor build bundles it, and only the end-to-end test
 * runs it, in Chromium, in a sandboxed frame. The jobs that install and test
 * it have read access alone; the job that pushes and opens the pull request
 * installs nothing from the request, makes the deterministic edits itself,
 * and takes only the description and the lockfile from the build, refusing
 * a change to any other file.
 */
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REQUEST_LABEL, parseRequestIssue, requestBranch, requestTitle, shown, validateLibraryRequest } from "./library-request-input.mjs";
import { aliasOf, satisfies, vendoredLibraries } from "./vendor-libraries.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");
const WEB_PACKAGE = "apps/web/package.json";
const LOCKFILE = "package-lock.json";
const REGISTRY = "apps/web/src/libraries/registry.ts";
const DESCRIPTIONS = "packages/core/libraries";
/** The name of the end-to-end test that runs on a requested library (apps/web/e2e/run.mjs). */
export const E2E_TEST = "a requested library";
/** Packages the app serves for itself, which are not component libraries. */
const NOT_LIBRARIES = new Set(["react", "react-dom", "@json-render/core", "@json-render/react", "@design-harness/core", "@design-harness/web"]);
const PART = /^[A-Z][A-Za-z0-9]*(?:\.[A-Z][A-Za-z0-9]*)*$/;

// ---- reading the event ------------------------------------------------------------------------------

/**
 * What to do with an `issues` event: `{ go: true, issue, request }`;
 * `{ go: false, issue, reason }` when the issue is a request that cannot go
 * on, which is said on the issue; or `{ go: false, issue: null|number, quiet }`
 * when the event is not a request to answer at all (another issue, a closed
 * one, a title edit), which is said nowhere.
 */
export function requestFromEvent(event, eventName) {
  const issue = event?.issue;
  if (eventName !== "issues" || typeof issue !== "object" || issue === null) return { go: false, issue: null, quiet: "not an issue event" };
  const number = Number.isSafeInteger(issue.number) && issue.number > 0 ? issue.number : null;
  if (number === null || issue.pull_request) return { go: false, issue: null, quiet: "not an issue" };
  const labels = Array.isArray(issue.labels) ? issue.labels.map((label) => (typeof label === "string" ? label : label?.name)) : [];
  if (!labels.includes(REQUEST_LABEL)) return { go: false, issue: number, quiet: `not labelled ${REQUEST_LABEL}` };
  if (issue.state !== "open") return { go: false, issue: number, quiet: "the issue is closed" };
  if (event.action === "edited" && !event.changes?.body) return { go: false, issue: number, quiet: "the edit left the fields as they were" };
  if (event.action !== "opened" && event.action !== "edited") return { go: false, issue: number, quiet: `the issue was ${shown(event.action)}` };
  const parsed = parseRequestIssue(issue.body);
  if (!parsed.ok) return { go: false, issue: number, reason: ["The request cannot go on as it is written:", ...parsed.errors.map((error) => `- ${error.message}`), "", "Edit the issue to fix it, and the workflow runs again."].join("\n") };
  if (NOT_LIBRARIES.has(parsed.value.package)) return { go: false, issue: number, reason: `${parsed.value.package} is not a component library: the app serves it for itself.` };
  return { go: true, issue: number, request: parsed.value };
}

function readEvent() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) throw new Error("GITHUB_EVENT_PATH is not set: this command runs in the library request workflow");
  return requestFromEvent(JSON.parse(readFileSync(path, "utf8")), process.env.GITHUB_EVENT_NAME);
}

// ---- the edits ----------------------------------------------------------------------------------------

/** The versions of `name` the app serves, from its package.json. */
export function servedVersions(packageJson, name) {
  return vendoredLibraries(packageJson)
    .filter((library) => library.package === name)
    .map((library) => library.version);
}

/**
 * The app's package.json with the library added: the dependency at its
 * exact version, under its own name when the app has no version of it yet
 * and under the npm alias `<package>-<version>` otherwise, and the version
 * with its stylesheets under `designHarness.libraries`. Dependencies stay in
 * name order, as npm writes them. Refuses a version already served.
 */
export function addToPackageJson(packageJson, request) {
  const { package: name, version, stylesheets } = request;
  if (servedVersions(packageJson, name).includes(version)) throw new RequestStop(`${name} ${version} is already served by this deployment.`);
  const dependencies = { ...(packageJson.dependencies ?? {}) };
  const install = Object.hasOwn(dependencies, name) ? aliasOf(name, version) : name;
  if (Object.hasOwn(dependencies, install)) throw new RequestStop(`The app already depends on "${install}", so ${name} ${version} cannot be added under that name.`);
  dependencies[install] = install === name ? version : `npm:${name}@${version}`;
  const sorted = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const libraries = JSON.parse(JSON.stringify(packageJson.designHarness?.libraries ?? {}));
  libraries[name] = { ...(libraries[name] ?? {}), [version]: [...stylesheets] };
  const next = { ...packageJson, dependencies: sorted, designHarness: { ...(packageJson.designHarness ?? {}), libraries } };
  vendoredLibraries(next);
  return { packageJson: next, install };
}

/** Where the description is committed: `packages/core/libraries/<package without @, / as ->-<version>.json`. */
export function descriptionPath(request) {
  return `${DESCRIPTIONS}/${request.package.replace(/^@/, "").replace("/", "-")}-${request.version}.json`;
}

/** The registry id of a requested library, unique among the ids the registry has. */
export function registryId(request, taken) {
  const base = `${request.package.replace(/^@/, "").replace(/[^a-z0-9]+/g, "-")}-${request.version.replace(/[^a-z0-9]+/g, "-")}`;
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

/** The parts in a description that could be the part every page renders inside: a provider or a theme. */
export function rootCandidates(description) {
  return Object.keys(description.parts)
    .filter((part) => PART.test(part) && !part.includes(".") && /(?:^Theme$|Provider$|^Theme(?:Root|Provider)$)/.test(part))
    .sort();
}

/**
 * What a person must check before the library is relied on, read from the
 * description and core's draft: roles drafted below high confidence, roles
 * with no part, a light and dark switch nobody set up, a part that may need
 * to wrap every page, and the library's own rules, of which it has none.
 */
export function needsChecking(description, draft) {
  const list = [];
  for (const guess of draft.guesses) if (guess.confidence !== "high") list.push(`The ${guess.role} role was drafted at ${guess.confidence} confidence: check it in New project.`);
  for (const item of draft.missing) list.push(`No part was found for the ${item.role} role.`);
  const roots = rootCandidates(description);
  list.push("Light and dark: the entry sets no scheme attribute and no root part, so every view draws the library's default scheme. Set `schemeAttribute`, or `root` with its `schemeProp`, if it has a switch.");
  if (roots.length > 0) list.push(`It has ${roots.map((part) => `\`${part}\``).join(", ")}, which may need to be the part every page renders inside (\`setup.root\`).`);
  list.push("It has no rules of its own (`setup.rules`), such as Todae's for Text.Root and Mantine's for Title: add one where a part needs a prop the built-in rules do not ask for.");
  list.push("`about` and `notes` are the workflow's words: say what the library is.");
  return list;
}

/** One TypeScript entry of `SHIPPED_LIBRARIES` for the request, with a comment of what a person must check. Every value written is a JSON literal. */
export function registryEntry(request, description, draft, { id, issue }) {
  const action = draft.guesses.find((guess) => guess.role === "action")?.mapping.components[0];
  const example = [action, ...Object.keys(description.parts)].find((part) => part !== undefined && PART.test(part));
  const namespaced = example?.includes(".");
  const about = `Requested in issue #${issue}.${example ? ` Parts are ${namespaced ? "namespaced" : "plain components"}, such as ${example}.` : ""}`;
  const notes = [`Added by the library request workflow from issue #${issue}.`, "Light and dark are not set up: every view draws the library's default scheme."];
  const file = descriptionPath(request).slice(DESCRIPTIONS.length + 1);
  const check = needsChecking(description, draft).map((line) => `    //   - ${line.replace(/\*\//g, "* /")}`);
  return [
    "  {",
    `    // Added by the library request workflow from issue #${issue}. A person must check:`,
    ...check,
    `    id: ${JSON.stringify(id)},`,
    `    name: ${JSON.stringify(request.package)},`,
    `    package: ${JSON.stringify(request.package)},`,
    `    version: ${JSON.stringify(request.version)},`,
    `    about: ${JSON.stringify(about)},`,
    "    setup: {",
    "      react: FRAME_REACT,",
    `      stylesheets: ${JSON.stringify(request.stylesheets)},`,
    "    },",
    `    notes: ${JSON.stringify(notes)},`,
    `    describe: async () => (await import(${JSON.stringify(`../../../../packages/core/libraries/${file}`)})).default as unknown as LibraryDescription,`,
    "  },",
  ].join("\n");
}

/** The registry's source with the entry added at the end of `SHIPPED_LIBRARIES`. Refuses a registry whose list it cannot find exactly once. */
export function addRegistryEntry(source, entry) {
  const start = source.indexOf("export const SHIPPED_LIBRARIES: readonly ShippedLibrary[] = [\n");
  if (start < 0 || source.indexOf("export const SHIPPED_LIBRARIES", start + 1) >= 0) throw new Error(`${REGISTRY} has no SHIPPED_LIBRARIES list in the shape this script edits`);
  const end = source.indexOf("\n];\n", start);
  if (end < 0) throw new Error(`${REGISTRY}: the end of SHIPPED_LIBRARIES ("];" on a line of its own) was not found`);
  return `${source.slice(0, end)}\n${entry}${source.slice(end)}`;
}

/** Whether the registry has an entry for this package and version. */
export function isListed(source, request) {
  return source.includes(`    package: ${JSON.stringify(request.package)},\n    version: ${JSON.stringify(request.version)},\n`);
}

/** The ids the registry has. */
export function registryIds(source) {
  return [...source.matchAll(/^ {4}id: "([^"]+)",$/gm)].map((match) => match[1]);
}

/**
 * Whether npm's manifest of the exact version can be added: it is that
 * version, it declares TypeScript types the describer can read (`types` or
 * `typings`, or a `types` condition in `exports["."]`), and it accepts the
 * React frames render with. Returns the problems, in words for the issue.
 */
export function manifestProblems(manifest, request, react) {
  if (!manifest || typeof manifest !== "object" || manifest.name !== request.package || manifest.version !== request.version) return [`npm has no ${request.package} ${request.version}. Check the package's name and the version on npmjs.com, and edit the issue.`];
  const problems = [];
  const hasTypes = (node) => {
    if (typeof node === "string") return /\.d\.[mc]?ts$/.test(node);
    if (typeof node !== "object" || node === null) return false;
    if (typeof node.types === "string") return true;
    return ["import", "default", "require"].some((key) => node[key] !== undefined && hasTypes(node[key]));
  };
  const root = typeof manifest.exports === "object" && manifest.exports !== null ? (manifest.exports["."] ?? manifest.exports) : null;
  if (!(root && hasTypes(root)) && typeof manifest.types !== "string" && typeof manifest.typings !== "string") {
    problems.push(`${request.package} ${request.version} ships no TypeScript types of its own, and its parts are read from them. (Types in a separate @types package are not read.)`);
  }
  const range = manifest.peerDependencies?.react;
  if (typeof range === "string") {
    let ok = true;
    try {
      ok = satisfies(react, range);
    } catch {
      problems.push(`${request.package} ${request.version} asks for React "${shown(range)}", a range the vendor build cannot read, so it would refuse to build it.`);
    }
    if (!ok) problems.push(`${request.package} ${request.version} asks for React "${shown(range)}", and frames render with React ${react}: the vendor build would refuse it.`);
  }
  if (typeof manifest.deprecated === "string") problems.push(`npm marks ${request.package} ${request.version} as deprecated.`);
  return problems;
}

// ---- words -------------------------------------------------------------------------------------------

/** A fence longer than any run of backticks in the text, so the text cannot close it. */
function fenced(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

/** Output with terminal colours taken out. */
export function plain(text) {
  return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g"), "");
}

/** The comment that says why a run stopped, with the end of the failing command's output when there is one. */
export function stopComment({ reason, output, runUrl }) {
  const lines = [reason];
  if (output && output.trim() !== "") lines.push("", "<details><summary>The end of its output</summary>", "", fenced(plain(output).trim()), "", "</details>");
  if (runUrl) lines.push("", `The run: ${runUrl}`);
  return lines.join("\n");
}

/** What the describer and core's draft say about the library, for the pull request. */
export function summaryOf(description, draft, effects) {
  const families = new Set(Object.keys(description.parts).map((part) => part.split(".")[0]));
  return {
    parts: Object.keys(description.parts).length,
    families: families.size,
    roles: draft.guesses.map((guess) => ({ role: guess.role, mapping: guess.mapping, confidence: guess.confidence })),
    missing: draft.missing.map((item) => ({ role: item.role, why: item.why, rules: (effects.find((effect) => effect.role === item.role)?.rules ?? []).map((rule) => rule.rule) })),
    excludedProps: draft.excludedProps ? { count: draft.excludedProps.props.length, sets: description.styleProps?.sets ?? [], confidence: draft.excludedProps.confidence } : null,
    check: needsChecking(description, draft),
  };
}

function mappingWords(mapping) {
  const parts = mapping.components.map((part) => `\`${part}\``).join(" or ") || "no part";
  if (!mapping.prop) return parts;
  return `${parts} with \`${mapping.prop.name}\` ${mapping.prop.values.map((value) => `\`${JSON.stringify(value)}\``).join(" or ")}${mapping.prop.whenMissing ? ` (or no \`${mapping.prop.name}\`)` : ""}`;
}

/** The pull request's body: what was added, what the describer drafted, what ran, and what a person must check. */
export function pullRequestBody({ request, issue, install, before, summary, runUrl, files }) {
  const lines = [
    `Adds ${request.package} ${request.version} to the libraries this deployment serves and New project offers, as requested in #${issue}.`,
    "",
    `Closes #${issue}.`,
    "",
    "## What changed",
    "",
    install === request.package ? `- \`${WEB_PACKAGE}\`: \`"${request.package}": "${request.version}"\` in \`dependencies\`, and the version with its stylesheets under \`designHarness.libraries\`.` : `- \`${WEB_PACKAGE}\`: the npm alias \`"${install}": "npm:${request.package}@${request.version}"\` in \`dependencies\`, beside the version already served, and the version with its stylesheets under \`designHarness.libraries\`.`,
    `- \`${LOCKFILE}\`: what \`npm install --ignore-scripts\` resolved for it.`,
    `- \`${files.description}\`: written by \`packages/core/scripts/describe-library.mjs\` from the package's own type declarations, installed alone with npm's \`--before=${before}\` (one second after the version was published), so the same file comes out on every run.`,
    `- \`${REGISTRY}\`: an entry for it, with what could be inferred and safe defaults, and a comment of what a person must check.`,
    `- Stylesheets: ${request.stylesheets.length > 0 ? request.stylesheets.map((path) => `\`${path}\``).join(", ") : "none"}.`,
    "",
    "## What the describer drafted",
    "",
    `${summary.parts} parts in ${summary.families} exports.`,
    "",
    "| Role | Drafted | Confidence |",
    "| --- | --- | --- |",
    ...summary.roles.map((role) => `| ${role.role} | ${mappingWords(role.mapping)} | ${role.confidence} |`),
    ...summary.missing.map((item) => `| ${item.role} | none found | — |`),
    "",
    summary.excludedProps ? `Style props to exclude from specs: ${summary.excludedProps.count}, at ${summary.excludedProps.confidence} confidence${summary.excludedProps.sets.length > 0 ? `, from ${summary.excludedProps.sets.map((set) => `\`${set}\``).join(", ")}` : ""}.` : "Style props: the describer found none to exclude.",
    "",
    "## Needs a person to check",
    "",
    ...summary.check.map((line) => `- [ ] ${line}`),
    "- [ ] Open New project on the preview, pick the library, and look at each role's preview and the starter's frames.",
    "",
    "## Verification",
    "",
    `The workflow ran these on this exact change before it opened the pull request, in ${runUrl}:`,
    "",
    "- `npm ci --ignore-scripts`, then the edits above and `npm install --ignore-scripts`",
    "- `npm run check` (typecheck, lint, unit tests: the registry and versions tests hold the new entry to its description, the vendor config and the version installed)",
    "- `npm run build` (the vendor build serves the new version, and the app builds)",
    `- \`node apps/web/e2e/run.mjs "${E2E_TEST}"\`: New project offers it, draws every role, and its starter passes every rule, measured in frames`,
    "",
    "## Unverified checks",
    "",
    "This pull request was opened with the workflow's own token, and GitHub does not start workflows for a pull request opened that way: CI's `check`, `e2e` and preview `deploy` have not run on it. Push a commit to the branch, or close and reopen the pull request, to run them.",
    "",
    "## Remaining risks",
    "",
    "- The role draft, the scheme switch and the notes are a machine's first pass: see the list above.",
    "- The package is third-party code. Nothing from it ran in Node (every install skipped its scripts); the end-to-end test ran it in a sandboxed frame.",
    "",
    "🤖 Opened by the library request workflow.",
  ];
  return `${lines.join("\n")}\n`;
}

// ---- running commands --------------------------------------------------------------------------------

/** A reason a request stops, said on the issue as it is. */
export class RequestStop extends Error {
  constructor(message, output = "") {
    super(message);
    this.output = output;
  }
}

/** Runs a command with an argument list (never a shell), streaming its output, and keeps the last lines. */
function run(command, args, { cwd = REPO, env = process.env, keep = 60 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const take = (chunk, stream) => {
      stream.write(chunk);
      tail = (tail + chunk.toString("utf8")).split("\n").slice(-keep).join("\n");
    };
    child.stdout.on("data", (chunk) => take(chunk, process.stdout));
    child.stderr.on("data", (chunk) => take(chunk, process.stderr));
    child.on("error", (error) => resolve({ code: 127, tail: String(error) }));
    child.on("close", (code) => resolve({ code: code ?? 1, tail }));
  });
}

async function runOrStop(command, args, reason, options) {
  const result = await run(command, args, options);
  if (result.code !== 0) throw new RequestStop(reason, result.tail);
  return result;
}

/** Captures a command's standard output, without a shell. */
async function capture(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd ?? REPO, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => resolve({ code: 127, out, err: String(error) }));
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

/** Core's role drafter, rules and project builder, bundled from source as draft-roles.mjs does: the same code the app runs. */
async function core() {
  const { build } = await import("esbuild");
  const contents = [
    'export { draftRoles, missingRoleEffects } from "./src/library/roles";',
    'export { buildProject, confirmationFrom, defaultStarterRules } from "./src/library/project";',
    'export { BUILT_IN_RULES } from "./src/builtins";',
    'export { parseLibraryDescription } from "./src/parse";',
  ].join("\n");
  const result = await build({ stdin: { contents, resolveDir: join(REPO, "packages", "core"), loader: "ts" }, bundle: true, format: "esm", platform: "neutral", target: "es2022", write: false, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]?.text ?? "").toString("base64")}`);
}

const readJson = (path) => JSON.parse(readFileSync(join(REPO, path), "utf8"));
const writeJson = (path, value) => writeFileSync(join(REPO, path), `${JSON.stringify(value, null, 2)}\n`);
const frameReact = () => readJson(WEB_PACKAGE).dependencies.react;

/** npm's manifest of the exact version, or null when npm has none. */
async function npmManifest(request) {
  const result = await capture("npm", ["view", `${request.package}@${request.version}`, "--json"]);
  let parsed = null;
  try {
    parsed = JSON.parse(result.out);
  } catch {
    parsed = null;
  }
  if (result.code !== 0 || parsed === null) {
    if (parsed?.error?.code === "E404" || /E404/.test(result.err)) return null;
    throw new RequestStop("npm could not be asked about the package just now. The workflow can be run again by editing the issue.", result.err.slice(-2000));
  }
  return Array.isArray(parsed) ? (parsed.find((entry) => entry?.version === request.version) ?? null) : parsed;
}

/** npm's --before for the describer's install: one second after the version was published, as describe-library.mjs sets it. */
async function publishedBefore(request) {
  const published = await capture("npm", ["view", `${request.package}@${request.version}`, "time", "--json"]);
  let time;
  try {
    time = JSON.parse(published.out || "{}")[request.version];
  } catch {
    time = undefined;
  }
  if (typeof time !== "string" || Number.isNaN(Date.parse(time))) throw new RequestStop(`npm does not say when ${request.package} ${request.version} was published.`);
  return new Date(Date.parse(time) + 1000).toISOString();
}

/** Where npm installed a dependency of the app: hoisted to the root, or in the app's own node_modules. */
export function lockedVersion(lock, install) {
  return lock.packages?.[`node_modules/${install}`]?.version ?? lock.packages?.[`apps/web/node_modules/${install}`]?.version ?? null;
}

/**
 * The library's draft and the problems that stop it: core must accept the
 * description, draft a part for every role, and build a project on it whose
 * starter follows the rules, as registry.test.ts does.
 */
export function draftProblems(description, setup, lib) {
  const parsed = lib.parseLibraryDescription(JSON.parse(JSON.stringify(description)));
  if (!parsed.ok) return { draft: null, problems: [`core refuses the description the describer wrote: ${parsed.error.slice(0, 3).map((issue) => `${issue.path} ${issue.message}`).join("; ")}`] };
  if (Object.keys(description.parts).length === 0) return { draft: null, problems: [`The describer found no React components in ${description.package} ${description.version}'s type declarations.`] };
  const draft = lib.draftRoles(description);
  if (draft.missing.length > 0) {
    return {
      draft,
      problems: [
        `core found no part for ${draft.missing.map((item) => `the ${item.role} role (${item.why})`).join("; ")}.`,
        "The workflow adds only a library whose every role it can draft. A person can still add this one by hand, deciding what to do about each role.",
      ],
    };
  }
  const built = lib.buildProject({
    name: "Requested",
    takenIds: [],
    description,
    setup,
    confirmation: lib.confirmationFrom(draft, Object.fromEntries(draft.guesses.map((guess) => [guess.role, { mapping: guess.mapping }])), "accept"),
    rules: lib.defaultStarterRules(),
  });
  if (!built.ok) return { draft, problems: [`core could not build a project on the drafted roles: ${built.error.slice(0, 3).map((issue) => issue.message).join("; ")}.`] };
  if (!built.value.starter.ok) return { draft, problems: [`core built a project on it, but its starter page does not follow the rules: ${built.value.starter.error}`] };
  return { draft, problems: [] };
}

// ---- the commands ------------------------------------------------------------------------------------

/** Writes step outputs with a delimiter no value can hold. */
function setOutputs(values) {
  const file = process.env.GITHUB_OUTPUT;
  for (const [name, value] of Object.entries(values)) {
    const text = String(value);
    if (!file) {
      process.stdout.write(`${name}: ${text}\n`);
      continue;
    }
    const delimiter = `EOF_${randomUUID()}`;
    appendFileSync(file, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
  }
}

function outDir() {
  const dir = process.env.REQUEST_OUT ?? join(process.env.RUNNER_TEMP ?? join(REPO, "node_modules", ".cache"), "library-request");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function recordOutcome(outcome) {
  writeFileSync(join(outDir(), "outcome.json"), `${JSON.stringify(outcome, null, 2)}\n`);
}

async function github(path, { method = "GET", body } = {}) {
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const response = await globalThis.fetch(`${api}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, json: text === "" ? null : JSON.parse(text) };
}

const repository = () => {
  const name = process.env.GITHUB_REPOSITORY ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) throw new Error("GITHUB_REPOSITORY is not owner/name");
  return name;
};
const runUrl = () => `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;

/** Whether the request is already served, or its branch or pull request already exists: a reason to stop, or null. */
async function duplicateReason(request, { remote }) {
  const served = servedVersions(readJson(WEB_PACKAGE), request.package);
  if (served.includes(request.version)) {
    return isListed(readFileSync(join(REPO, REGISTRY), "utf8"), request)
      ? `${request.package} ${request.version} is already in New project's list: pick it there. Nothing to add.`
      : `${request.package} ${request.version} is already served, for projects made on it, though New project does not offer it. Adding it to the list is a small change a person makes by hand in ${REGISTRY}.`;
  }
  if (!remote) return null;
  const repo = repository();
  const [owner] = repo.split("/");
  const branch = requestBranch(request);
  const pulls = await github(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
  if (pulls.status !== 200) throw new Error(`listing pull requests answered ${pulls.status}`);
  if (Array.isArray(pulls.json) && pulls.json.length > 0) return `${request.package} ${request.version} is already requested: pull request #${pulls.json[0].number} adds it.`;
  const existing = await github(`/repos/${repo}/branches/${encodeURIComponent(branch)}`);
  if (existing.status === 200) return `The branch ${branch} already exists with no open pull request, from an earlier request. A maintainer deletes it, then edits this issue to run the request again.`;
  return null;
}

async function parseCommand() {
  const event = readEvent();
  if (!event.go) {
    process.stdout.write(`Not going on: ${event.quiet ?? event.reason}\n`);
    setOutputs({ go: "false", issue: event.issue ?? "", reason: event.reason ?? "" });
    return;
  }
  const duplicate = await duplicateReason(event.request, { remote: true });
  if (duplicate) {
    setOutputs({ go: "false", issue: event.issue, reason: duplicate });
    return;
  }
  // The concurrency group: one run at a time per package and version.
  setOutputs({ go: "true", issue: event.issue, key: `${event.request.package}@${event.request.version}` });
}

/**
 * Adds the library to this checkout: npm's manifest checked, the
 * description written, package.json and the registry edited, and npm
 * install run. Returns what the pull request says about it.
 */
async function prepare(request, issue) {
  process.stdout.write(`Preparing ${request.package} ${request.version} (issue #${issue}).\n`);
  const duplicate = await duplicateReason(request, { remote: false });
  if (duplicate) throw new RequestStop(duplicate);
  const manifest = await npmManifest(request);
  const problems = manifestProblems(manifest, request, frameReact());
  if (problems.length > 0) throw new RequestStop(problems.join("\n"));
  const before = await publishedBefore(request);

  // Describe it from a copy installed alone, as of its publication, so the description reproduces.
  const describer = await import(pathToFileURL(join(REPO, "packages", "core", "scripts", "describe-library.mjs")).href);
  let description;
  try {
    description = describer.describeLibrary(describer.installLibrary(request.package, request.version));
  } catch (error) {
    throw new RequestStop(`The describer could not read ${request.package} ${request.version}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lib = await core();
  const { draft, problems: drafted } = draftProblems(description, { react: frameReact(), stylesheets: request.stylesheets }, lib);
  if (drafted.length > 0) throw new RequestStop(drafted.join("\n"));
  const files = { description: descriptionPath(request) };
  writeFileSync(join(REPO, files.description), describer.descriptionText(description));

  const { packageJson, install } = addToPackageJson(readJson(WEB_PACKAGE), request);
  writeJson(WEB_PACKAGE, packageJson);
  const registry = readFileSync(join(REPO, REGISTRY), "utf8");
  writeFileSync(join(REPO, REGISTRY), addRegistryEntry(registry, registryEntry(request, description, draft, { id: registryId(request, registryIds(registry)), issue })));
  await runOrStop("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], `npm could not install ${request.package} ${request.version} beside the app's dependencies.`);
  const installed = [join(REPO, "node_modules", ...install.split("/")), join(REPO, "apps", "web", "node_modules", ...install.split("/"))].find((dir) => existsSync(join(dir, "package.json")));
  if (!installed) throw new RequestStop(`npm did not install ${request.package} ${request.version} where the vendor build looks for it.`);
  const missing = request.stylesheets.filter((path) => !existsSync(join(installed, path)));
  if (missing.length > 0) throw new RequestStop(`${request.package} ${request.version} has no ${missing.map((path) => `"${path}"`).join(", ")}. Check the stylesheet paths in the package's files on npmjs.com, and edit the issue.`);
  const effects = lib.missingRoleEffects(lib.BUILT_IN_RULES, draft.missing.map((item) => item.role));
  return { request, issue, install, before, files, summary: summaryOf(description, draft, effects) };
}

async function prepareCommand() {
  const event = readEvent();
  if (!event.go) throw new Error(`the event is not a request to answer: ${event.quiet ?? event.reason}`);
  try {
    const prepared = await prepare(event.request, event.issue);
    const out = outDir();
    copyFileSync(join(REPO, prepared.files.description), join(out, "description.json"));
    copyFileSync(join(REPO, LOCKFILE), join(out, "package-lock.json"));
    recordOutcome({ ok: true, stage: "prepare" });
    setOutputs({ label: `${event.request.package} ${event.request.version}` });
  } catch (error) {
    stopWith(error, "prepare");
  }
}

async function verifyCommand() {
  const event = readEvent();
  if (!event.go) throw new Error(`the event is not a request to answer: ${event.quiet ?? event.reason}`);
  const label = `${event.request.package} ${event.request.version}`;
  try {
    await runOrStop("npm", ["run", "check"], `With ${label} added, \`npm run check\` fails.`);
    await runOrStop("npm", ["run", "build"], `With ${label} added, the app does not build: the vendor build may refuse it (a React range it cannot read or does not meet, a missing stylesheet).`);
    await runOrStop("node", ["apps/web/e2e/run.mjs", E2E_TEST], `With ${label} added, New project cannot make a project on it whose starter passes every rule as drawn: a role's part may not render in a frame, or the starter may fail a rendered rule such as contrast.`, { env: { ...process.env, E2E_LIBRARY: label } });
    recordOutcome({ ok: true, stage: "verify" });
  } catch (error) {
    stopWith(error, "verify");
  }
}

function stopWith(error, stage) {
  const stop = error instanceof RequestStop;
  recordOutcome({ ok: false, stage, reason: stop ? error.message : `The workflow failed while it ${stage === "verify" ? "ran the checks" : "added the library"}: ${error instanceof Error ? error.message : String(error)}`, output: stop ? error.output : "" });
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
}

/** The paths a request's pull request may change, and nothing else. */
export function allowedChanges(request) {
  return [WEB_PACKAGE, LOCKFILE, REGISTRY, descriptionPath(request)].sort();
}

/** `git status --porcelain` lines as paths. */
export function changedPaths(status) {
  return status
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3).replace(/^"|"$/g, ""))
    .sort();
}

async function publishCommand() {
  const event = readEvent();
  if (!event.go) throw new Error(`the event is not a request to answer: ${event.quiet ?? event.reason}`);
  const { request, issue } = event;
  try {
    const duplicate = await duplicateReason(request, { remote: true });
    if (duplicate) throw new RequestStop(duplicate);
    const from = process.env.REQUEST_ARTIFACT;
    if (!from) throw new Error("REQUEST_ARTIFACT is not set");
    // The build job's description is data: it must parse, and be of this package and version.
    const description = JSON.parse(readFileSync(join(from, "description.json"), "utf8"));
    const lib = await core();
    const { draft, problems } = draftProblems(description, { react: frameReact(), stylesheets: request.stylesheets }, lib);
    if (!draft || problems.length > 0 || description.package !== request.package || description.version !== request.version) throw new Error(`the build's description is not one of ${request.package} ${request.version} that core drafts: ${problems.join(" ")}`);
    const files = { description: descriptionPath(request) };
    copyFileSync(join(from, "description.json"), join(REPO, files.description));
    copyFileSync(join(from, "package-lock.json"), join(REPO, LOCKFILE));
    // The edits to package.json and the registry are made again here, from the request, not taken from the build.
    const { packageJson, install } = addToPackageJson(readJson(WEB_PACKAGE), request);
    writeJson(WEB_PACKAGE, packageJson);
    const registry = readFileSync(join(REPO, REGISTRY), "utf8");
    writeFileSync(join(REPO, REGISTRY), addRegistryEntry(registry, registryEntry(request, description, draft, { id: registryId(request, registryIds(registry)), issue })));
    const status = await capture("git", ["status", "--porcelain", "--untracked-files=all"]);
    const changed = changedPaths(status.out);
    const allowed = allowedChanges(request);
    if (JSON.stringify(changed) !== JSON.stringify(allowed)) throw new Error(`the change touches ${changed.join(", ")}, not exactly ${allowed.join(", ")}`);
    const lock = readJson(LOCKFILE);
    if (lockedVersion(lock, install) !== request.version) throw new Error(`the build's lockfile does not install ${request.package} ${request.version} as ${install}`);

    const branch = requestBranch(request);
    const identity = ["-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com"];
    await runOrStop("git", ["switch", "--create", branch], "git could not make the branch.");
    await runOrStop("git", ["add", "--", ...allowed], "git could not stage the change.");
    await runOrStop("git", [...identity, "commit", "--quiet", "-m", `Add ${request.package} ${request.version}, as requested in #${issue}.`], "git could not commit the change.");
    await runOrStop("git", ["push", "origin", `HEAD:refs/heads/${branch}`], `git could not push ${branch}.`);

    const repo = repository();
    const base = (await github(`/repos/${repo}`)).json?.default_branch ?? "main";
    const effects = lib.missingRoleEffects(lib.BUILT_IN_RULES, draft.missing.map((item) => item.role));
    const body = pullRequestBody({ request, issue, install, before: await publishedBefore(request), summary: summaryOf(description, draft, effects), runUrl: runUrl(), files });
    const pull = await github(`/repos/${repo}/pulls`, { method: "POST", body: { title: `Add ${request.package} ${request.version}`, head: branch, base, body, maintainer_can_modify: true } });
    if (pull.status !== 201) throw new Error(`opening the pull request answered ${pull.status}: ${JSON.stringify(pull.json?.message ?? "")}${pull.status === 403 ? '. The repository setting "Allow GitHub Actions to create and approve pull requests" may be off.' : ""}`);
    await github(`/repos/${repo}/issues/${issue}/comments`, { method: "POST", body: { body: `Pull request #${pull.json.number} adds ${request.package} ${request.version}. Every check passed in the workflow (${runUrl()}). Once it is merged and deployed, New project lists the library.` } });
    setOutputs({ pull: pull.json.number });
  } catch (error) {
    const stop = error instanceof RequestStop;
    setOutputs({ reason: stop ? error.message : `The workflow checked the library, but could not open its pull request: ${error instanceof Error ? error.message : String(error)}` });
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  }
}

/** The comment for a run that stopped, from what each job left behind. */
export function reportText({ parseReason, buildResult, outcome, publishResult, publishReason, runUrl }) {
  if (parseReason) return stopComment({ reason: parseReason, runUrl });
  if (buildResult === "failure" || buildResult === "cancelled") {
    if (outcome && outcome.ok === false && typeof outcome.reason === "string") return stopComment({ reason: outcome.reason, output: typeof outcome.output === "string" ? outcome.output : "", runUrl });
    return stopComment({ reason: buildResult === "cancelled" ? "The run was cancelled before it finished checking the library." : "The workflow stopped before it could say why.", runUrl });
  }
  if (publishResult === "failure") return stopComment({ reason: publishReason || "The workflow checked the library, but could not open its pull request.", runUrl });
  return null;
}

async function reportCommand() {
  const event = readEvent();
  if (event.issue === null || event.quiet) return;
  let outcome = null;
  const dir = process.env.REQUEST_ARTIFACT;
  if (dir && existsSync(join(dir, "outcome.json"))) {
    try {
      outcome = JSON.parse(readFileSync(join(dir, "outcome.json"), "utf8"));
    } catch {
      outcome = null;
    }
  }
  const text = reportText({ parseReason: process.env.PARSE_REASON ?? "", buildResult: process.env.BUILD_RESULT ?? "", outcome, publishResult: process.env.PUBLISH_RESULT ?? "", publishReason: process.env.PUBLISH_REASON ?? "", runUrl: runUrl() });
  if (!text) return;
  const answer = await github(`/repos/${repository()}/issues/${event.issue}/comments`, { method: "POST", body: { body: text.slice(0, 60000) } });
  if (answer.status !== 201) throw new Error(`commenting on #${event.issue} answered ${answer.status}`);
}

/** prepare, then the pull request's body, in this checkout and with no GitHub: for trying a request by hand. */
async function dryRunCommand(args) {
  const [name, version, ...stylesheets] = args;
  const checked = validateLibraryRequest({ package: name, version, stylesheets: stylesheets.join("\n") });
  if (!checked.ok) throw new Error(checked.errors.map((error) => error.message).join("\n"));
  const prepared = await prepare(checked.value, 0);
  process.stdout.write(`\n${requestTitle(checked.value)}: prepared. The pull request would say:\n\n`);
  process.stdout.write(pullRequestBody({ ...prepared, runUrl: "(this dry run)" }));
}

const COMMANDS = { parse: parseCommand, prepare: prepareCommand, verify: verifyCommand, publish: publishCommand, report: reportCommand, "dry-run": dryRunCommand };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2);
  const fn = COMMANDS[command];
  if (!fn) {
    process.stderr.write(`usage: node apps/web/scripts/library-request.mjs ${Object.keys(COMMANDS).join(" | ")}\n`);
    process.exit(2);
  }
  try {
    await fn(rest);
  } catch (error) {
    if (error instanceof RequestStop) process.stderr.write(`${error.message}\n${error.output}\n`);
    else process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  }
}
