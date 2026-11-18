/**
 * End-to-end tests of the built app in a real Chromium, with Playwright.
 * `npm run e2e` builds the app and runs this file; it serves dist/ with
 * Vite's preview server, opens each test in a fresh browser context (so a
 * fresh IndexedDB), and fails on the first broken expectation of each test.
 *
 * Playwright is not a dependency of this repository: the script uses the
 * `playwright` package the environment provides (NODE_PATH), with its own
 * Chromium. Set E2E_SCREENSHOTS to a folder to save screenshots of the app.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(import.meta.url);

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("e2e: the playwright package is not installed here; it is expected on NODE_PATH, with its Chromium.");
  process.exit(1);
}

const shots = process.env.E2E_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const only = process.argv.slice(2);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- helpers ---------------------------------------------------------------

const SCENARIOS = ["rooms-list", "lantern-open", "lantern-booked", "lantern-held"];
const VIEWS = ["desktop", "phone"];

async function openApp(browser, base, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true, ...options });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  return { context, page, errors };
}

/** Waits until core's report for `revision` includes every frame's answer. */
async function measured(page, revision) {
  await page.waitForSelector(`.checks[data-measured][data-revision="${revision}"]`, { timeout: 60000, state: "attached" });
}

async function report(page) {
  return JSON.parse((await page.locator('[data-testid="report-json"]').textContent()) ?? "null");
}

const failing = (value) => value.rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule);

async function showCode(page, file) {
  await page.getByRole("tab", { name: "Code" }).click();
  await page.locator("#code-file select, select#code-file, .code-file select").first().selectOption(file);
}

async function editFile(page, file, change) {
  await showCode(page, file);
  const editor = page.locator('[data-testid="code-editor"]');
  const before = await editor.inputValue();
  const after = change(before);
  assert.notEqual(after, before, `the edit of ${file} changes nothing`);
  await editor.fill(after);
  return after;
}

async function shot(page, name) {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
}

const SECOND_PRIMARY = (text) => text.replace('<Button.Root variant="secondary">Hold room</Button.Root>', '<Button.Root variant="primary">Hold room</Button.Root>');
// Two 1-letter "buttons" side by side: each is under 24 CSS px wide and too close to the other for the spacing exception.
const UNDERSIZED = (text) =>
  text.replace(
    "{lantern.seats} seats, {lantern.floor}\n        </Text.Root>",
    '{lantern.seats} seats, {lantern.floor}\n        </Text.Root>\n        <Text.Root as="span" role="button" tabIndex={0}>A</Text.Root>\n        <Text.Root as="span" role="button" tabIndex={0}>B</Text.Root>',
  );

// ---- tests -----------------------------------------------------------------

test("the seeded Nook project renders every frame", async ({ browser, base }) => {
  const { page, errors } = await openApp(browser, base);
  await measured(page, 1);
  const cards = await page.locator(".frame-card").evaluateAll((elements) => elements.map((element) => [element.dataset.frameKey, element.dataset.state]));
  assert.deepEqual(cards, SCENARIOS.flatMap((scenario) => VIEWS.map((view) => [`${scenario}@${view}`, "measured"])));
  for (const scenario of SCENARIOS) {
    for (const view of VIEWS) {
      const frame = page.frameLocator(`iframe[title="${scenario} at ${view}"]`);
      const title = (await frame.locator("h1").textContent())?.trim();
      assert.equal(title, scenario === "rooms-list" ? "Rooms" : "Lantern", `${scenario} at ${view} shows its title`);
    }
  }
  const booked = await page.frameLocator('iframe[title="lantern-booked at phone"]').locator("text=Booked until 3 pm").count();
  assert.equal(booked, 1, "the booked scenario's state reaches the page");
  await shot(page, "board-light");
  assert.deepEqual(errors, []);
});

test("the legal prototype passes every rule, the rendered rules included", async ({ browser, base }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  const value = await report(page);
  assert.equal(value.status, "pass");
  assert.deepEqual(value.findings, []);
  const rendered = value.rules.filter((rule) => rule.type === "rendered").map((rule) => [rule.rule, rule.status]);
  assert.deepEqual(rendered, [
    ["accessible-names", "pass"],
    ["heading-structure", "pass"],
    ["no-sideways-scroll", "pass"],
    ["rank-1-in-first-view", "pass"],
    ["target-size", "pass"],
    ["text-contrast", "pass"],
  ]);
  assert.equal(value.rules.length, 32);
  assert.equal(await page.getByTestId("report-status").textContent(), "pass");
});

test("a second primary action brings core's finding, and selecting it marks the line", async ({ browser, base }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  const edited = await editFile(page, "pages/booking.tsx", SECOND_PRIMARY);
  await measured(page, 2);
  const value = await report(page);
  assert.ok(failing(value).includes("one-primary-per-page"), `one-primary-per-page fails: ${failing(value)}`);
  const finding = value.findings.find((item) => item.rule === "one-primary-per-page");
  assert.match(finding.message, /^Page "booking" has 2 primary actions, more than 1/);
  await page.getByRole("tab", { name: /Checks/ }).click();
  const button = page.locator('.rule[data-rule="one-primary-per-page"] .finding').first();
  assert.equal((await button.locator(".finding-message").textContent()).trim(), finding.message, "the panel shows core's message word for word");
  await button.click();
  await page.waitForSelector('[data-testid="code-line"]');
  assert.equal(await page.locator('[data-testid="code-line"]').textContent(), `line ${finding.line}, column ${finding.column}`);
  const marked = (await page.locator('.code-field [data-kind="finding"]').textContent()) ?? "";
  assert.equal(marked, edited.split("\n")[finding.line - 1], "the marked line is the finding's line");
  await shot(page, "failing-source-light");
});

test("an undersized control brings the rendered target-size finding, highlighted in its frame", async ({ browser, base }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  await editFile(page, "pages/booking.tsx", UNDERSIZED);
  await measured(page, 2);
  const value = await report(page);
  assert.deepEqual(failing(value), ["target-size"]);
  const finding = value.findings.find((item) => item.rule === "target-size" && item.scenario === "lantern-open" && item.view === "desktop");
  assert.ok(finding, "target-size flags lantern-open at desktop");
  assert.match(finding.message, /^At 1280 by 900: button "A" is \d+×\d+ CSS px, under 24, and fails the spacing exception\.$/);
  assert.equal(typeof finding.element, "number");
  await page.getByRole("tab", { name: /Checks/ }).click();
  await page.locator('.rule[data-rule="target-size"] .finding').filter({ hasText: finding.message }).filter({ hasText: "scenario lantern-open" }).filter({ hasText: "view desktop" }).click();
  const frame = page.frameLocator('iframe[title="lantern-open at desktop"]');
  await frame.locator("[data-design-harness-overlay]").waitFor({ state: "attached" });
  const overlay = await frame.locator("[data-design-harness-overlay]").boundingBox();
  const target = await frame.getByRole("button", { name: "A", exact: true }).boundingBox();
  assert.ok(overlay && target && overlay.x <= target.x && overlay.x + overlay.width >= target.x + target.width, "the outline is drawn around the control");
  assert.equal(await page.locator('.frame-card[data-frame-key="lantern-open@desktop"]').getAttribute("data-selected"), "");
  await shot(page, "failing-rendered-light");
});

test("the same prototype gives the same report on reload", async ({ browser, base }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  await editFile(page, "pages/booking.tsx", UNDERSIZED);
  await measured(page, 2);
  const first = await report(page);
  await page.waitForTimeout(500); // the edit is saved once typing pauses
  await page.reload();
  await measured(page, 1);
  const again = await report(page);
  assert.deepEqual(again, first);
  assert.ok(failing(again).includes("target-size"));
});

test("a newer edit wins over frames still measuring an older one", async ({ browser, base }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  await editFile(page, "pages/booking.tsx", SECOND_PRIMARY);
  await page.waitForSelector('.checks[data-revision="2"]', { state: "attached" });
  const editor = page.locator('[data-testid="code-editor"]');
  await editor.fill((await editor.inputValue()).replace('<Button.Root variant="primary">Hold room</Button.Root>', '<Button.Root variant="secondary">Hold room</Button.Root>'));
  await measured(page, 3);
  const value = await report(page);
  assert.equal(value.status, "pass", `revision 3 is the legal source again: ${failing(value)}`);
});

test("export then import round-trips the project", async ({ browser, base }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export" }).click()]);
  assert.equal(download.suggestedFilename(), "nook.design-harness.json");
  const path = await download.path();
  const exported = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(exported.format, "design-harness/project");
  assert.equal(exported.project.id, "nook");
  assert.deepEqual(exported.prototypes.map((item) => item.id), ["booking"]);

  await editFile(page, "pages/rooms.tsx", (text) => text.replace('<Text.Root as="h1">Rooms</Text.Root>', '<Text.Root as="h1">Spaces</Text.Root>'));
  await measured(page, 2);
  assert.equal((await page.frameLocator('iframe[title="rooms-list at desktop"]').locator("h1").textContent()).trim(), "Spaces");

  await page.locator('[data-testid="import-file"]').setInputFiles(path);
  await measured(page, 1);
  assert.equal((await page.frameLocator('iframe[title="rooms-list at desktop"]').locator("h1").textContent()).trim(), "Rooms");
  assert.equal((await report(page)).status, "pass");
  await page.reload();
  await measured(page, 1);
  assert.equal((await page.frameLocator('iframe[title="rooms-list at desktop"]').locator("h1").textContent()).trim(), "Rooms", "the import was saved");

  const broken = join(dirname(path), "broken.json");
  writeFileSync(broken, JSON.stringify({ ...exported, project: { ...exported.project, views: [] } }));
  await page.locator('[data-testid="import-file"]').setInputFiles(broken);
  await page.getByText("broken.json was not imported").waitFor();
  assert.ok((await page.locator(".app-notices").textContent()).includes('rendered rule "target-size" is in force, but the config names no views'));
});

test("a frame cannot reach the app: no parent DOM, storage, cookies or network", async ({ browser, base }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  // A prototype that tries, at load, to write into the app's DOM and storage.
  await editFile(
    page,
    "pages/rooms.tsx",
    (text) =>
      `try { window.parent.document.body.setAttribute("data-pwned", "1"); } catch {}\ntry { window.top.localStorage.setItem("pwned", "1"); } catch {}\ntry { localStorage.setItem("pwned", "1"); } catch {}\n${text}`,
  );
  await measured(page, 2);
  assert.equal(await page.evaluate(() => document.body.getAttribute("data-pwned")), null);
  assert.equal(await page.evaluate(() => localStorage.getItem("pwned")), null);

  const sandboxes = await page.locator("iframe").evaluateAll((elements) => elements.map((element) => element.getAttribute("sandbox")));
  assert.equal(sandboxes.length, 8);
  assert.ok(sandboxes.every((value) => value === "allow-scripts"));

  for (const frame of page.frames().filter((item) => item !== page.mainFrame())) {
    const probe = await frame.evaluate(async () => {
      const attempt = async (fn) => {
        try {
          const value = await fn();
          return `reached: ${String(value).slice(0, 40)}`;
        } catch (error) {
          return error instanceof Error ? error.name : String(error);
        }
      };
      return {
        origin: self.origin,
        parentDocument: await attempt(() => window.parent.document.title),
        parentLocation: await attempt(() => window.parent.location.href),
        topStorage: await attempt(() => window.top.localStorage.length),
        storage: await attempt(() => localStorage.length),
        indexedDB: await attempt(() => indexedDB.open("design-harness")),
        cookie: await attempt(() => document.cookie),
        fetch: await attempt(() => fetch(document.referrer || "/").then((response) => response.status)),
      };
    });
    assert.deepEqual(probe, {
      origin: "null",
      parentDocument: "SecurityError",
      parentLocation: "SecurityError",
      topStorage: "SecurityError",
      storage: "SecurityError",
      indexedDB: "SecurityError",
      cookie: "SecurityError",
      fetch: "TypeError",
    });
  }
});

test("the board opens a frame at full size and the project view reads the config", async ({ browser, base }) => {
  for (const colorScheme of ["light", "dark"]) {
    const { page, context } = await openApp(browser, base, { colorScheme });
    await measured(page, 1);
    if (colorScheme === "dark") await shot(page, "board-dark");
    await page.getByRole("button", { name: "Open lantern-open at desktop full size" }).click();
    const viewport = await page.locator('.frame-card[data-frame-key="lantern-open@desktop"] .frame-viewport').boundingBox();
    assert.equal(Math.round(viewport.width), 1280);
    await shot(page, `full-size-${colorScheme}`);
    await page.getByRole("button", { name: "Back to board" }).click();
    await page.getByRole("tab", { name: "Project" }).click();
    await page.getByRole("heading", { name: "Component library" }).waitFor();
    for (const text of ["@tounsoo/todae 0.10.1", "primary-action", "Room details", "TARGET_MIN_PX", "Rules in force (31)", "No proposals yet"]) {
      assert.ok((await page.locator(".project").textContent()).includes(text), `the project view shows ${text}`);
    }
    await shot(page, `project-${colorScheme}`);
    if (colorScheme === "dark") {
      await page.getByRole("tab", { name: "Canvas" }).click();
      await editFile(page, "pages/booking.tsx", UNDERSIZED);
      await measured(page, 2);
      await page.getByRole("tab", { name: /Checks/ }).click();
      await page.locator('.rule[data-rule="target-size"] .finding').filter({ hasText: "view desktop" }).filter({ hasText: "scenario lantern-open" }).first().click();
      await shot(page, "failing-rendered-dark");
    }
    await context.close();
  }
});

/**
 * A stand-in for esm.sh on another origin: it answers esm.sh's URL scheme
 * (`/<package>@<version>[/<subpath>]?external=...`) with the vendor build's
 * files, with CORS, as a CDN would. It proves the URL path of the package
 * source (import map entries that are URLs, a stylesheet link, the CSP's
 * origin allowance) without the network.
 */
async function fakeCdn() {
  const manifest = JSON.parse(readFileSync(join(root, "dist", "vendor", "manifest.json"), "utf8"));
  const routes = new Map();
  for (const [name, entry] of Object.entries(manifest.packages)) {
    for (const [specifier, file] of Object.entries(entry.modules)) routes.set(`/${name}@${entry.version}${specifier.slice(name.length)}`, { file, type: "text/javascript" });
    for (const [path, file] of Object.entries(entry.files)) routes.set(`/${name}@${entry.version}/${path}`, { file, type: "text/css" });
  }
  const served = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://cdn.invalid");
    const route = routes.get(url.pathname);
    served.push(`${url.pathname}${url.search}`);
    if (!route) {
      response.writeHead(404, { "access-control-allow-origin": "*" }).end();
      return;
    }
    response.writeHead(200, { "content-type": route.type, "access-control-allow-origin": "*" }).end(readFileSync(join(root, "dist", "vendor", route.file)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, served, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("frames load React and the library by URL from a CDN-shaped origin", async ({ browser, base }) => {
  const cdn = await fakeCdn();
  try {
    const { page, errors } = await openApp(browser, `${base}?packages=esm.sh&packages-origin=${encodeURIComponent(cdn.origin)}`);
    await measured(page, 1);
    const value = await report(page);
    assert.equal(value.status, "pass", `every rule passes when packages come by URL: ${failing(value)}`);
    assert.ok(cdn.served.includes("/react@19.3.1"));
    assert.ok(cdn.served.includes("/react-dom@19.3.1/client?external=react,react-dom"));
    assert.ok(cdn.served.includes("/@tounsoo/todae@0.10.1?external=react,react-dom"));
    assert.ok(cdn.served.includes("/@tounsoo/todae@0.10.1/dist/todae.css"));
    assert.deepEqual(errors, []);
  } finally {
    await cdn.close();
  }
});

// ---- runner ----------------------------------------------------------------

const server = await preview({ root, configFile: join(root, "vite.config.ts"), logLevel: "silent", preview: { port: 0, host: "127.0.0.1" } });
const address = server.httpServer.address();
const base = `http://127.0.0.1:${address.port}/`;
const browser = await chromium.launch();
let failed = 0;
const selected = tests.filter((entry) => only.length === 0 || only.some((word) => entry.name.includes(word)));
for (const item of selected) {
  const started = Date.now();
  try {
    await item.fn({ browser, base });
    console.log(`ok   ${item.name} (${Date.now() - started} ms)`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${item.name} (${Date.now() - started} ms)\n     ${error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 6).join("\n     ") : String(error)}`);
  }
}
await browser.close();
await new Promise((resolve) => server.httpServer.close(resolve));
console.log(failed === 0 ? `e2e: ${selected.length} tests passed` : `e2e: ${failed} of ${selected.length} failed`);
process.exit(failed === 0 ? 0 : 1);
