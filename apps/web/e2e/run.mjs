/**
 * End-to-end tests of the built app in a real Chromium, with Playwright.
 * `npm run e2e` builds the app and runs this file; it serves dist/ with
 * Vite's preview server, opens each test in a fresh browser context (so a
 * fresh IndexedDB), and fails on the first broken expectation of each test.
 *
 * Playwright is a pinned dev dependency (the root package.json). Chromium is
 * the browser Playwright installed (CI runs `npx playwright install
 * chromium`), except where a Chromium is already installed at
 * /opt/pw-browsers/chromium, which local runs use as it is. Set
 * E2E_SCREENSHOTS to a folder to save screenshots of the app.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { strFromU8, unzipSync } from "fflate";
import { build as viteBuild, preview } from "vite";
import { build as esbuild } from "esbuild";
import { errorBody, fakeAnthropic, streamEvents } from "./fake-anthropic.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** The Chromium this environment ships, when there is one; otherwise Playwright's own. */
const PREINSTALLED_CHROMIUM = "/opt/pw-browsers/chromium";
const executable = existsSync(PREINSTALLED_CHROMIUM) ? { executablePath: PREINSTALLED_CHROMIUM } : {};

const shots = process.env.E2E_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const only = process.argv.slice(2);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- helpers ---------------------------------------------------------------

const SCENARIOS = ["rooms-list", "lantern-open", "lantern-booked", "lantern-held"];
const VIEWS = ["desktop", "phone"];

async function openApp(browser, base, options = {}) {
  // The fake API's certificate is self-signed; only it is reached at api.anthropic.com (see the runner).
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true, ignoreHTTPSErrors: true, ...options });
  const page = await context.newPage();
  const errors = [];
  const logs = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => logs.push(message.text()));
  await page.goto(base);
  return { context, page, errors, logs };
}

/** Waits until core's report for `revision` includes every frame's answer. */
async function measured(page, revision) {
  await page.waitForSelector(`.checks[data-measured][data-revision="${revision}"]`, { timeout: 60000, state: "attached" });
}

async function report(page) {
  return JSON.parse((await page.locator('[data-testid="report-json"]').textContent()) ?? "null");
}

const failing = (value) => value.rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule);

/**
 * Reads `read()` until `accept` takes its value, and returns it: for what the
 * app sets a tick after a click or a key, which a read straight away can
 * miss. It fails with `message` and the last value after 100 tries, 50 ms apart.
 */
async function eventually(page, read, accept, message) {
  for (let tries = 0; ; tries += 1) {
    const value = await read();
    if (accept(value)) return value;
    assert.ok(tries < 100, `${message}; last read ${JSON.stringify(value)}`);
    await page.waitForTimeout(50);
  }
}

/** Waits until the element a locator finds is focused. */
async function becomesFocused(page, locator, message) {
  await eventually(page, () => focused(locator), (value) => value === true, message);
}

/** Opens the Checks tab and its details, where every rule in force is listed with its findings. */
async function showAllRules(page) {
  await page.getByRole("tab", { name: /Checks/ }).click();
  const details = page.getByTestId("checks-details");
  await details.waitFor({ state: "attached" });
  if (!(await details.evaluate((element) => element.open))) await details.locator("summary").first().click();
}

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

/** The page as it is now in dark as well, only when screenshots are being saved. */
async function shotDark(page, name) {
  if (!shots) return;
  await page.emulateMedia({ colorScheme: "dark" });
  // Todae's colours ease from one scheme to the other.
  await page.waitForTimeout(400);
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "light" });
}

const SECOND_PRIMARY = (text) => text.replace('<Button.Root variant="secondary">Hold room</Button.Root>', '<Button.Root variant="primary">Hold room</Button.Root>');
// Two 1-letter "buttons" side by side: each is under 24 CSS px wide and too close to the other for the spacing exception.
const UNDERSIZED = (text) =>
  text.replace(
    "{lantern.seats} seats, {lantern.floor}\n        </Text.Root>",
    '{lantern.seats} seats, {lantern.floor}\n        </Text.Root>\n        <Text.Root as="span" role="button" tabIndex={0}>A</Text.Root>\n        <Text.Root as="span" role="button" tabIndex={0}>B</Text.Root>',
  );

const BOOKING_SCENARIOS = SCENARIOS.filter((scenario) => scenario !== "rooms-list");

/** Each overlay's box in one frame. */
async function overlays(page, scenario, view) {
  const frame = page.frameLocator(`iframe[title="${scenario} at ${view}"]`);
  return frame.locator("[data-design-harness-overlay]").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()));
}

/** True when `outer` (an overlay) surrounds `inner`. */
const surrounds = (outer, inner) => outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;

/** Waits until every frame of the booking page has `count` overlays, and the rooms page's frames none. */
async function outlinedInBookingFrames(page, count) {
  for (const scenario of BOOKING_SCENARIOS) {
    for (const view of VIEWS) {
      await page.frameLocator(`iframe[title="${scenario} at ${view}"]`).locator("[data-design-harness-overlay]").nth(count - 1).waitFor({ state: "attached" });
      assert.equal((await overlays(page, scenario, view)).length, count, `${scenario} at ${view} outlines ${count}`);
    }
  }
  for (const view of VIEWS) assert.equal((await overlays(page, "rooms-list", view)).length, 0, `rooms-list at ${view} outlines nothing`);
}

/** The boxes of every button named `name` in a frame. */
async function buttonBoxes(page, scenario, view, name) {
  return page.frameLocator(`iframe[title="${scenario} at ${view}"]`).getByRole("button", { name, exact: true }).evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()));
}

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
  assert.equal(value.rules.length, 33);
  assert.equal(await page.getByTestId("report-status").textContent(), "pass");
});

test("a second primary action brings core's finding: selecting it outlines both actions in every frame, and Show in code marks the line", async ({ browser, base }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  const edited = await editFile(page, "pages/booking.tsx", SECOND_PRIMARY);
  await measured(page, 2);
  const value = await report(page);
  assert.ok(failing(value).includes("one-primary-per-page"), `one-primary-per-page fails: ${failing(value)}`);
  const finding = value.findings.find((item) => item.rule === "one-primary-per-page");
  assert.match(finding.message, /^Page "booking" has 2 primary actions, more than 1/);
  const lines = edited.split("\n");
  assert.deepEqual(finding.targets, [
    { file: "pages/booking.tsx", line: lines.findIndex((line) => line.includes(">Hold room<")) + 1, column: 9, page: "booking" },
    { file: "pages/booking.tsx", line: lines.findIndex((line) => line.includes(">Book room<")) + 1, column: 9, page: "booking" },
  ]);
  await showAllRules(page);
  const button = page.locator('.rule[data-rule="one-primary-per-page"] .finding').first();
  assert.equal((await button.locator(".finding-message").textContent()).trim(), finding.message, "the panel shows core's message word for word");
  await button.click();
  // Both primary actions, outlined in every frame of the booking page, and nowhere else.
  await outlinedInBookingFrames(page, 2);
  for (const scenario of BOOKING_SCENARIOS) {
    for (const view of VIEWS) {
      const boxes = await overlays(page, scenario, view);
      for (const name of ["Hold room", "Book room"]) {
        const [target] = await buttonBoxes(page, scenario, view, name);
        assert.ok(boxes.some((box) => surrounds(box, target)), `${name} is outlined in ${scenario} at ${view}`);
      }
      assert.equal(await page.locator(`.frame-card[data-frame-key="${scenario}@${view}"]`).getAttribute("data-selected"), "");
    }
  }
  assert.equal(await page.getByTestId("finding-outline").textContent(), "Outlined in 6 frames: Booking, room open (Lantern open); Booking, booked (Lantern booked); Booking, held (Lantern held).");
  await shot(page, "failing-source-outlined-light");
  await page.locator('.rule[data-rule="one-primary-per-page"]').getByRole("button", { name: "Show in code" }).first().click();
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
  await showAllRules(page);
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
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export", exact: true }).click()]);
  assert.equal(download.suggestedFilename(), "nook.design-harness.json");
  const path = await download.path();
  const exported = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(exported.format, "design-harness/project");
  assert.equal(exported.project.id, "nook");
  assert.deepEqual(exported.prototypes.map((item) => [item.id, item.prototype.format ?? "tsx"]), [["booking", "tsx"], ["booking-spec", "spec"]]);

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
      `try { window.parent.document.body.setAttribute("data-pwned", "1"); } catch {}\ntry { window.top.localStorage.setItem("pwned", "1"); } catch {}\ntry { localStorage.setItem("pwned", "1"); } catch {}\n` +
      `try { eval("1"); document.documentElement.dataset.evalProbe = "ran"; } catch (error) { document.documentElement.dataset.evalProbe = error.name; }\n` +
      `try { new Function("return 1")(); document.documentElement.dataset.functionProbe = "ran"; } catch (error) { document.documentElement.dataset.functionProbe = error.name; }\n${text}`,
  );
  await measured(page, 2);
  assert.equal(await page.evaluate(() => document.body.getAttribute("data-pwned")), null);
  assert.equal(await page.evaluate(() => localStorage.getItem("pwned")), null);
  const flagged = (await report(page)).findings.filter((item) => item.rule === "no-ambient-globals").map((item) => item.message);
  assert.ok(flagged.some((message) => message.startsWith("pages/rooms.tsx:1:7 uses window")), `core refuses the prototype that reaches for the app: ${flagged.join(" | ")}`);

  const sandboxes = await page.locator("iframe").evaluateAll((elements) => elements.map((element) => element.getAttribute("sandbox")));
  assert.equal(sandboxes.length, 8);
  assert.ok(sandboxes.every((value) => value === "allow-scripts"));

  const codeFromStrings = [];
  for (const frame of page.frames().filter((item) => item !== page.mainFrame())) {
    const { strings, ...probe } = await frame.evaluate(async () => {
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
        // What the prototype's own code saw when it tried to turn strings into code (only the rooms page loads it).
        strings: [document.documentElement.dataset.evalProbe, document.documentElement.dataset.functionProbe],
        inlineHandler: await new Promise((resolve) => {
          const image = document.createElement("img");
          image.setAttribute("onerror", "document.body.dataset.ran = 'yes'");
          image.src = "data:,broken";
          document.body.append(image);
          setTimeout(() => resolve(document.body.dataset.ran ?? "blocked"), 200);
        }),
        channelInDom: document.documentElement.getAttribute("data-channel") ?? "hidden",
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
      inlineHandler: "blocked",
      channelInDom: "hidden",
    });
    if (strings[0] !== undefined) codeFromStrings.push(strings);
  }
  assert.deepEqual(codeFromStrings, [
    ["EvalError", "EvalError"],
    ["EvalError", "EvalError"],
  ], "the CSP refuses eval and the Function constructor to prototype code in both rooms frames");
});

test("the board opens a frame at full size and the project view reads the config", async ({ browser, base }) => {
  for (const colorScheme of ["light", "dark"]) {
    const { page, context } = await openApp(browser, base, { colorScheme });
    await measured(page, 1);
    if (colorScheme === "dark") await shot(page, "board-dark");
    await page.getByRole("button", { name: "Open Booking, room open — desktop (Lantern open) at full size" }).click();
    const viewport = await page.locator('.frame-card[data-frame-key="lantern-open@desktop"] .frame-viewport').boundingBox();
    assert.equal(Math.round(viewport.width), 1280);
    await shot(page, `full-size-${colorScheme}`);
    await page.getByRole("button", { name: "Back to board" }).click();
    await page.getByRole("tab", { name: "Project" }).click();
    await page.getByRole("heading", { name: "What a prototype can use" }).waitFor();
    for (const text of ["@tounsoo/todae 0.11.3", "primary-action", "Room details", "TARGET_MIN_PX", "Rules in force (32)", "No proposals yet"]) {
      assert.ok((await page.locator(".project").textContent()).includes(text), `the project view shows ${text}`);
    }
    await shot(page, `project-${colorScheme}`);
    if (colorScheme === "dark") {
      await page.getByRole("tab", { name: "Canvas" }).click();
      await editFile(page, "pages/booking.tsx", UNDERSIZED);
      await measured(page, 2);
      await showAllRules(page);
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
  for (const [name, { versions }] of Object.entries(manifest.packages)) {
    for (const [version, entry] of Object.entries(versions)) {
      for (const [specifier, file] of Object.entries(entry.modules)) routes.set(`/${name}@${version}${specifier.slice(name.length)}`, { file, type: "text/javascript" });
      for (const [path, file] of Object.entries(entry.files)) routes.set(`/${name}@${version}/${path}`, { file, type: "text/css" });
    }
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
    assert.ok(cdn.served.includes("/@tounsoo/todae@0.11.3?external=react,react-dom"));
    assert.ok(cdn.served.includes("/@tounsoo/todae@0.11.3/dist/todae.css"));
    assert.deepEqual(errors, []);
  } finally {
    await cdn.close();
  }
});

// ---- a project on another library: Tally on Mantine ----------------------------

const TALLY_SCENARIOS = ["expenses-list", "lunch-open", "lunch-submitted", "lunch-saved"];

/**
 * Tally, core's second worked example, as a project file: its config (core's
 * TypeScript, bundled here) and its legal spec prototype, read from the
 * files core's own tests read, so the two cannot drift apart.
 */
async function tallyProjectFile() {
  const core = join(root, "..", "..", "packages", "core");
  const bundled = await esbuild({ stdin: { contents: 'export { tally } from "./examples/tally/project";', resolveDir: core, loader: "ts" }, bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent" });
  const { tally } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
  const dir = join(core, "examples", "tally", "prototypes", "spec", "legal", "expense");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const files = {};
  for (const folder of ["layouts", "pages"]) for (const name of readdirSync(join(dir, folder)).sort()) files[`${folder}/${name}`] = readFileSync(join(dir, folder, name), "utf8");
  const file = join(mkdtempSync(join(tmpdir(), "design-harness-tally-")), "tally.design-harness.json");
  writeFileSync(file, JSON.stringify({ format: "design-harness/project", version: 1, project: tally, prototypes: [{ id: "expense", name: "Expense", prototype: { ...manifest, files } }] }));
  return file;
}

/** Imports Tally over the seeded project and waits until its own frames are measured. */
async function importTally(page) {
  await measured(page, 1);
  await page.locator('[data-testid="import-file"]').setInputFiles(await tallyProjectFile());
  await page.locator('iframe[title="lunch-open at desktop"]').waitFor({ state: "attached" });
  await measured(page, 1);
}

async function openTally(browser, base) {
  const opened = await openApp(browser, base);
  await importTally(opened.page);
  return opened;
}

test("a project on another library, Mantine, renders on the board with every rule passing, and an injected violation is flagged", async ({ browser, base }) => {
  const { page, errors, logs } = await openTally(browser, base);
  const value = await report(page);
  assert.equal(value.status, "pass", `the legal Tally prototype passes every rule: ${JSON.stringify(value.rules.filter((rule) => rule.status !== "pass").map((rule) => [rule.rule, rule.status, rule.findings.slice(0, 3).map((finding) => finding.message)]))}`);
  for (const rule of ["target-size", "accessible-names", "heading-structure", "text-contrast", "rank-1-in-first-view", "no-sideways-scroll"]) {
    assert.equal(value.rules.find((item) => item.rule === rule)?.status, "pass", `${rule} ran on measured Mantine frames`);
  }
  for (const scenario of TALLY_SCENARIOS) for (const view of VIEWS) assert.equal(await page.locator(`iframe[title="${scenario} at ${view}"]`).count(), 1, `${scenario} at ${view} is on the board`);
  // Mantine's own parts, inside its provider, in each view's scheme: the phone view is dark.
  const open = page.frameLocator('iframe[title="lunch-open at desktop"]');
  assert.equal((await open.locator("h1").textContent()).trim(), "Team lunch");
  assert.equal(await open.locator("button.mantine-Button-root").count(), 2);
  assert.equal(await open.getByLabel("Amount in euros").count(), 1, `Mantine's label names the amount field: ${logs.join("\n").slice(0, 3000)}`);
  assert.equal(await open.getByLabel("Amount in euros").inputValue(), "48.20");
  assert.equal(await open.locator(":root").getAttribute("data-mantine-color-scheme"), "light");
  assert.equal(await page.frameLocator('iframe[title="lunch-open at phone"]').locator(":root").getAttribute("data-mantine-color-scheme"), "dark");
  await shot(page, "tally-board-light");

  // Injected: the expense's title drawn as an h3, which only the measured heading structure can see.
  await editFile(page, "pages/expense.json", (text) => text.replace('"name": { "type": "Title", "props": { "order": 1,', '"name": { "type": "Title", "props": { "order": 3,'));
  await measured(page, 2);
  const broken = await report(page);
  assert.deepEqual(failing(broken), ["heading-structure"]);
  assert.ok(broken.findings.some((finding) => finding.rule === "heading-structure" && finding.scenario === "lunch-open"), "the finding names the Mantine frame it was measured in");
  // The checks panel leads with the one thing to fix, in plain words, its places on the Mantine frames.
  await page.getByRole("tab", { name: /Checks/ }).click();
  assert.equal(await page.getByTestId("checks-headline").textContent(), "1 thing to fix");
  assert.deepEqual(await page.locator(".fix").evaluateAll((items) => items.map((item) => item.dataset.rule)), ["heading-structure"]);
  const fix = page.locator('.fix[data-rule="heading-structure"]');
  assert.match(await fix.getByTestId("fix-message").textContent(), /The page has no visible title/);
  // The finding is about the whole page, at no element: Show selects its Mantine frame and outlines nothing.
  const place = fix.getByRole("button", { name: "Show Lunch open — desktop" });
  await place.click();
  await page.locator('.frame-card[data-frame-key="lunch-open@desktop"][data-selected]').waitFor({ state: "attached" });
  await eventually(page, () => place.getAttribute("aria-pressed"), (value) => value === "true", "the place shown is pressed");
  assert.equal(await page.frameLocator('iframe[title="lunch-open at desktop"]').locator("[data-design-harness-overlay]").count(), 0);
  await showAllRules(page);
  assert.equal(await page.getByTestId("report-status").textContent(), "fail");
  assert.ok((await page.locator('.rule[data-rule="heading-structure"] .finding').filter({ hasText: "scenario lunch-open" }).count()) > 0, "the rule list behind Details names the finding in its frame");
  await shot(page, "tally-checks-light");

  // A part that throws while it renders (an input given text) fails its frames: it is never measured as missing.
  await editFile(page, "layouts/amount-question.json", (text) => text.replace('"min": 0, "decimalScale": 2 }', '"min": 0, "decimalScale": 2, "text": "48" }'));
  const card = page.locator('[data-frame-key="lunch-open@desktop"]');
  await page.waitForFunction(() => document.querySelector('[data-frame-key="lunch-open@desktop"]')?.getAttribute("data-state") === "failed", undefined, { timeout: 60000 });
  assert.match(await card.textContent(), /NumberInput could not render/);
  assert.equal((await report(page)).status === "pass", false, "a frame that failed to render does not pass");
  assert.deepEqual(errors, []);
});

test("Tally's spec frames carry element tags at the expanded keys, Mantine parts included", async ({ browser, base }) => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(() => {
    if (window.top !== window) return;
    window.__frameMessages = [];
    window.addEventListener("message", (event) => {
      if (event.data && event.data.type === "snapshot") window.__frameMessages.push(JSON.parse(JSON.stringify(event.data)));
    });
  });
  const page = await context.newPage();
  await page.goto(base);
  await importTally(page);
  const messages = await page.evaluate(() => window.__frameMessages);
  await context.close();
  const open = messages.filter((item) => item.snapshot.scenario === "lunch-open" && item.snapshot.view === "desktop").pop();
  assert.ok(open, "the lunch-open frame answered");
  for (const tag of ["submit", "save", "amount/field", "rules/control"]) assert.ok(open.tags.includes(tag), `the frame drew ${tag}: ${open.tags.join(", ")}`);
});

test("a Mantine project loads its library and stylesheet by name and version from a CDN-shaped origin", async ({ browser, base }) => {
  const cdn = await fakeCdn();
  try {
    const opened = await openApp(browser, `${base}?packages=esm.sh&packages-origin=${encodeURIComponent(cdn.origin)}`);
    await importTally(opened.page);
    const value = await report(opened.page);
    assert.equal(value.status, "pass", `every rule passes when Mantine comes by URL: ${failing(value)}`);
    assert.ok(cdn.served.includes("/@mantine/core@9.7.4?external=react,react-dom"));
    assert.ok(cdn.served.includes("/@mantine/core@9.7.4/styles.css"));
    assert.deepEqual(opened.errors, []);
  } finally {
    await cdn.close();
  }
});

// ---- the agent, against the fake API -----------------------------------------

/** A key that only the fake API accepts; no real key is used anywhere. */
const KEY = "sk-ant-e2e-fake-0123456789abcdefghijklmnop";
const HOLD_SECONDARY = '<Button.Root variant="secondary">Hold room</Button.Root>';
const HOLD_PRIMARY = '<Button.Root variant="primary">Hold room</Button.Root>';

const toolReply = (id, name, input, text) => ({
  events: streamEvents({ id: `msg_${id}`, blocks: [{ type: "thinking", thinking: `Planning: ${id}.` }, ...(text ? [{ type: "text", text }] : []), { type: "tool_use", id: `toolu_${id}`, name, input }], stopReason: "tool_use" }),
  delayMs: 5,
});
const textReply = (text) => ({ events: streamEvents({ id: "msg_end", blocks: [{ type: "text", text }], stopReason: "end_turn" }), delayMs: 5 });

/** Everything the last message of a request says, its tool results and text blocks joined. */
function lastMessage(body) {
  const content = body.messages.at(-1).content;
  return typeof content === "string" ? content : content.map((block) => (block.type === "text" ? block.text : block.type === "tool_result" ? block.content : "")).join("\n");
}

async function enterKey(page, { remember = false } = {}) {
  await page.getByLabel("Your Anthropic API key").fill(KEY);
  if (remember) await page.getByRole("checkbox", { name: "Remember on this device" }).check();
  await page.getByRole("button", { name: "Use this key" }).click();
  await page.getByText("Settings and key").waitFor();
}

async function ask(page, text) {
  await page.getByRole("textbox", { name: "Message the agent" }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

/** Waits for the newest turn to end, and returns how it ended. */
async function turnEnded(page) {
  await page.waitForFunction(() => {
    const reply = [...document.querySelectorAll(".chat-reply")].at(-1);
    return reply && reply.getAttribute("data-end") !== "running";
  }, null, { timeout: 60000 });
  return page.locator(".chat-reply").last().getAttribute("data-end");
}

test("the agent edits a file through the API, and the frames and checks follow", async ({ browser, base, api }) => {
  const { page, logs } = await openApp(browser, base);
  await measured(page, 1);
  api.script([
    toolReply("rename", "edit_file", { path: "pages/rooms.tsx", old_text: '<Text.Root as="h1">Rooms</Text.Root>', new_text: '<Text.Root as="h1">Spaces</Text.Root>' }, "Renaming the rooms page."),
    (body) => {
      assert.match(lastMessage(body), /Checks for revision 2, with every frame measured: pass\./, "the app sends the measured checks back without being asked");
      return textReply("The rooms page is now called Spaces, and every rule passes.");
    },
  ]);
  await enterKey(page);
  await ask(page, "Call the rooms page Spaces");
  assert.equal(await turnEnded(page), "done");
  assert.equal(api.left(), 0);
  assert.equal((await page.frameLocator('iframe[title="rooms-list at desktop"]').locator("h1").textContent()).trim(), "Spaces");
  await measured(page, 2);
  assert.equal((await report(page)).status, "pass");
  const reply = page.locator(".chat-reply").last();
  assert.equal(await reply.locator('.chat-tool[data-tool="edit_file"] .chat-tool-title').textContent(), "Changed the rooms page", "the tool call reads as a plain summary");
  assert.equal(await reply.locator('.chat-tool[data-tool="edit_file"] .chat-tool-name').textContent(), "Edited pages/rooms.tsx", "its exact title is in its details");
  assert.match(await reply.locator(".chat-checks").textContent(), /Checks pass, revision 2/);
  assert.match(await reply.getByTestId("turn-usage").textContent(), /in · 480 out · about \$/);
  const [first] = api.requests;
  assert.equal(first.headers.authorization, `Bearer ${KEY}`);
  assert.equal(first.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.match(first.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.deepEqual([first.body.model, first.body.output_config, first.body.thinking, first.body.tool_choice, first.body.fallbacks, first.body.stream], ["claude-opus-5-5", { effort: "medium" }, { type: "adaptive", display: "summarized" }, { type: "auto" }, "default", true]);
  assert.deepEqual(api.requests[1].body.messages.slice(0, first.body.messages.length), first.body.messages, "the second request extends the first");
  assert.ok(logs.every((line) => !line.includes(KEY)), "the key is never logged");
  await shot(page, "chat-edit-light");
});

test("a second primary action: the failing check reaches the agent, and its fix passes", async ({ browser, base, api }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  api.script([
    toolReply("stand-out", "edit_file", { path: "pages/booking.tsx", old_text: HOLD_SECONDARY, new_text: HOLD_PRIMARY }),
    (body) => {
      const text = lastMessage(body);
      assert.match(text, /with every frame measured: fail\./);
      assert.match(text, /- one-primary-per-page \(count\)[^\n]*\n {2}violation: Page "booking" has 2 primary actions, more than 1/);
      return toolReply("fix", "edit_file", { path: "pages/booking.tsx", old_text: HOLD_PRIMARY, new_text: HOLD_SECONDARY }, "one-primary-per-page fails: a page holds one primary action. Hold room goes back to secondary.");
    },
    (body) => {
      assert.match(lastMessage(body), /with every frame measured: pass\./);
      return textReply("Hold room stays secondary: the project allows one primary action per page, and it is Book room.");
    },
  ]);
  await enterKey(page);
  await ask(page, "Make Hold room a primary button too");
  assert.equal(await turnEnded(page), "done");
  const checks = await page.locator(".chat-reply").last().locator(".chat-checks").evaluateAll((items) => items.map((item) => item.getAttribute("data-status")));
  assert.deepEqual(checks, ["fail", "pass"]);
  await measured(page, 3);
  assert.equal((await report(page)).status, "pass");
  await shot(page, "chat-fix-light");
});

const TOAST_PAGE = (count) => (text) => text.replace('import { Button, Text } from "@tounsoo/todae";', 'import { Button, Text, Toast } from "@tounsoo/todae";').replace('<Slot name="facts">', `<Slot name="facts">${"<Toast.Root>Booked</Toast.Root>".repeat(count)}`);

test("a drafted proposal is saved as open, with core's adoption dry run", async ({ browser, base, api }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  const booking = readFileSync(join(root, "..", "..", "packages", "core", "examples", "nook", "prototypes", "legal", "booking", "pages", "booking.tsx"), "utf8");
  api.script([
    toolReply(
      "toast",
      "draft_proposal",
      {
        id: "booking-toast",
        title: "A toast that confirms a booking",
        reason: "Booking needs a confirmation that does not move the page, and Toast is not in the inventory.",
        states: [{ state: "booked", note: "the toast says the room is booked" }],
        inventory: [{ op: "add-component", name: "Toast" }],
        rules: { add: [{ type: "count", id: "one-toast-per-page", scope: "page", select: { component: "Toast.Root" }, max: 1 }] },
        examples: {
          pass: [{ name: "one-toast", files: { "pages/booking.tsx": TOAST_PAGE(1)(booking) } }],
          fail: [{ name: "two-toasts", files: { "pages/booking.tsx": TOAST_PAGE(2)(booking) }, flagged_by: { rule: "one-toast-per-page", message: "has 2 Toast.Root" } }],
        },
      },
      "Toast is outside the inventory, so I am drafting a proposal instead of using it.",
    ),
    (body) => {
      assert.match(lastMessage(body), /Saved proposal "booking-toast" as open\. Core's adoption dry run passes: once approved it would be adopted, classified tightens\./);
      return textReply("I drafted booking-toast for you to approve.");
    },
  ]);
  await enterKey(page);
  await ask(page, "Show a toast when the room is booked");
  assert.equal(await turnEnded(page), "done");
  const card = page.locator('.chat-proposal[data-proposal="booking-toast"]');
  assert.match(await card.textContent(), /^Proposal draftedA toast that confirms a booking/);
  assert.match(await card.textContent(), /Core's adoption dry run passes/);
  await page.getByRole("tab", { name: "Project" }).click();
  await page.getByText("Proposals (1)").waitFor();
  assert.match(await page.locator(".project li").filter({ hasText: "booking-toast" }).first().textContent(), /^open A toast that confirms a booking booking-toast/);
  assert.equal((await report(page)).rules.some((rule) => rule.rule === "one-toast-per-page"), false, "an open proposal puts no rule in force");
  await shot(page, "chat-proposal-light");
  await page.reload();
  await page.getByRole("tab", { name: "Project" }).click();
  await page.getByText("Proposals (1)").waitFor();
  assert.ok(await page.locator('.chat-proposal[data-proposal="booking-toast"]').count(), "the chat and the proposal survive a reload");
});

test("stop mid-stream: the reply stops, nothing runs, and the next message works", async ({ browser, base, api }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  let held;
  const holding = new Promise((resolve) => (held = resolve));
  const long = streamEvents({ id: "msg_long", blocks: [{ type: "text", text: "I will rewrite every page of this prototype, starting with the rooms page and then" }, { type: "tool_use", id: "toolu_never", name: "write_file", input: { path: "pages/rooms.tsx", content: "export default function RoomsPage() { return null; }" } }], stopReason: "tool_use" });
  api.script([{ events: long, holdAfter: 4, onHold: () => held() }, textReply("Stopped; nothing changed.")]);
  await enterKey(page);
  await ask(page, "Rewrite everything");
  await holding;
  await page.locator(".chat-reply").last().locator(".chat-text").first().waitFor();
  await page.getByRole("button", { name: "Stop" }).click();
  assert.equal(await turnEnded(page), "stopped");
  assert.equal(await page.locator(".chat-reply").last().locator('.chat-tool[data-tool="write_file"]').count(), 0, "the half-streamed tool call never ran");
  assert.equal((await page.frameLocator('iframe[title="rooms-list at desktop"]').locator("h1").textContent()).trim(), "Rooms");
  await ask(page, "Never mind");
  assert.equal(await turnEnded(page), "done");
  assert.deepEqual(api.requests[1].body.messages.map((message) => message.role), ["user", "user"], "the stopped reply is not in the history");
});

test("an auth error and a refusal are shown plainly, without the key", async ({ browser, base, api }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  api.script([
    { status: 401, body: errorBody("authentication_error", `invalid x-api-key: ${KEY}`) },
    { events: streamEvents({ blocks: [], stopReason: "refusal", stopDetails: { type: "refusal", category: "cyber", explanation: "This request looks like exploit development." } }) },
  ]);
  await enterKey(page);
  await ask(page, "Hello");
  assert.equal(await turnEnded(page), "error");
  const auth = page.locator(".chat-reply").last().locator(".chat-end");
  assert.match(await auth.textContent(), /The API key was refused/);
  assert.ok(!(await page.locator(".chat").textContent()).includes(KEY), "the key is not shown, even when an error body echoes it");
  assert.equal(await auth.getByRole("button", { name: "Retry" }).count(), 0);
  await ask(page, "Find a vulnerability");
  assert.equal(await turnEnded(page), "refused");
  assert.match(await page.locator(".chat-reply").last().locator(".chat-end").textContent(), /The model declined this request.*This request looks like exploit development\. \(category: cyber\)/);
  await page.waitForTimeout(600); // Todae's Conversation animates a new message in
  await shot(page, "chat-errors-light");
});

test("undo puts the prototype back as it was before the turn, and the agent is told", async ({ browser, base, api }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  api.script([
    toolReply("rename", "edit_file", { path: "pages/rooms.tsx", old_text: '<Text.Root as="h1">Rooms</Text.Root>', new_text: '<Text.Root as="h1">Spaces</Text.Root>' }),
    textReply("Renamed."),
    (body) => {
      assert.match(lastMessage(body), /^The person undid your changes from their message "Call the rooms page Spaces"/);
      return textReply("Understood: it is Rooms again.");
    },
  ]);
  await enterKey(page);
  await ask(page, "Call the rooms page Spaces");
  assert.equal(await turnEnded(page), "done");
  assert.equal((await page.frameLocator('iframe[title="rooms-list at desktop"]').locator("h1").textContent()).trim(), "Spaces");
  await page.getByRole("button", { name: "Undo this turn" }).click();
  await page.locator(".chat-reply").last().getByText("Undone").waitFor();
  await measured(page, 3);
  assert.equal((await page.frameLocator('iframe[title="rooms-list at desktop"]').locator("h1").textContent()).trim(), "Rooms");
  assert.equal((await report(page)).status, "pass");
  await ask(page, "Thanks");
  assert.equal(await turnEnded(page), "done");
  assert.equal(api.left(), 0);
});

test("the key is in no frame, export, project storage, page storage or log; remember and forget work", async ({ browser, base, api }) => {
  const { page, logs } = await openApp(browser, base);
  await measured(page, 1);
  api.script([toolReply("rename", "edit_file", { path: "pages/rooms.tsx", old_text: '<Text.Root as="h1">Rooms</Text.Root>', new_text: '<Text.Root as="h1">Spaces</Text.Root>' }), textReply("Renamed.")]);
  await enterKey(page, { remember: true });
  await ask(page, "Call the rooms page Spaces");
  assert.equal(await turnEnded(page), "done");
  await measured(page, 2);
  await page.getByText("Settings and key").click();
  assert.match(await page.getByTestId("key-status").textContent(), /^Key sk-ant-…mnop: in this tab's memory, and stored on this device in IndexedDB database "design-harness-key"/);

  const frames = page.frames().filter((item) => item !== page.mainFrame());
  assert.equal(frames.length, 8);
  for (const frame of frames) {
    const seen = await frame.evaluate(async (key) => {
      const reach = async (fn) => {
        try {
          return String(await fn()).includes(key) ? "found" : "not found";
        } catch (error) {
          return error.name;
        }
      };
      // Every string the frame's global object holds, read one by one: some globals throw in an opaque origin.
      const strings = Object.keys(window).map((name) => {
        try {
          return typeof window[name] === "string" ? window[name] : "";
        } catch {
          return "";
        }
      });
      return {
        dom: document.documentElement.outerHTML.includes(key) ? "found" : "not found",
        globals: strings.some((value) => value.includes(key)) ? "found" : "not found",
        parent: await reach(() => window.parent.document.body.innerHTML),
        storage: await reach(() => indexedDB.databases().then((items) => JSON.stringify(items))),
      };
    }, KEY);
    assert.deepEqual(seen, { dom: "not found", globals: "not found", parent: "SecurityError", storage: "SecurityError" });
  }
  const srcdocs = await page.locator("iframe").evaluateAll((items) => items.map((item) => item.getAttribute("srcdoc") ?? ""));
  assert.ok(srcdocs.every((html) => !html.includes(KEY)), "no frame document carries the key");

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export", exact: true }).click()]);
  assert.ok(!readFileSync(await download.path(), "utf8").includes(KEY), "the export does not carry the key");

  const stored = await page.evaluate(async () => {
    const dump = async (name) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const out = {};
      for (const store of db.objectStoreNames) out[store] = await new Promise((resolve) => (db.transaction(store).objectStore(store).getAll().onsuccess = (event) => resolve(event.target.result)));
      db.close();
      return JSON.stringify(out);
    };
    return { project: await dump("design-harness"), key: await dump("design-harness-key"), local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }), names: (await indexedDB.databases()).map((item) => item.name).sort() };
  });
  assert.ok(stored.project.includes("Call the rooms page Spaces"), "the chat is saved with the project");
  assert.ok(!stored.project.includes(KEY), "the project database never holds the key");
  assert.ok(!stored.local.includes(KEY) && !stored.session.includes(KEY), "page storage never holds the key");
  assert.ok(stored.key.includes(KEY), "remembered, the key is in its own database");
  assert.deepEqual(stored.names, ["design-harness", "design-harness-key"]);
  assert.ok(logs.every((line) => !line.includes(KEY)), "the key is never logged");

  await page.reload();
  await page.getByText("Settings and key").click();
  assert.match(await page.getByTestId("key-status").textContent(), /stored on this device/);
  await page.getByRole("button", { name: "Forget the key" }).click();
  await page.getByLabel("Your Anthropic API key").waitFor();
  const forgotten = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.open("design-harness-key");
        request.onsuccess = () => {
          const db = request.result;
          db.transaction("keys").objectStore("keys").getAll().onsuccess = (event) => {
            resolve(event.target.result.length);
            db.close();
          };
        };
      }),
  );
  assert.equal(forgotten, 0, "forget deletes the key from the device");
  await page.reload();
  await page.getByLabel("Your Anthropic API key").waitFor();
});

test("screenshots of the chat in use, light and dark", async ({ browser, base, api }) => {
  if (!shots) return;
  for (const colorScheme of ["light", "dark"]) {
    const { page, context } = await openApp(browser, base, { colorScheme });
    await measured(page, 1);
    await shot(page, `chat-key-${colorScheme}`);
    api.script([
      toolReply("read", "read_project", {}, "Reading the project first."),
      toolReply("stand-out", "edit_file", { path: "pages/booking.tsx", old_text: HOLD_SECONDARY, new_text: HOLD_PRIMARY }),
      () => toolReply("fix", "edit_file", { path: "pages/booking.tsx", old_text: HOLD_PRIMARY, new_text: HOLD_SECONDARY }, "one-primary-per-page fails: a page holds one primary action, and that is Book room. Hold room goes back to secondary."),
      () => textReply("Hold room stays secondary. The project allows one primary action per page (Book room); every rule passes again."),
    ]);
    await enterKey(page);
    await ask(page, "Make Hold room stand out as much as Book room");
    await turnEnded(page);
    await page.locator(".chat-checks").first().click();
    await page.waitForTimeout(600);
    await shot(page, `chat-in-use-${colorScheme}`);
    await context.close();
  }
});

// ---- proposal review --------------------------------------------------------

const LEGAL = join(root, "..", "..", "packages", "core", "examples", "nook", "prototypes", "legal", "booking");
const BOOKING = readFileSync(join(LEGAL, "pages", "booking.tsx"), "utf8");
const ROOMS = readFileSync(join(LEGAL, "pages", "rooms.tsx"), "utf8");
const TOAST_RULE = { type: "count", id: "one-toast-per-page", scope: "page", select: { component: "Toast.Root" }, max: 1, description: "A page shows at most one toast." };

/** The toast proposal; with `failing` at 1 its failing example has one toast, which the rule passes. */
function toastDraft({ failing = 2, ...extra } = {}) {
  return {
    id: "booking-toast",
    title: "A toast that confirms a booking",
    reason: "Booking needs a confirmation that does not move the page, and Toast is not in the inventory.",
    states: [{ state: "booked", note: "the toast says the room is booked" }],
    inventory: [{ op: "add-component", name: "Toast" }],
    rules: { add: [TOAST_RULE] },
    examples: {
      pass: [{ name: "one-toast", files: { "pages/booking.tsx": TOAST_PAGE(1)(BOOKING) } }],
      fail: [failing === 2 ? { name: "two-toasts", files: { "pages/booking.tsx": TOAST_PAGE(2)(BOOKING) }, flagged_by: { rule: "one-toast-per-page", message: "has 2 Toast.Root" } } : { name: "only-one", files: { "pages/booking.tsx": TOAST_PAGE(1)(BOOKING) }, flagged_by: { rule: "one-toast-per-page" } }],
    },
    ...extra,
  };
}

/** A rendered rule only measured frames can prove: Harbor's open button is in the first view. Its failing example pushes it down with a long intro. */
const LONG_INTRO = ROOMS.replace(
  '<Text.Root as="p">Pick a free room to book or hold.</Text.Root>',
  Array.from({ length: 24 }, (_, index) => `<Text.Root as="p">Note ${index + 1}: every room is cleaned between bookings, and its screen is reset.</Text.Root>`).join("\n        "),
);
const HARBOR_DRAFT = {
  id: "harbor-first-view",
  title: "Keep Harbor in the first view",
  reason: "Harbor is the big room; people must see its open button without scrolling.",
  states: [{ state: "rooms", note: "the list shows both rooms, Harbor's button above the fold" }],
  rules: { add: [{ type: "rendered", id: "harbor-in-first-view", check: "first-view", action: "Open Harbor" }] },
  examples: { pass: [{ name: "as-is" }], fail: [{ name: "long-intro", files: { "pages/rooms.tsx": LONG_INTRO }, flagged_by: { rule: "harbor-in-first-view" } }] },
};

/** Has the agent draft a proposal through the fake API, and waits for the chat's card. */
async function draftByAgent(page, api, input, { key = true } = {}) {
  api.script([toolReply("draft", "draft_proposal", input, "This needs a change to the project, so I am drafting a proposal."), textReply(`I drafted ${input.id} for you to review.`)]);
  if (key) await enterKey(page);
  await ask(page, "Propose what this needs");
  assert.equal(await turnEnded(page), "done");
  await page.locator(`.chat-proposal[data-proposal="${input.id}"]`).last().waitFor();
}

async function openReview(page, id) {
  await page.locator(`.chat-proposal[data-proposal="${id}"]`).last().getByRole("button", { name: "Review the proposal" }).click();
  await page.locator(`.review[data-proposal="${id}"]`).waitFor();
}

/** Waits until every example has been measured and core has judged it. */
async function judged(page) {
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll(".review .example")];
    return cards.length > 0 && cards.every((card) => card.getAttribute("data-verdict") !== "measuring");
  }, null, { timeout: 60000 });
}

const example = (page, name) => page.locator(`.review .example[data-example="${name}"]`);
const reviewStatus = (page) => page.locator(".review").getAttribute("data-status");

test("a drafted proposal opens to its review page: examples side by side in frames, the failing one outlined", async ({ browser, base, api }) => {
  const { page, errors } = await openApp(browser, base);
  await measured(page, 1);
  await draftByAgent(page, api, toastDraft());
  assert.equal(await page.getByTestId("open-proposals").textContent(), "1", "the open proposal is counted on the Proposals tab");
  await openReview(page, "booking-toast");
  assert.equal(await reviewStatus(page), "open");
  assert.equal((await page.locator(".review h1").textContent()).trim(), "A toast that confirms a booking");
  assert.match(await page.getByTestId("proposal-reason").textContent(), /Toast is not in the inventory/);
  assert.match(await page.getByTestId("proposal-states").textContent(), /booked.*the toast says the room is booked/);
  assert.equal(await page.getByTestId("proposal-class").first().textContent(), "tightens");
  await shot(page, "review-top-light");
  await shotDark(page, "review-top-dark");
  // The inventory diff, before and after.
  assert.deepEqual(await page.locator('.diff-section[data-section="components"] [data-change]').evaluateAll((items) => items.map((item) => [item.dataset.change, item.textContent.trim()])), [["added", "+ Toast"]]);
  // The rule in words from its data, the raw rule one click away.
  assert.equal(await page.locator('.rule-words[data-rule="one-toast-per-page"] [data-testid="rule-words"]').textContent(), "Each page holds at most 1 Toast.Root.");
  await page.locator('.rule-words[data-rule="one-toast-per-page"]').getByText("Rule data for").click();
  assert.deepEqual(JSON.parse(await page.locator('.rule-words[data-rule="one-toast-per-page"] [data-testid="rule-json"]').textContent()), TOAST_RULE);

  await judged(page);
  const pass = await example(page, "one-toast").boundingBox();
  const fail = await example(page, "two-toasts").boundingBox();
  assert.ok(pass.x + pass.width <= fail.x && Math.abs(pass.y - fail.y) < 40, "passing on the left, failing on the right, side by side");
  assert.equal(await example(page, "one-toast").getAttribute("data-expect"), "pass");
  assert.equal(await example(page, "one-toast").getByTestId("example-verdict").textContent(), "passes");
  assert.equal(await example(page, "two-toasts").getByTestId("example-verdict").textContent(), "fails for one-toast-per-page alone");
  assert.equal(await example(page, "two-toasts").getByTestId("example-detail").textContent(), 'flagged by "one-toast-per-page" and no other rule');
  // Rendered in frames of their own, at every view, opened on the scenario the rule flags.
  for (const view of VIEWS) {
    const frame = page.frameLocator(`iframe[title="two-toasts: lantern-open at ${view}"]`);
    assert.equal(await frame.locator("text=Booked").count(), 2, `the failing example renders its two toasts at ${view}`);
    assert.equal(await page.locator(`.example[data-example="two-toasts"] .frame-card[data-frame-key="lantern-open@${view}"]`).getAttribute("data-state"), "measured");
  }
  // The flagged line, marked as the code view marks a finding's line.
  const finding = await example(page, "two-toasts").locator(".finding-message").first().textContent();
  assert.match(finding, /^Page "booking" has 2 Toast.Root, more than 1: Toast.Root "Booked" at pages\/booking.tsx:\d+:\d+/);
  const marked = await example(page, "two-toasts").locator('.example-source [data-kind="finding"]').textContent();
  assert.ok(marked.includes("<Toast.Root>Booked</Toast.Root><Toast.Root>Booked</Toast.Root>"), `the marked line holds both toasts: ${marked}`);
  assert.match(await page.getByTestId("review-verdict").textContent(), /^Core's adoption dry run: it would be adopted, classified tightens, and no prototype would newly fail\./);
  await page.locator("#review-examples").evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(300);
  await shot(page, "review-examples-light");

  await page.getByRole("button", { name: "← All proposals" }).click();
  const row = page.locator('.proposals-table tr[data-proposal="booking-toast"]');
  assert.match(await row.textContent(), /A toast that confirms a booking.*booking-toast.*open.*tightens.*by agent/);
  await page.getByRole("button", { name: "Adopted (0)" }).click();
  await page.getByText("No adopted proposals").waitFor();
  await page.getByRole("button", { name: "Open (1)" }).click();
  assert.equal(await page.locator(".proposals-table tbody tr").count(), 1);
  await shot(page, "proposals-list-light");
  assert.deepEqual(errors, []);
});

test("approve then adopt: the new rule is in the checks panel, and flags a prototype that breaks it", async ({ browser, base, api }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  await draftByAgent(page, api, toastDraft());
  await openReview(page, "booking-toast");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".review")?.getAttribute("data-status") === "approved");
  assert.equal(await page.getByTestId("open-proposals").count(), 0, "an approved proposal is no longer counted as open");
  await judged(page);
  await page.waitForSelector('[data-testid="review-measuring"][data-measured]');
  await page.getByRole("button", { name: "Adopt", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".review")?.getAttribute("data-status") === "adopted");
  assert.match(await page.getByTestId("review-in-force").textContent(), /Adopted by you.*In force now, on every prototype: one-toast-per-page/);
  assert.match(await page.getByTestId("review-rechecked").textContent(), /Every prototype was re-checked: none newly fails\./);
  assert.deepEqual(await page.locator('[data-testid="review-history"] [data-kind="status"]').evaluateAll((items) => items.map((item) => item.dataset.entryStatus)), ["open", "approved", "adopted"]);
  assert.match(await page.getByTestId("review-history").textContent(), /Drafted by agent.*Approved by you.*Adopted by you/);
  await shot(page, "review-adopted-light");

  // The board re-checks the open prototype with the new rule in force.
  await showAllRules(page);
  await page.waitForSelector('.checks[data-measured] .rule[data-rule="one-toast-per-page"][data-status="pass"]', { timeout: 60000, state: "attached" });
  const revision = Number(await page.locator(".checks").getAttribute("data-revision"));
  await editFile(page, "pages/booking.tsx", TOAST_PAGE(2));
  await measured(page, revision + 1);
  const value = await report(page);
  assert.deepEqual(failing(value), ["one-toast-per-page"], "Toast is in the inventory now, and two of them break the new rule alone");
  assert.match(value.findings[0].message, /^Page "booking" has 2 Toast.Root, more than 1/);
});

test("an adoption whose failing example does not fail is refused, and the page says why", async ({ browser, base, api }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  await draftByAgent(page, api, toastDraft({ failing: 1 }));
  assert.match(await page.locator('.chat-proposal[data-proposal="booking-toast"]').textContent(), /refuses it: \[failing-example-passes\]/);
  await openReview(page, "booking-toast");
  await judged(page);
  assert.equal(await example(page, "only-one").getAttribute("data-verdict"), "bad");
  assert.equal(await example(page, "only-one").getByTestId("example-verdict").textContent(), "does not behave");
  assert.equal(await example(page, "only-one").getByTestId("example-detail").textContent(), 'failing example "only-one" is not flagged as it must be: "one-toast-per-page" passed it');
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".review")?.getAttribute("data-status") === "approved");
  await page.waitForSelector('[data-testid="review-measuring"][data-measured]');
  await page.getByRole("button", { name: "Adopt", exact: true }).click();
  const refusal = page.getByTestId("review-refusal");
  await refusal.waitFor();
  assert.equal(await refusal.getAttribute("data-code"), "failing-example-passes");
  assert.equal(await page.getByTestId("review-refusal-message").textContent(), 'failing example "only-one" is not flagged as it must be: "one-toast-per-page" passed it');
  assert.match(await refusal.textContent(), /Not adopted: core refused it.*Reason.*failing-example-passes.*Example.*Show Only one/);
  assert.equal(await reviewStatus(page), "approved", "a refused adoption changes nothing");
  assert.equal((await report(page)).rules.some((rule) => rule.rule === "one-toast-per-page"), false);
  await page.waitForTimeout(300);
  await shot(page, "review-refusal-light");
});

test("decline needs a note, and the history records it", async ({ browser, base, api }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  await draftByAgent(page, api, toastDraft());
  await openReview(page, "booking-toast");
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await page.getByRole("button", { name: "Decline proposal" }).click();
  assert.equal(await page.getByRole("alert").filter({ hasText: "Say why you decline it." }).count(), 1, "an empty note is refused");
  assert.equal(await reviewStatus(page), "open");
  await page.getByLabel("Why decline it?").fill("Toasts move focus away from the booking; not this quarter.");
  await page.getByRole("button", { name: "Decline proposal" }).click();
  await page.waitForFunction(() => document.querySelector(".review")?.getAttribute("data-status") === "declined");
  assert.equal(await page.getByRole("button", { name: "Approve", exact: true }).count(), 0, "a declined proposal offers no action");
  assert.match(await page.getByTestId("review-history").textContent(), /Declined by you.*Toasts move focus away from the booking; not this quarter\./);
  assert.deepEqual(await page.getByTestId("history-note").allTextContents(), ["Toasts move focus away from the booking; not this quarter."]);
  await page.reload();
  await page.getByRole("tab", { name: /Proposals/ }).click();
  await page.getByRole("button", { name: "Declined (1)" }).click();
  await page.locator('.proposals-table tr[data-proposal="booking-toast"][data-status="declined"]').waitFor();
});

test("send back reaches the agent, which revises the proposal, and the history shows both versions", async ({ browser, base, api }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  await draftByAgent(page, api, toastDraft());
  await openReview(page, "booking-toast");
  const note = "Say what the toast says when a booking fails, too.";
  api.script([
    (body) => {
      const text = lastMessage(body);
      assert.match(text, /^I sent proposal "booking-toast" \(A toast that confirms a booking\) back to you from its review page\. Revise it with revise_proposal/);
      assert.ok(text.endsWith(note), "the note reaches the agent word for word");
      return toolReply("revise", "revise_proposal", {
        id: "booking-toast",
        note: "Added the failed-booking state and what the toast says in it.",
        title: "A toast that confirms a booking, or says it failed",
        states: [
          { state: "booked", note: "the toast says the room is booked" },
          { state: "failed", note: "the toast says the booking failed and to try again" },
        ],
      });
    },
    (body) => {
      assert.match(lastMessage(body), /^Revised proposal "booking-toast"; it is still open, and its history keeps the version before this one\. Core's adoption dry run passes/);
      return textReply("I revised booking-toast: it now names the failed state.");
    },
  ]);
  await page.getByRole("button", { name: "Send back to the agent" }).click();
  await page.getByRole("button", { name: "Send to the agent" }).click();
  assert.equal(await page.getByRole("alert").filter({ hasText: "Say what the agent should change." }).count(), 1, "an empty note is refused");
  await page.getByLabel("What should the agent change?").fill(note);
  await page.getByRole("button", { name: "Send to the agent" }).click();
  // The note becomes the person's next chat message: a second turn.
  await page.waitForFunction(() => document.querySelectorAll(".chat-reply").length === 2);
  assert.match(await page.locator('.chat [data-turn]').nth(2).textContent(), /^I sent proposal "booking-toast"/);
  assert.equal(await turnEnded(page), "done");
  assert.equal(api.left(), 0);
  assert.match(await page.locator(".chat-reply").last().locator('.chat-proposal[data-action="revised"]').textContent(), /^Proposal revisedA toast that confirms a booking, or says it failed/);
  await page.waitForFunction(() => document.querySelector(".review h1")?.textContent?.includes("or says it failed"));
  assert.equal(await reviewStatus(page), "open");
  assert.match(await page.getByTestId("proposal-states").textContent(), /failed.*the booking failed/);
  const history = page.getByTestId("review-history");
  assert.deepEqual(await history.locator("[data-kind]").evaluateAll((items) => items.map((item) => item.dataset.kind)), ["status", "sent-back", "revised", "now"]);
  assert.match(await history.textContent(), new RegExp(`Drafted by agent.*Sent back by you.*${note}.*Revised by agent.*Added the failed-booking state`));
  await history.getByText("The version before this revision").click();
  assert.match(await page.getByTestId("history-previous").textContent(), /Title\s*A toast that confirms a booking(?!,)/);
  assert.match(await history.textContent(), /Now: open, version 2 shown above/);
  await judged(page);
  assert.deepEqual(await page.locator(".review .example").evaluateAll((cards) => cards.map((card) => card.dataset.verdict)), ["ok", "ok"], "the revision is measured and judged too");
  await page.locator("#review-history").evaluate((element) => element.scrollIntoView({ block: "start" }));
  await shot(page, "review-history-light");
});

test("the impact list names a prototype that would newly fail, and opens it on the board", async ({ browser, base, api }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  const noHold = BOOKING.replace(/\s*<Slot name="alternate">[\s\S]*?<\/Slot>/, "");
  await draftByAgent(page, api, {
    id: "book-without-hold",
    title: "Booking offers no second action",
    reason: "One action per booking page: holding a room confuses people.",
    rules: { add: [{ type: "count", id: "no-secondary-on-booking", scope: "page", pages: { types: ["booking"] }, select: { role: "secondary-action" }, max: 0 }] },
    examples: { pass: [{ name: "book-only", files: { "pages/booking.tsx": noHold } }], fail: [{ name: "with-hold", flagged_by: { rule: "no-secondary-on-booking" } }] },
  });
  await openReview(page, "book-without-hold");
  await judged(page);
  const impact = page.getByTestId("review-impact");
  await impact.locator('[data-prototype="booking"]').waitFor({ timeout: 60000 });
  assert.match(await impact.locator('[data-prototype="booking"]').textContent(), /Booking.*would newly fail no-secondary-on-booking.*Page "booking" has 1 secondary action, more than 0: Button.Root "Hold room"/);
  // The spec prototype is measured in frames of its own, and the same rule flags its Hold room.
  await impact.locator('[data-prototype="booking-spec"]').waitFor({ timeout: 60000 });
  assert.match(await impact.locator('[data-prototype="booking-spec"]').textContent(), /Booking \(spec\).*would newly fail no-secondary-on-booking.*Page "booking" has 1 secondary action, more than 0: Button.Root "Hold room" at pages\/booking.json/);
  assert.match(await page.getByTestId("review-verdict").textContent(), /2 prototypes would newly fail/);
  await page.locator("#review-impact").evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(300);
  await shot(page, "review-impact-light");
  await impact.locator('[data-prototype="booking"]').getByRole("button", { name: "Open on the board" }).click();
  await page.locator('main[aria-label="Canvas"]').waitFor();
  assert.equal(await page.locator(".app-main-pane").first().getAttribute("data-inactive"), null, "the board is in front");
});

test("a proposal that adds a rendered rule adopts on measured snapshots, and gives the same result after reload", async ({ browser, base, api }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  await draftByAgent(page, api, HARBOR_DRAFT);
  assert.match(await page.locator('.chat-proposal[data-proposal="harbor-first-view"]').textContent(), /need measured snapshots: this dry run has none/);
  await openReview(page, "harbor-first-view");
  assert.match(await page.locator('.rule-words[data-rule="harbor-in-first-view"] [data-testid="rule-words"]').textContent(), /^Measured in every scenario at every view: wherever "Open Harbor" is shown, it is inside the first view, without scrolling\.$/);
  await judged(page);
  assert.equal(await example(page, "as-is").getByTestId("example-verdict").textContent(), "passes");
  assert.equal(await example(page, "long-intro").getByTestId("example-verdict").textContent(), "fails for harbor-in-first-view alone");
  assert.match(await example(page, "long-intro").locator(".finding-message").first().textContent(), /^At \d+ by \d+: "Open Harbor" is at \d+ to \d+ CSS px, below the first view of \d+\.$/);
  // The frame outlines the button the rendered rule flags, with the board's own highlight.
  const frame = page.frameLocator('iframe[title="long-intro: rooms-list at phone"]');
  await frame.locator("[data-design-harness-overlay]").waitFor({ state: "attached" });
  const overlay = await frame.locator("[data-design-harness-overlay]").boundingBox();
  const target = await frame.getByRole("button", { name: "Open Harbor" }).boundingBox();
  assert.ok(overlay && target && overlay.x <= target.x && overlay.x + overlay.width >= target.x + target.width && overlay.y <= target.y, "the outline is around Open Harbor");
  assert.equal(await page.locator('.example[data-example="long-intro"] .frame-card[data-frame-key="rooms-list@phone"]').getAttribute("data-selected"), "");
  await page.locator("#review-examples").evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(300);
  await shot(page, "review-rendered-light");

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".review")?.getAttribute("data-status") === "approved");
  await page.waitForSelector('[data-testid="review-measuring"][data-measured]');
  await page.getByRole("button", { name: "Adopt", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".review")?.getAttribute("data-status") === "adopted");
  const verdicts = async () => page.locator(".review .example").evaluateAll((cards) => cards.map((card) => [card.dataset.example, card.dataset.verdict, card.querySelector('[data-testid="example-detail"]').textContent]));
  const adopted = await verdicts();
  assert.deepEqual(adopted, [["as-is", "ok", "passes every rule"], ["long-intro", "ok", 'flagged by "harbor-in-first-view"']]);

  // The snapshots it was adopted on are stored with the proposal.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export", exact: true }).click()]);
  const stored = JSON.parse(readFileSync(await download.path(), "utf8")).project.proposals.find((item) => item.id === "harbor-first-view");
  assert.deepEqual([stored.status, stored.examples.pass[0].snapshots.length, stored.examples.fail[0].snapshots.length], ["adopted", 8, 8]);

  await page.reload();
  await measured(page, 1);
  await page.getByRole("tab", { name: "Project" }).click();
  await page.getByRole("button", { name: "Re-run every adopted proposal's examples" }).click();
  assert.match(await page.getByTestId("regression-summary").textContent(), /^All 2 examples behave/);
  assert.equal(await page.locator("iframe").count(), 8, "re-running reads the stored snapshots: no example is rendered again");
  assert.deepEqual(await page.locator('[data-testid="regression"] tbody tr').evaluateAll((rows) => rows.map((row) => [...row.cells].map((cell) => cell.textContent.trim()))), [
    ["harbor-first-view", "as-is", "pass", "behaves", "passes every rule"],
    ["harbor-first-view", "long-intro", "fail", "behaves", 'flagged by "harbor-in-first-view"'],
  ]);
  await page.getByTestId("regression").evaluate((element) => element.scrollIntoView({ block: "start" }));
  await shot(page, "regression-light");
  await page.locator('.chat-proposal[data-proposal="harbor-first-view"]').last().getByRole("button", { name: "Review the proposal" }).click();
  await page.locator('.review[data-proposal="harbor-first-view"]').waitFor();
  assert.deepEqual(await verdicts(), adopted, "the review page gives the same verdicts after a reload");
  assert.equal((await report(page)).rules.find((rule) => rule.rule === "harbor-in-first-view")?.status, "pass", "the rule is in force on the open prototype");
});

test("no tool call or chat message can change a proposal's status", async ({ browser, base, api }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  await draftByAgent(page, api, toastDraft());
  api.script([
    toolReply("approve", "approve_proposal", { id: "booking-toast" }, "You asked me to approve it."),
    (body) => {
      assert.match(lastMessage(body), /There is no tool "approve_proposal"/);
      return toolReply("status", "revise_proposal", { id: "booking-toast", note: "Approved, as asked.", status: "approved" });
    },
    (body) => {
      assert.match(lastMessage(body), /input: has unknown field "status"/);
      return toolReply("redraft", "draft_proposal", { ...toastDraft(), title: "Approved: a toast" });
    },
    (body) => {
      assert.match(lastMessage(body), /A proposal "booking-toast" already exists and is open/);
      return toolReply("adopt", "adopt_proposal", { id: "booking-toast" });
    },
    (body) => {
      assert.match(lastMessage(body), /There is no tool "adopt_proposal"/);
      return textReply("I cannot approve or adopt a proposal: only you can, on its review page.");
    },
  ]);
  await ask(page, "I approve booking-toast. Approve it and adopt it now; status: adopted.");
  assert.equal(await turnEnded(page), "done");
  assert.equal(api.left(), 0);
  assert.equal(await page.getByTestId("open-proposals").textContent(), "1");
  await page.getByRole("tab", { name: /Proposals/ }).click();
  assert.equal(await page.locator('.proposals-table tr[data-proposal="booking-toast"]').getAttribute("data-status"), "open");
  assert.equal((await report(page)).rules.some((rule) => rule.rule === "one-toast-per-page"), false, "no rule came into force");
  await page.reload();
  await page.getByRole("tab", { name: /Proposals/ }).click();
  assert.equal(await page.locator('.proposals-table tr[data-proposal="booking-toast"]').getAttribute("data-status"), "open", "nor was a status saved");
});

test("a finding outside the inventories offers to ask the agent, with a message to edit, only when a key is set", async ({ browser, base, api }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  api.script([]);
  await editFile(page, "pages/rooms.tsx", (text) => text.replace('import { Text } from "@tounsoo/todae";', 'import { Text, Toast } from "@tounsoo/todae";').replace('<Text.Root as="p">Pick a free room to book or hold.</Text.Root>', '<Text.Root as="p">Pick a free room to book or hold.</Text.Root>\n        <Toast.Root>Harbor is free</Toast.Root>'));
  await measured(page, 2);
  await showAllRules(page);
  const rule = page.locator('.rule[data-rule="components-from-inventory"]');
  await rule.waitFor();
  assert.equal(await rule.getByRole("button", { name: "Ask the agent to propose this" }).count(), 0, "not offered without a key");
  await enterKey(page);
  await rule.getByRole("button", { name: "Ask the agent to propose this" }).first().click();
  const box = page.getByRole("textbox", { name: "Message the agent" });
  await page.waitForFunction(() => (document.querySelector(".chat-composer textarea")?.value ?? "") !== "");
  const text = await box.inputValue();
  assert.match(text, /^The check "components-from-inventory" says: .*Toast/);
  assert.match(text, /draft a proposal that adds it to the inventory/);
  assert.equal(api.requests.length, 0, "the message waits for the person to send it");
  await box.fill(`${text}\nKeep it to the rooms page.`);
  assert.match(await box.inputValue(), /Keep it to the rooms page\.$/, "the person can edit it before sending");
  await shot(page, "ask-agent-light");
});

test("screenshots of the review page in dark", async ({ browser, base, api }) => {
  if (!shots) return;
  const { page, context } = await openApp(browser, base, { colorScheme: "dark" });
  await measured(page, 1);
  await draftByAgent(page, api, toastDraft());
  await openReview(page, "booking-toast");
  await judged(page);
  await page.locator("#review-examples").evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(300);
  await shot(page, "review-examples-dark");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.waitForSelector('[data-testid="review-measuring"][data-measured]');
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await page.getByRole("button", { name: "Decline proposal" }).click();
  await page.waitForTimeout(400);
  await shot(page, "review-decline-dark");
  await context.close();
  const dark = await openApp(browser, base, { colorScheme: "dark" });
  await measured(dark.page, 1);
  await draftByAgent(dark.page, api, toastDraft({ failing: 1 }));
  await openReview(dark.page, "booking-toast");
  await judged(dark.page);
  await dark.page.getByRole("button", { name: "Approve", exact: true }).click();
  await dark.page.waitForSelector('[data-testid="review-measuring"][data-measured]');
  await dark.page.getByRole("button", { name: "Adopt", exact: true }).click();
  await dark.page.getByTestId("review-refusal").waitFor();
  await dark.page.waitForTimeout(300);
  await shot(dark.page, "review-refusal-dark");
  await dark.context.close();
  const impact = await openApp(browser, base, { colorScheme: "dark" });
  await measured(impact.page, 1);
  await draftByAgent(impact.page, api, {
    id: "book-without-hold",
    title: "Booking offers no second action",
    reason: "One action per booking page.",
    rules: { add: [{ type: "count", id: "no-secondary-on-booking", scope: "page", pages: { types: ["booking"] }, select: { role: "secondary-action" }, max: 0 }] },
    examples: { pass: [{ name: "book-only", files: { "pages/booking.tsx": BOOKING.replace(/\s*<Slot name="alternate">[\s\S]*?<\/Slot>/, "") } }], fail: [{ name: "with-hold", flagged_by: { rule: "no-secondary-on-booking" } }] },
  });
  await openReview(impact.page, "book-without-hold");
  await judged(impact.page);
  await impact.page.getByTestId("review-impact").locator('[data-prototype="booking"]').waitFor({ timeout: 60000 });
  await impact.page.getByTestId("review-impact").scrollIntoViewIfNeeded();
  await shot(impact.page, "review-impact-dark");
  await impact.context.close();
});

// ---- spec prototypes -------------------------------------------------------

/** Opens the app on the seeded spec prototype, Booking (spec), and waits for its frames to be measured. */
async function openSpec(browser, base, options = {}) {
  const opened = await openApp(browser, base, options);
  await measured(opened.page, 1);
  await opened.page.getByRole("combobox", { name: "Prototype" }).selectOption("booking-spec");
  await measured(opened.page, 2);
  return opened;
}

test("the spec prototype renders every frame from data, and passes every rule", async ({ browser, base }) => {
  const { page, errors, logs } = await openSpec(browser, base);
  const cards = await page.locator(".frame-card").evaluateAll((elements) => elements.map((element) => [element.dataset.frameKey, element.dataset.state]));
  assert.deepEqual(cards, SCENARIOS.flatMap((scenario) => VIEWS.map((view) => [`${scenario}@${view}`, "measured"])));
  for (const scenario of SCENARIOS) {
    const frame = page.frameLocator(`iframe[title="${scenario} at desktop"]`);
    assert.equal((await frame.locator("h1").textContent())?.trim(), scenario === "rooms-list" ? "Rooms" : "Lantern");
  }
  const booked = page.frameLocator('iframe[title="lantern-booked at phone"]');
  assert.equal(await booked.locator("text=Booked until 3 pm").count(), 1, "the scenario's flow state reaches the spec's visible condition");
  assert.equal(await booked.locator("text=Held for 10 minutes").count(), 0);
  const rooms = page.frameLocator('iframe[title="rooms-list at desktop"]');
  assert.deepEqual(await rooms.getByRole("button").allTextContents(), ["Open Lantern", "Open Harbor"], "the repeat draws one card per room in state");
  const value = await report(page);
  assert.equal(value.status, "pass", JSON.stringify(value.findings, null, 1));
  assert.deepEqual(value.findings, []);
  assert.equal(value.rules.length, 33);
  await shot(page, "spec-board-light");
  assert.deepEqual(errors, []);
  assert.deepEqual(logs.filter((line) => /json-render|No renderer|Missing element/.test(line)), []);
});

test("a spec frame loads the library, React, json-render and the spec renderer, and no prototype code", async ({ browser, base }) => {
  const { page } = await openSpec(browser, base);
  for (const scenario of SCENARIOS) {
    const imports = await page.frameLocator(`iframe[title="${scenario} at desktop"]`).locator('script[type="importmap"]').evaluate((element) => Object.keys(JSON.parse(element.textContent ?? "{}").imports).sort());
    assert.deepEqual(imports, ["@design-harness/page", "@design-harness/spec", "@json-render/react", "@tounsoo/todae", "react", "react-dom", "react-dom/client", "react/jsx-runtime"]);
  }
});

test("a violation injected into a spec is flagged: its JSON line marked, a rendered one outlined in its frame", async ({ browser, base }) => {
  const { page } = await openSpec(browser, base);
  const edited = await editFile(page, "pages/booking.json", (text) => text.replace('"variant": "secondary", "text": "Hold room"', '"variant": "primary", "text": "Hold room"'));
  await measured(page, 3);
  let value = await report(page);
  assert.ok(failing(value).includes("one-primary-per-page"), `one-primary-per-page fails: ${failing(value)}`);
  const finding = value.findings.find((item) => item.rule === "one-primary-per-page");
  assert.match(finding.message, /^Page "booking" has 2 primary actions, more than 1: Button.Root "Hold room" at pages\/booking.json:22:5, Button.Root "Book room" at pages\/booking.json:23:5\.$/);
  assert.deepEqual(finding.targets.map((target) => [target.key, target.page, target.line]), [["hold", "booking", 22], ["book", "booking", 23]]);
  await showAllRules(page);
  await page.locator('.rule[data-rule="one-primary-per-page"] .finding').first().click();
  // Both, outlined in every frame of the booking page by their keys in the expanded spec.
  await outlinedInBookingFrames(page, 2);
  for (const scenario of BOOKING_SCENARIOS) {
    for (const view of VIEWS) {
      const boxes = await overlays(page, scenario, view);
      for (const name of ["Hold room", "Book room"]) {
        const [target] = await buttonBoxes(page, scenario, view, name);
        assert.ok(boxes.some((box) => surrounds(box, target)), `${name} is outlined in ${scenario} at ${view}`);
      }
    }
  }
  await shot(page, "spec-failing-source-outlined-light");
  await page.locator('.rule[data-rule="one-primary-per-page"]').getByRole("button", { name: "Show in code" }).first().click();
  await page.waitForSelector('[data-testid="code-line"]');
  assert.equal(await page.locator('[data-testid="code-line"]').textContent(), `line ${finding.line}, column ${finding.column}`);
  const marked = (await page.locator('.code-field [data-kind="finding"]').textContent()) ?? "";
  assert.equal(marked, edited.split("\n")[finding.line - 1], "the marked line is the element's line in the spec");
  assert.match(marked, /"(hold|book)": \{ "type": "Button.Root"/);
  await shot(page, "spec-failing-source-light");

  await editFile(page, "pages/booking.json", (text) => text.replace('"variant": "primary", "text": "Hold room"', '"variant": "secondary", "text": "Hold room"').replace('"as": "p", "text": { "$template"', '"as": "h3", "text": { "$template"'));
  await measured(page, 4);
  value = await report(page);
  assert.deepEqual(failing(value), ["heading-structure"]);
  const heading = value.findings.find((item) => item.rule === "heading-structure" && item.scenario === "lantern-open" && item.view === "desktop");
  assert.ok(heading && typeof heading.element === "number", "heading-structure flags lantern-open at desktop, at an element");
  await showAllRules(page);
  await page.locator('.rule[data-rule="heading-structure"] .finding').filter({ hasText: "scenario lantern-open" }).filter({ hasText: "view desktop" }).first().click();
  const frame = page.frameLocator('iframe[title="lantern-open at desktop"]');
  await frame.locator("[data-design-harness-overlay]").waitFor({ state: "attached" });
  const overlay = await frame.locator("[data-design-harness-overlay]").boundingBox();
  const target = await frame.locator("h3", { hasText: "6 seats, Second floor" }).boundingBox();
  assert.ok(overlay && target && overlay.x <= target.x && overlay.y <= target.y && overlay.x + overlay.width >= target.x + target.width, "the outline is drawn around the heading");
  await shot(page, "spec-failing-rendered-light");
});

test("what the catalog refuses is reported by extract and never reaches the frame", async ({ browser, base }) => {
  const { page } = await openSpec(browser, base);
  await editFile(page, "pages/booking.json", (text) =>
    text
      .replace('"variant": "primary", "text": "Book room" }', '"variant": "primary", "text": "Book room", "style": { "display": "none" } }')
      .replace('"alternate": ["hold"]', '"alternate": ["hold", "free"]')
      .replace('"hold": {', '"free": { "type": "Badge.Root", "props": { "text": "Free" }, "children": [] },\n    "hold": {'),
  );
  await measured(page, 3);
  const value = await report(page);
  assert.deepEqual(failing(value), ["extract"]);
  assert.deepEqual(
    value.findings.map((item) => item.message),
    [
      'pages/booking.json: element "free" is a Badge.Root, which is not in the catalog. The catalog has the parts of the inventoried components (Alert, Button, Card, Disclosure, EmptyState, Field, Label, Stack, Text), Page and Layout.',
      `pages/booking.json: element "book" sets "style", a style prop the project excludes ("style" in library.excludedProps): a Button.Root's styling must come from the library's own variants and tokens, not from props that style it directly.`,
    ],
  );
  const frame = page.frameLocator('iframe[title="lantern-open at desktop"]');
  assert.equal(await frame.getByRole("button", { name: "Book room" }).isVisible(), true, "the refused style prop never reached the button");
  assert.equal(await frame.locator("text=Free").count(), 0, "the refused Badge rendered nothing");
});

test("the same spec prototype gives the same report on reload", async ({ browser, base }) => {
  const { page, logs } = await openSpec(browser, base);
  const first = await report(page);
  await page.reload();
  await measured(page, 1);
  await page.getByRole("combobox", { name: "Prototype" }).selectOption("booking-spec");
  await measured(page, 2);
  assert.deepEqual(await report(page), first);
  // zod, inside json-render, probes for eval to speed itself up; the frame's CSP refuses it and zod falls back. Nothing else is refused.
  const refused = logs.filter((line) => /Content Security Policy|unsafe-eval|EvalError/.test(line));
  console.log(`     frame console lines refused by the CSP: ${refused.length}${refused[0] ? ` (first: ${refused[0].slice(0, 160)})` : ""}`);
});

// ---- the agent and proposals on a spec prototype ---------------------------

const SPEC_LEGAL = join(root, "..", "..", "packages", "core", "examples", "nook", "prototypes", "spec", "legal", "booking");
const SPEC_BOOKING = readFileSync(join(SPEC_LEGAL, "pages", "booking.json"), "utf8");
/** The booking spec with `count` toasts in its facts slot. */
const SPEC_TOASTS = (count) => (text) =>
  text
    .replace('"facts": ["seats", "booked-note", "held-note"]', `"facts": ["seats", "booked-note", "held-note"${Array.from({ length: count }, (_, index) => `, "toast-${index + 1}"`).join("")}]`)
    .replace('    "hold": {', `${Array.from({ length: count }, (_, index) => `    "toast-${index + 1}": { "type": "Toast.Root", "props": { "tone": "success", "text": "Booked" }, "children": [] },\n`).join("")}    "hold": {`);

function specToastDraft({ failing = 2 } = {}) {
  return {
    id: "booking-toast",
    title: "A toast that confirms a booking",
    reason: "Booking needs a confirmation that does not move the page, and Toast is not in the catalog.",
    states: [{ state: "booked", note: "the toast says the room is booked" }],
    inventory: [{ op: "add-component", name: "Toast" }],
    rules: { add: [TOAST_RULE] },
    examples: {
      pass: [{ name: "one-toast", files: { "pages/booking.json": SPEC_TOASTS(1)(SPEC_BOOKING) } }],
      fail: [failing === 2 ? { name: "two-toasts", files: { "pages/booking.json": SPEC_TOASTS(2)(SPEC_BOOKING) }, flagged_by: { rule: "one-toast-per-page", message: "has 2 Toast.Root" } } : { name: "only-one", files: { "pages/booking.json": SPEC_TOASTS(1)(SPEC_BOOKING) }, flagged_by: { rule: "one-toast-per-page" } }],
    },
  };
}

test("the agent writes specs: the catalog's prompt, a patch the catalog refuses, a patch drawn on the canvas as it streams", async ({ browser, base, api }) => {
  const { page, logs } = await openSpec(browser, base);
  const rename = '{"op":"replace","path":"/elements/heading/props/text","value":"Spaces"}\n{"op":"replace","path":"/elements/intro/props/text","value":"Pick a free space to book or hold."}\n';
  api.script([
    (body) => {
      assert.match(body.system[0].text, /^You build and change a UI prototype in design-harness/);
      assert.match(body.system[0].text, /json-render specs/);
      assert.match(body.system[1].text, /^THE SPEC FORMAT\n/, "the catalog's instructions are the second system block");
      assert.match(body.system[1].text, /\nCOMPONENTS \(\d+\)\n/);
      assert.match(body.system[1].text, /- Button\.Root \{ aria-label\?: string, .*variant\?: "ghost" \| "primary" \| "secondary" \} children; on: press\./);
      assert.ok(body.system[1].text.length < 10000, `the catalog's instructions are ${body.system[1].text.length} characters, not json-render's 25,576`);
      assert.ok(body.tools.some((tool) => tool.name === "list_layouts") && body.tools.some((tool) => tool.name === "insert_layout"));
      assert.doesNotMatch(body.system[1].text, /Toast\.Root/, "Toast is not in the catalog yet");
      assert.ok(body.tools.some((tool) => tool.name === "patch_spec") && !body.tools.some((tool) => tool.name === "write_file"));
      return toolReply("badge", "patch_spec", { path: "pages/rooms.json", patches: '{"op":"add","path":"/elements/page/slots/intro/-","value":"free"}\n{"op":"add","path":"/elements/free","value":{"type":"Badge.Root","props":{"text":"Free"},"children":[]}}' }, "Adding a Free badge.");
    },
    (body) => {
      assert.match(lastMessage(body), /element "free" is a Badge\.Root, which is not in the catalog/, "core's refusal reaches the agent");
      return { ...toolReply("rename", "patch_spec", { path: "pages/rooms.json", patches: rename }, "Badge is not in the catalog; renaming the page instead."), delayMs: 500 };
    },
    (body) => {
      assert.match(lastMessage(body), /with every frame measured: pass\./);
      return textReply("The rooms page is now Spaces; every rule passes.");
    },
  ]);
  await enterKey(page);
  await ask(page, "Call the rooms page Spaces, with a Free badge");
  await page.getByTestId("spec-preview").waitFor({ timeout: 30000 });
  await shot(page, "spec-streaming-light");
  assert.equal(await turnEnded(page), "done");
  assert.equal(api.left(), 0);
  await page.getByTestId("spec-preview").waitFor({ state: "detached", timeout: 10000 });
  const reply = page.locator(".chat-reply").last();
  assert.deepEqual(await reply.locator(".chat-tool .chat-tool-name").allTextContents(), ["patch_spec: pages/rooms.json refused", "Patched pages/rooms.json"]);
  assert.deepEqual(await reply.locator(".chat-tool .chat-tool-title").allTextContents(), ["Could not change the rooms page", "Changed the rooms page"]);
  const last = await page.locator(".checks").getAttribute("data-revision");
  // The streamed drafts were drawn in place in the frames, not as revisions: the patch that applied is the only new one.
  assert.equal(last, "3");
  await measured(page, Number(last));
  assert.equal((await page.frameLocator('iframe[title="rooms-list at desktop"]').locator("h1").textContent()).trim(), "Spaces");
  assert.equal((await report(page)).status, "pass");
  assert.equal(await page.frameLocator('iframe[title="rooms-list at desktop"]').getByText("Free", { exact: true }).count(), 0, "the refused badge was never applied");
  assert.ok(logs.every((line) => !line.includes(KEY)), "the key is never logged");
  await shot(page, "spec-chat-light");
});

test("a spec Toast proposal: refused while its failing example does not fail", async ({ browser, base, api }) => {
  const { page } = await openSpec(browser, base);
  await draftByAgent(page, api, specToastDraft({ failing: 1 }));
  assert.match(await page.locator('.chat-proposal[data-proposal="booking-toast"]').textContent(), /refuses it: \[failing-example-passes\]/);
  await openReview(page, "booking-toast");
  await judged(page);
  assert.equal(await example(page, "one-toast").getAttribute("data-verdict"), "ok");
  assert.equal(await example(page, "only-one").getByTestId("example-detail").textContent(), 'failing example "only-one" is not flagged as it must be: "one-toast-per-page" passed it');
  const toast = example(page, "one-toast").frameLocator('iframe[title*="lantern-open at desktop"]').locator("text=Booked").first();
  await toast.waitFor({ state: "attached" });
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".review")?.getAttribute("data-status") === "approved");
  await page.waitForSelector('[data-testid="review-measuring"][data-measured]');
  await page.getByRole("button", { name: "Adopt", exact: true }).click();
  await page.getByTestId("review-refusal").waitFor();
  assert.equal(await page.getByTestId("review-refusal").getAttribute("data-code"), "failing-example-passes");
  assert.equal(await reviewStatus(page), "approved", "a refused adoption changes nothing");
});

test("a spec Toast proposal adopted when its examples behave: Toast joins the catalog, and the rule flags a fresh spec", async ({ browser, base, api }) => {
  const { page } = await openSpec(browser, base);
  await draftByAgent(page, api, specToastDraft());
  await openReview(page, "booking-toast");
  await judged(page);
  assert.equal(await example(page, "two-toasts").getAttribute("data-verdict"), "ok");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".review")?.getAttribute("data-status") === "approved");
  await page.waitForSelector('[data-testid="review-measuring"][data-measured]');
  await page.getByRole("button", { name: "Adopt", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".review")?.getAttribute("data-status") === "adopted");
  assert.match(await page.getByTestId("review-rechecked").textContent(), /Every prototype was re-checked: none newly fails\./);
  await shot(page, "spec-review-adopted-light");

  // The catalog is generated from the inventory, so the agent's next prompt lists Toast's parts.
  api.script([
    (body) => {
      assert.match(body.system[1].text, /- Toast\.Root \{ aria-label\?: string, id\?: string, text\?: string, tone\?: "critical" \| "info" \| "success" \| "warning" \}/);
      assert.doesNotMatch(body.system[1].text, /- Toast\.Region /, "a part a spec cannot render stays out");
      return textReply("Toast is in the catalog now.");
    },
  ]);
  await ask(page, "What can you use now?");
  assert.equal(await turnEnded(page), "done");

  // A fresh spec with two toasts: the catalog takes Toast.Root now, and the adopted rule flags it alone.
  await showAllRules(page);
  await page.waitForSelector('.checks[data-measured] .rule[data-rule="one-toast-per-page"][data-status="pass"]', { timeout: 60000, state: "attached" });
  const revision = Number(await page.locator(".checks").getAttribute("data-revision"));
  await editFile(page, "pages/booking.json", SPEC_TOASTS(2));
  await measured(page, revision + 1);
  const value = await report(page);
  assert.deepEqual(failing(value), ["one-toast-per-page"]);
  assert.match(value.findings[0].message, /^Page "booking" has 2 Toast.Root, more than 1: Toast.Root "Booked" at pages\/booking.json:\d+:5/);
});

// ---- layouts with parameters, the default format, migration ----------------

test("the Nook spec draws each layout instance with its own parameters, and passes every rule, the rendered ones included", async ({ browser, base }) => {
  const { page, errors } = await openSpec(browser, base);
  const value = await report(page);
  assert.equal(value.status, "pass", JSON.stringify(value.findings, null, 1));
  assert.equal(value.rules.length, 33);
  assert.ok(value.rules.every((rule) => rule.status === "pass"), "every rule runs and passes, the six rendered ones included");
  const open = page.frameLocator('iframe[title="lantern-open at desktop"]');
  // The question's id is scoped to its instance, and its label names it, so a screen reader hears the label.
  assert.equal(await open.locator("label").getAttribute("for"), "question/field");
  assert.equal(await open.getByRole("combobox", { name: "How long?" }).count(), 1);
  assert.equal((await open.locator("summary").textContent())?.trim(), "Room details", "the summary is the parameter's default");
  assert.deepEqual(await page.frameLocator('iframe[title="rooms-list at phone"]').getByRole("button").allTextContents(), ["Open Lantern", "Open Harbor"], "the room cards repeat over the list the page gives them");
  assert.deepEqual(errors, []);
});

test("a violation inside a layout instance is flagged and highlighted: the layout's element, the page's use, and the frame", async ({ browser, base }) => {
  const { page } = await openSpec(browser, base);
  // A primary action inside the room details layout: it breaks two rules, and each finding names both places.
  await editFile(page, "layouts/room-details.json", (text) => text.replace('"children": ["summary", "items"]', '"children": ["summary", "items", "go"]').replace('    "item":', '    "go": { "type": "Button.Root", "props": { "text": "Book room" }, "children": [] },\n    "item":'));
  await measured(page, 3);
  let value = await report(page);
  assert.deepEqual(failing(value), ["one-primary-per-page", "primary-outside-disclosure"]);
  const inside = value.findings.find((item) => item.rule === "primary-outside-disclosure");
  assert.deepEqual([inside.file, inside.line, inside.via], ["layouts/room-details.json", 11, [{ layout: "room-details", file: "pages/booking.json", line: 21, column: 5 }]]);
  assert.match(inside.message, /at layouts\/room-details\.json:11:5 \(in layout "room-details" used at pages\/booking\.json:21:5\)/);
  await showAllRules(page);
  const row = page.locator('.rule[data-rule="primary-outside-disclosure"] .finding').first();
  assert.match(await row.locator(".finding-place").textContent(), /layouts\/room-details\.json:11:5 · in room-details used at pages\/booking\.json:21/);
  assert.deepEqual(inside.targets, [{ file: "layouts/room-details.json", line: 11, column: 5, via: inside.via, page: "booking", key: "details/go" }]);
  await row.click();
  // Outlined in every frame of the booking page, by its key under the instance (or, where the disclosure hides it, around the disclosure).
  await outlinedInBookingFrames(page, 1);
  for (const scenario of BOOKING_SCENARIOS) {
    for (const view of VIEWS) {
      const [box] = await overlays(page, scenario, view);
      // In the frame's own coordinates: the action the layout draws, and the disclosure it is in.
      const { go, details } = await page.frameLocator(`iframe[title="${scenario} at ${view}"]`).locator("details", { hasText: "Room details" }).evaluate((element) => {
        const inner = [...element.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Book room");
        return { go: inner?.getBoundingClientRect().toJSON(), details: element.getBoundingClientRect().toJSON() };
      });
      const drawn = go && (go.width > 0 || go.height > 0) ? go : details;
      assert.ok(box && drawn && surrounds(box, drawn), `the layout's action, or the closed disclosure it is in, is outlined in ${scenario} at ${view}: ${JSON.stringify([box, go, details])}`);
    }
  }
  await shot(page, "layout-finding-outlined-light");
  await page.locator('.rule[data-rule="primary-outside-disclosure"]').getByRole("button", { name: "Show in code" }).first().click();
  await page.getByTestId("instance-places").waitFor();
  assert.equal(await page.locator('[data-testid="code-line"]').textContent(), "line 11, column 5");
  assert.match((await page.locator('.code-field [data-kind="finding"]').textContent()) ?? "", /"go": \{"type":"Button\.Root"|"go": \{ "type": "Button\.Root"/);
  await shot(page, "layout-finding-source-light");
  await page.getByTestId("instance-places").getByRole("button", { name: /Use of layout room-details: pages\/booking\.json:21/ }).click();
  assert.equal(await page.locator('.code-file select, #code-file select').first().inputValue(), "pages/booking.json");
  assert.match((await page.locator('.code-field [data-kind="finding"]').textContent()) ?? "", /"details": \{ "type": "Layout", "props": \{ "id": "room-details"/, "the page's use is the marked line");
  await shot(page, "layout-finding-use-light");

  // Back to legal, then a rendered violation inside the room cards layout: its heading skips a level, and is outlined in its frame.
  await editFile(page, "layouts/room-details.json", (text) => text.replace(', "go"]', "]").replace(/ {4}"go": .*\n/, ""));
  await measured(page, 4);
  assert.equal((await report(page)).status, "pass");
  await editFile(page, "layouts/room-cards.json", (text) => text.replace('"as": "h2"', '"as": "h3"'));
  await measured(page, 5);
  value = await report(page);
  assert.deepEqual(failing(value), ["heading-structure"]);
  await showAllRules(page);
  await page.locator('.rule[data-rule="heading-structure"] .finding').filter({ hasText: "scenario rooms-list" }).filter({ hasText: "view desktop" }).first().click();
  const frame = page.frameLocator('iframe[title="rooms-list at desktop"]');
  await frame.locator("[data-design-harness-overlay]").waitFor({ state: "attached" });
  const overlay = await frame.locator("[data-design-harness-overlay]").boundingBox();
  const target = await frame.locator("h3").first().boundingBox();
  assert.ok(overlay && target && overlay.x <= target.x && overlay.y <= target.y && overlay.x + overlay.width >= target.x + target.width, "the outline is drawn around the card's heading");
  await shot(page, "layout-finding-rendered-light");
});

test("a scripted agent lists the layouts, draws an instance of one, and changes its parameters", async ({ browser, base, api }) => {
  const { page } = await openSpec(browser, base);
  api.script([
    (body) => {
      assert.ok(["list_layouts", "insert_layout", "set_layout_params"].every((name) => body.tools.some((tool) => tool.name === name)));
      assert.match(body.system[1].text, /\nLAYOUTS\n/);
      return toolReply("list", "list_layouts", {}, "Reading the layouts.");
    },
    (body) => {
      const listed = JSON.parse(lastMessage(body));
      assert.deepEqual(listed.map((layout) => layout.id), ["room-cards", "room-details", "select-question"]);
      assert.equal(listed[0].params.rooms.is, 'a list of records of { "id": text, "name": text, "seats": number }');
      return toolReply("insert", "insert_layout", { path: "pages/rooms.json", into: { element: "page", slot: "body" }, key: "more", layout: "room-cards", params: { rooms: [{ id: "willow", name: "Willow", seats: 4 }] } }, "Drawing a second set of cards.");
    },
    (body) => {
      assert.match(lastMessage(body), /Drew an instance of layout "room-cards" as element "more" in pages\/rooms\.json\./);
      assert.match(lastMessage(body), /with every frame measured: pass\./);
      return toolReply("params", "set_layout_params", { path: "pages/rooms.json", key: "more", set: { rooms: [{ id: "willow", name: "Willow", seats: 4 }, { id: "birch", name: "Birch", seats: 8 }] } }, "Adding Birch.");
    },
    (body) => {
      assert.match(lastMessage(body), /Instance "more" in pages\/rooms\.json: set rooms\./);
      assert.match(lastMessage(body), /with every frame measured: pass\./);
      return textReply("The rooms page now shows Willow and Birch in a second set of cards; every rule passes.");
    },
  ]);
  await enterKey(page);
  await ask(page, "Show Willow and Birch too, in cards of their own");
  assert.equal(await turnEnded(page), "done");
  assert.equal(api.left(), 0);
  const reply = page.locator(".chat-reply").last();
  assert.deepEqual(await reply.locator(".chat-tool .chat-tool-name").allTextContents(), ["Listed 3 layouts", "Drew room-cards in pages/rooms.json", "Changed more's parameters in pages/rooms.json"]);
  const last = Number(await page.locator(".checks").getAttribute("data-revision"));
  await measured(page, last);
  assert.equal((await report(page)).status, "pass");
  assert.deepEqual(await page.frameLocator('iframe[title="rooms-list at desktop"]').getByRole("button").allTextContents(), ["Open Lantern", "Open Harbor", "Open Willow", "Open Birch"]);
  await shot(page, "layout-agent-light");
});

test("the Project view lists the spec prototype's layouts with their parameters and a rendered preview", async ({ browser, base }) => {
  const { page } = await openSpec(browser, base);
  await page.getByRole("tab", { name: "Project" }).click();
  const section = page.getByTestId("project-layouts");
  await section.waitFor();
  assert.deepEqual(await section.locator(".layout-card").evaluateAll((cards) => cards.map((card) => card.getAttribute("data-layout"))), ["room-cards", "room-details", "select-question"]);
  const question = section.locator('.layout-card[data-layout="select-question"]');
  assert.deepEqual(await question.locator("tr[data-param]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-param"))), ["answer", "choices", "hint", "label"]);
  assert.match(await question.locator('tr[data-param="label"]').textContent(), /text.*yes.*e\.g\. "How long\?"/);
  assert.match(await question.textContent(), /Drawn at pages\/booking\.json:20\./);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="layout-preview"] .frame-card')].length === 3 && [...document.querySelectorAll('[data-testid="layout-preview"] .frame-card')].every((card) => card.getAttribute("data-state") === "measured"), null, { timeout: 60000 });
  const preview = page.frameLocator('iframe[title="select-question preview: layout-preview at desktop"]');
  assert.equal(await preview.getByRole("combobox", { name: "How long?" }).count(), 1, "the preview draws the layout with its example values");
  assert.deepEqual(await page.frameLocator('iframe[title="room-cards preview: layout-preview at desktop"]').getByRole("button").allTextContents(), ["Open Lantern", "Open Harbor"]);
  await question.scrollIntoViewIfNeeded();
  await shot(page, "project-layouts-light");
});

test("a new prototype is a spec by default, and its agent writes specs", async ({ browser, base, api }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  await page.getByRole("button", { name: "New prototype" }).click();
  const dialog = page.getByRole("dialog", { name: "New prototype" });
  await dialog.waitFor();
  assert.equal(await dialog.getByRole("radio", { name: /^Spec, recommended/ }).isChecked(), true);
  assert.equal(await dialog.getByRole("radio", { name: /TSX/ }).isChecked(), false);
  // The dialog fades in; the picture waits for it.
  if (shots) await page.waitForTimeout(400);
  await shot(page, "new-prototype-light");
  await dialog.getByLabel("Name").fill("Checkout");
  await dialog.getByRole("button", { name: "Create" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("combobox", { name: "Prototype" }).inputValue(), "checkout");
  assert.equal((await page.getByTestId("prototype-format").textContent()).trim(), "Spec");
  api.script([
    (body) => {
      assert.match(body.system[0].text, /written as json-render specs/);
      assert.match(body.system[1].text, /^THE SPEC FORMAT/);
      const names = body.tools.map((tool) => tool.name);
      assert.ok(names.includes("write_spec") && names.includes("insert_layout") && !names.includes("write_file"), names.join(", "));
      return textReply("This prototype is empty; tell me what to build.");
    },
  ]);
  await enterKey(page);
  await ask(page, "What is here?");
  assert.equal(await turnEnded(page), "done");
  // It is stored like any prototype: after a reload it is still there, still a spec.
  await page.reload();
  await measured(page, 1);
  await page.getByRole("combobox", { name: "Prototype" }).selectOption("checkout");
  assert.equal((await page.getByTestId("prototype-format").textContent()).trim(), "Spec");
});

test("an existing TSX prototype still works: it passes, and its agent writes code", async ({ browser, base, api }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  assert.equal(await page.getByRole("combobox", { name: "Prototype" }).inputValue(), "booking");
  assert.equal((await page.getByTestId("prototype-format").textContent()).trim(), "TSX");
  assert.equal((await report(page)).status, "pass");
  api.script([
    (body) => {
      assert.equal(body.system.length, 1, "a TSX prototype's agent has one system block");
      assert.match(body.system[0].text, /The prototype is React in TSX/);
      const names = body.tools.map((tool) => tool.name);
      assert.ok(names.includes("write_file") && !names.includes("patch_spec") && !names.includes("insert_layout"), names.join(", "));
      return toolReply("rename", "edit_file", { path: "pages/rooms.tsx", old_text: '<Text.Root as="h1">Rooms</Text.Root>', new_text: '<Text.Root as="h1">Spaces</Text.Root>' }, "Renaming.");
    },
    (body) => {
      assert.match(lastMessage(body), /Checks for revision 2, with every frame measured: pass\./);
      return textReply("Done.");
    },
  ]);
  await enterKey(page);
  await ask(page, "Call the rooms page Spaces");
  assert.equal(await turnEnded(page), "done");
  assert.equal((await page.frameLocator('iframe[title="rooms-list at desktop"]').locator("h1").textContent()).trim(), "Spaces");
});

test("a stored project without a library description gets the bundled one on load, and says so", async ({ browser, base }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  // Make the stored project one from before spec prototypes: its config without library.parts.
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("design-harness");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("projects", "readwrite");
          const store = tx.objectStore("projects");
          const get = store.get("nook");
          get.onsuccess = () => {
            const row = get.result;
            delete row.config.library.parts;
            store.put(row);
          };
          tx.oncomplete = () => resolve(undefined);
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page.reload();
  await page.getByTestId("notice").waitFor();
  assert.match(await page.getByTestId("notice").textContent(), /The project was brought up to date.*added the one it ships for @tounsoo\/todae 0\.11\.3 \(203 parts\)/);
  await measured(page, 1);
  await page.getByRole("combobox", { name: "Prototype" }).selectOption("booking-spec");
  await measured(page, 2);
  assert.equal((await report(page)).status, "pass", "the spec prototype is checked with the description the app added");
});

// ---- the workspace's layout: canvas only, panels, the checks in plain words ----

/** Whether the element a locator finds is focused. */
async function focused(locator) {
  return locator.evaluate((element) => element === element.ownerDocument.activeElement);
}

test("canvas only hides the header and both panels, and its button, shortcut and Escape bring them back with focus kept", async ({ browser, base }) => {
  const { page, errors, context } = await openApp(browser, base);
  await measured(page, 1);
  const toggle = page.getByRole("button", { name: /^Canvas only/ });
  assert.equal(await toggle.getAttribute("aria-keyshortcuts"), "Control+. Meta+.");
  const before = await page.locator(".board-area").evaluate((element) => element.clientWidth);

  await toggle.click();
  await page.locator(".shell[data-canvas-only]").waitFor();
  for (const hidden of [page.locator(".shell-header"), page.getByRole("complementary", { name: "Agent chat" }), page.getByRole("complementary", { name: "Checks and code" })]) assert.equal(await hidden.isVisible(), false, "the header and both panels step aside");
  const exit = page.getByRole("button", { name: "Show panels" });
  await becomesFocused(page, exit, "focus moves to the way back");
  assert.equal(await exit.getAttribute("aria-keyshortcuts"), "Escape");
  const bar = page.getByRole("toolbar", { name: "Canvas" });
  assert.match(await bar.textContent(), /^Booking.*Fit \(\d+%\).*Follows the rules.*Show panels/);
  assert.equal(await page.getByRole("combobox", { name: "Zoom" }).isVisible(), true, "zoom stays");
  await eventually(page, () => page.locator(".board-area").evaluate((element) => element.clientWidth), (wider) => wider > before + 400, `the canvas takes the room from ${before}`);
  assert.deepEqual(await page.locator(".frame-card").evaluateAll((cards) => cards.map((card) => card.dataset.state)), Array(8).fill("measured"), "the frames stay rendered");
  await shot(page, "canvas-only-light");
  await shotDark(page, "canvas-only-dark");

  await page.keyboard.press("Escape");
  await page.locator(".shell:not([data-canvas-only])").waitFor();
  assert.equal(await page.locator(".shell-header").isVisible(), true);
  await becomesFocused(page, toggle, "focus goes back to the toggle");
  await eventually(page, () => toggle.getAttribute("aria-pressed"), (value) => value === "false", "the toggle is no longer pressed");

  await page.keyboard.press("Control+.");
  await page.locator(".shell[data-canvas-only]").waitFor();
  await becomesFocused(page, exit, "the shortcut moves focus to the way back");
  await page.keyboard.press("Control+.");
  await page.locator(".shell:not([data-canvas-only])").waitFor();
  await page.keyboard.press("Control+.");
  await exit.click();
  await page.locator(".shell:not([data-canvas-only])").waitFor();
  await becomesFocused(page, toggle, "Show panels moves focus back to the toggle");
  assert.deepEqual(errors, []);
  await context.close();
});

test("the chat and the checks panels collapse and come back, and keep their state and width across a reload", async ({ browser, base }) => {
  const { page, context } = await openApp(browser, base);
  await measured(page, 1);
  const chat = page.getByRole("complementary", { name: "Agent chat" });
  const side = page.getByRole("complementary", { name: "Checks and code" });
  const chatToggle = page.getByRole("button", { name: /^Chat \(/ });
  const sideToggle = page.getByRole("button", { name: /^Checks and code \(/ });
  assert.deepEqual([await chatToggle.getAttribute("aria-expanded"), await sideToggle.getAttribute("aria-expanded")], ["true", "true"]);
  assert.equal(await sideToggle.getAttribute("aria-keyshortcuts"), "Control+Alt+B Meta+Alt+B");

  await sideToggle.click();
  await side.waitFor({ state: "hidden" });
  await eventually(page, () => sideToggle.getAttribute("aria-expanded"), (value) => value === "false", "the checks toggle says the panel is closed");
  await shot(page, "side-collapsed-light");
  await shotDark(page, "side-collapsed-dark");
  await page.keyboard.press("Control+B");
  await chat.waitFor({ state: "hidden" });
  await eventually(page, () => chatToggle.getAttribute("aria-expanded"), (value) => value === "false", "the chat toggle says the panel is closed");
  await eventually(page, async () => JSON.parse(await page.evaluate(() => localStorage.getItem("design-harness.panels"))), (stored) => stored?.chat.open === false && stored?.side.open === false, "both panels are stored as closed");

  await page.reload();
  await measured(page, 1);
  assert.equal(await chat.isVisible(), false, "the chat stays closed after a reload");
  assert.equal(await side.isVisible(), false, "the checks stay closed after a reload");
  assert.equal(await (await page.getByTestId("report-status")).textContent(), "pass", "a closed panel still holds core's report");

  await page.keyboard.press("Control+Alt+B");
  await side.waitFor();
  await chatToggle.click();
  await chat.waitFor();
  // The handle resizes with the keys: each arrow moves it 16px.
  const handle = page.getByRole("separator", { name: "Resize the chat" });
  const width = Number(await handle.getAttribute("aria-valuenow"));
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await eventually(page, async () => Number(await handle.getAttribute("aria-valuenow")), (value) => value === width + 32, `the chat widens from ${width} by 32 px`);
  await page.getByRole("button", { name: "Hide checks and code" }).click();
  await side.waitFor({ state: "hidden" });
  await page.reload();
  await measured(page, 1);
  assert.equal(Number(await page.getByRole("separator", { name: "Resize the chat" }).getAttribute("aria-valuenow")), width + 32, "the chat keeps its width");
  assert.equal(await chat.isVisible(), true);
  assert.equal(await side.isVisible(), false);
  await page.getByRole("button", { name: "Hide the chat" }).click();
  await chat.waitFor({ state: "hidden" });

  await context.close();

  // Storage that throws leaves the panels working for the visit.
  const blocked = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await blocked.addInitScript(() => Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } }));
  const other = await blocked.newPage();
  const errors = [];
  other.on("pageerror", (error) => errors.push(error.message));
  await other.goto(base);
  await measured(other, 1);
  await other.getByRole("button", { name: /^Checks and code \(/ }).click();
  await other.getByRole("complementary", { name: "Checks and code" }).waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  await blocked.close();
});

test("the checks lead with plain words: a summary, each thing to fix with core's message beside it, Show me, and the detail one step away", async ({ browser, base }) => {
  const { page, context } = await openApp(browser, base);
  await measured(page, 1);
  assert.equal(await page.getByTestId("checks-headline").textContent(), "Everything follows the project's rules");
  assert.equal(await page.locator(".fix").count(), 0);
  assert.equal(await page.getByTestId("checks-details").evaluate((element) => element.open), false, "the rule list sits behind Details");

  const edited = await editFile(page, "pages/booking.tsx", (text) => UNDERSIZED(SECOND_PRIMARY(text)));
  await measured(page, 2);
  const value = await report(page);
  await page.getByRole("tab", { name: /Checks/ }).click();
  assert.equal(await page.getByTestId("checks-headline").textContent(), `${failing(value).length} things to fix`);
  assert.deepEqual(await page.locator(".fix").evaluateAll((items) => items.map((item) => item.dataset.rule)), failing(value), "one thing to fix per failing rule, in core's order");

  const primary = page.locator('.fix[data-rule="one-primary-per-page"]');
  const finding = value.findings.find((item) => item.rule === "one-primary-per-page");
  assert.equal(await primary.getByTestId("fix-lead").textContent(), "A page holds at most one primary action.", "the rule's plain words lead");
  assert.equal(await primary.getByTestId("fix-message").textContent(), finding.message, "core's message stays beside them, word for word");
  const details = primary.locator(".fix-details");
  assert.equal(await details.evaluate((element) => element.open), false);
  assert.match(await details.textContent(), /Ruleone-primary-per-page \(count\)/, "the rule's id and type are in its details");
  // Show me outlines both primary actions in every frame that draws them, and the card says where.
  await primary.getByRole("button", { name: "Show me" }).click();
  await page.frameLocator('iframe[title="lantern-open at desktop"]').locator("[data-design-harness-overlay]").first().waitFor({ state: "attached" });
  await eventually(page, () => primary.getByTestId("fix-outline").textContent(), (text) => text === "Outlined in 6 frames: Booking, room open (Lantern open); Booking, booked (Lantern booked); Booking, held (Lantern held).", "the card says where both actions are outlined");
  await eventually(page, () => page.locator(".frame-card[data-selected]").count(), (count) => count === 6, "the six frames that draw them are selected");
  // Show in code, one click away, marks the line.
  await primary.getByTestId("show-in-code").click();
  await page.waitForSelector('[data-testid="code-line"]');
  await eventually(page, () => page.locator('[data-testid="code-line"]').textContent(), (text) => text === `line ${finding.line}, column ${finding.column}`, "the code view names the finding's line");
  await eventually(page, async () => (await page.locator('.code-field [data-kind="finding"]').textContent()) ?? "", (text) => text === edited.split("\n")[finding.line - 1], "Show in code marks the line");

  await page.getByRole("tab", { name: /Checks/ }).click();
  const target = page.locator('.fix[data-rule="target-size"]');
  assert.equal(await target.getByTestId("fix-lead").textContent(), "Every control meets 24 px or the WCAG 2.5.8 spacing exception.", "a cap reads as its value");
  await target.getByRole("button", { name: "Show Lantern open — desktop" }).click();
  const frame = page.frameLocator('iframe[title="lantern-open at desktop"]');
  // The two outlines Show me drew for the primary actions give way to this one finding's outline.
  const overlays = frame.locator("[data-design-harness-overlay]");
  for (let tries = 0; (await overlays.count()) !== 1; tries += 1) {
    assert.ok(tries < 100, `the frame should end with one outline, not ${await overlays.count()}`);
    await page.waitForTimeout(50);
  }
  await eventually(page, () => page.locator('.frame-card[data-frame-key="lantern-open@desktop"]').getAttribute("data-selected"), (value) => value === "", "the frame shown is selected");
  const shown = value.findings.find((item) => item.rule === "target-size" && item.scenario === "lantern-open" && item.view === "desktop");
  await eventually(page, () => target.getByTestId("fix-message").textContent(), (text) => text === shown.message, "the message is the one of the place shown");
  await eventually(page, () => target.getByRole("button", { name: "Show me" }).getAttribute("aria-pressed"), (value) => value === "true", "Show me is pressed while its finding is shown");
  await shot(page, "checks-plain-light");
  await shotDark(page, "checks-plain-dark");

  await primary.getByRole("button", { name: "Ask the agent to fix" }).click();
  const box = page.getByRole("textbox", { name: "Message the agent" });
  // The chat box is filled a tick after the press.
  const asked = await eventually(page, () => box.inputValue(), (text) => text !== "", "the chat box is filled with a message asking for the fix");
  assert.match(asked, /^Please fix this so the prototype follows the project's rules\.\n\nThe check "one-primary-per-page" says: Page "booking" has 2 primary actions/);
  await becomesFocused(page, page.getByLabel("Your Anthropic API key"), "without a key, the key comes first");

  await showAllRules(page);
  assert.equal(await page.getByTestId("report-status").textContent(), "fail");
  assert.equal(await page.locator('.rule[data-rule="one-primary-per-page"] .finding .finding-message').first().textContent(), finding.message);
  await context.close();
});

// ---- variants and code export ----------------------------------------------

const BOOKING_SPEC = JSON.parse(SPEC_BOOKING);
const copy = (value) => JSON.parse(JSON.stringify(value));

/** Three whole booking pages: A asks "For how long?", B leads its facts with the floor, C makes Hold room primary too, which breaks one-primary-per-page. */
function threeVariants() {
  const asks = copy(BOOKING_SPEC);
  asks.elements.question.props.label = "For how long?";
  const floor = copy(BOOKING_SPEC);
  floor.elements.seats.props.text = { $template: "${/room/floor}, ${/room/seats} seats" };
  const twoPrimaries = copy(BOOKING_SPEC);
  twoPrimaries.elements.hold.props.variant = "primary";
  return [
    { note: "Asks for how long", spec: asks },
    { note: "Leads with the floor", spec: floor },
    { note: "Both actions primary", spec: twoPrimaries },
  ];
}

/** The agent, scripted, offers the three variants of the booking page. */
async function offerVariants(page, api) {
  api.script([
    (body) => {
      assert.ok(["propose_variants", "revise_variant", "list_variants"].every((name) => body.tools.some((tool) => tool.name === name)), "the spec agent has the variant tools");
      assert.equal(body.tools.some((tool) => /pick|apply/.test(tool.name)), false, "and none that picks");
      return toolReply("variants", "propose_variants", { page: "booking", variants: threeVariants() }, "Three ways the booking page could go.");
    },
    (body) => {
      assert.match(lastMessage(body), /Kept 3 variants of page "booking" beside the prototype, which is unchanged/);
      assert.match(lastMessage(body), /Variant C \(id "c"\): Both actions primary\. Core fails one-primary-per-page/);
      return textReply("Three variants are on the Variants tab: A asks for how long, B leads with the floor, C makes both actions primary.");
    },
  ]);
  await enterKey(page);
  await ask(page, "Give me three variants of the booking page");
  assert.equal(await turnEnded(page), "done");
  assert.equal(api.left(), 0);
}

/** Waits until a variant's card has core's verdict on its measured frames, and returns it. */
async function standing(page, id, expected) {
  const card = page.locator(`.variant-card[data-variant="${id}"]`);
  await page.waitForFunction(([selector, wanted]) => document.querySelector(selector)?.getAttribute("data-standing") === wanted, [`.variant-card[data-variant="${id}"]`, expected], { timeout: 90000 });
  return card;
}

const pickRadio = (page, slot, label) => page.locator(`[data-testid="variants-picks"] tr[data-slot="${slot}"]`).getByRole("radio", { name: label, exact: true });

test("a scripted agent offers three variants: side by side in measured frames, each with core's report; the failing one cannot be picked until the agent fixes it", async ({ browser, base, api }) => {
  const { page, errors } = await openSpec(browser, base);
  const before = await report(page);
  await offerVariants(page, api);
  assert.equal(await page.locator(".chat-variants").getAttribute("data-variants"), "a b c");
  assert.equal(await page.getByTestId("variant-count").textContent(), "3");
  assert.equal(await page.locator(".checks").getAttribute("data-revision"), "2", "offering variants changes no revision");
  await page.getByRole("button", { name: "Compare variants" }).click();
  await standing(page, "current", "pass");
  await standing(page, "a", "pass");
  await standing(page, "b", "pass");
  const failing = await standing(page, "c", "fail");
  assert.deepEqual(await page.locator(".variant-card").evaluateAll((cards) => cards.map((card) => card.dataset.variant)), ["current", "a", "b", "c"], "the page as it is, then each variant, side by side");
  // Every scenario and view is measured; the scenario picked is shown.
  for (const id of ["a", "b", "c"]) {
    const frames = page.locator(`.variant-card[data-variant="${id}"] .frame-card`);
    assert.equal(await frames.count(), 8, `${id}: 4 scenarios × 2 views, measured`);
    assert.deepEqual(await frames.evaluateAll((cards) => cards.filter((card) => !card.hasAttribute("data-hidden")).map((card) => card.dataset.frameKey)), ["lantern-open@desktop", "lantern-open@phone"]);
    assert.equal(await page.locator(`.variant-card[data-variant="${id}"] .frame-card[data-state="measured"]`).count(), 8);
  }
  // Every view of a source side by side, as the board lays a scenario out.
  const [desktop, phone] = await Promise.all(VIEWS.map((view) => page.locator(`.variant-card[data-variant="a"] .frame-card[data-frame-key="lantern-open@${view}"]`).boundingBox()));
  assert.ok(desktop.x + desktop.width <= phone.x && Math.abs(desktop.y - phone.y) < 2, `the phone view sits beside the desktop view: ${JSON.stringify([desktop, phone])}`);
  const askFrame = page.frameLocator('iframe[title="Variant A: lantern-open at desktop"]');
  assert.equal((await askFrame.locator("label").first().textContent()).trim(), "For how long?");
  assert.equal((await page.frameLocator('iframe[title="Current: lantern-open at desktop"]').locator("label").first().textContent()).trim(), "How long?");
  // C fails in core's words, and its report is core's whole report, measured.
  const message = (await failing.locator('[data-rule="one-primary-per-page"] [data-testid="variant-finding"]').first().textContent()).trim();
  assert.match(message, /^Page "booking" has 2 primary actions, more than 1/);
  assert.match(await page.locator('.variant-card[data-variant="a"] [data-testid="variant-report"]').textContent(), /Every rule passes: 33 rules, the rendered ones measured\./);
  // C cannot be picked in any slot, nor whole.
  for (const slot of ["title", "facts", "body", "alternate", "action"]) assert.equal(await pickRadio(page, slot, "Variant C").isDisabled(), true, `${slot}: C cannot be picked`);
  assert.equal(await pickRadio(page, "body", "Variant A").isDisabled(), false);
  assert.equal(await page.getByRole("button", { name: "Every slot from Variant C" }).isDisabled(), true);
  await shot(page, "variants-light");
  await shotDark(page, "variants-dark");

  // Asked to fix it, the agent revises C; once it passes it can be picked.
  const fixed = copy(BOOKING_SPEC);
  fixed.elements.hold.props.text = "Hold room";
  fixed.elements.book.props.text = "Book room";
  fixed.elements.name.props.as = "h1";
  fixed.state.room.floor = "Second floor, by the stairs";
  api.script([
    (body) => {
      const text = lastMessage(body);
      assert.match(text, /Variant C of page "booking" fails core's checks:\n- one-primary-per-page: Page "booking" has 2 primary actions/);
      assert.match(text, /Fix it with revise_variant, keeping its id "c"/);
      return toolReply("fix", "revise_variant", { id: "c", spec: fixed, note: "Hold room secondary again; the floor says where" }, "Fixing C.");
    },
    (body) => {
      assert.match(lastMessage(body), /Revised Variant C of page "booking"\. Core passes every rule core checks without frames/);
      return textReply("C passes now.");
    },
  ]);
  await failing.getByRole("button", { name: "Ask the agent to fix it" }).click();
  assert.equal(await turnEnded(page), "done");
  assert.equal(api.left(), 0);
  await standing(page, "c", "pass");
  assert.equal(await page.locator('.variant-card[data-variant="c"] [data-testid="variant-note"]').textContent(), "Hold room secondary again; the floor says where");
  assert.equal(await pickRadio(page, "facts", "Variant C").isDisabled(), false);
  assert.deepEqual(await report(page), before, "the prototype's own report never changed");
  assert.deepEqual(errors, []);
});

test("picking slots from two variants applies a new revision that passes every rule, and undo restores the previous one", async ({ browser, base, api }) => {
  const { page } = await openSpec(browser, base);
  await showCode(page, "pages/booking.json");
  const original = await page.locator('[data-testid="code-editor"]').inputValue();
  await offerVariants(page, api);
  await page.getByRole("tab", { name: /Variants/ }).click();
  await standing(page, "a", "pass");
  await standing(page, "b", "pass");
  assert.equal(await page.getByTestId("apply-pick").isDisabled(), true);
  assert.equal(await page.getByTestId("apply-why").textContent(), "Pick at least one slot from a variant.");
  await pickRadio(page, "body", "Variant A").check();
  await pickRadio(page, "facts", "Variant B").check();
  const combination = page.getByTestId("variant-combination");
  await combination.waitFor();
  assert.match(await combination.textContent(), /title from Current, facts from Variant B, body from Variant A, alternate from Current, action from Current\./);
  await page.waitForFunction(() => document.querySelector('[data-testid="variant-combination"]')?.getAttribute("data-standing") === "pass", null, { timeout: 90000 });
  const frame = page.frameLocator('iframe[title="The combination: lantern-open at desktop"]');
  assert.equal((await frame.locator("label").first().textContent()).trim(), "For how long?");
  assert.equal(await frame.locator("text=Second floor, 6 seats").count(), 1);
  await shot(page, "variants-pick-light");
  await shotDark(page, "variants-pick-dark");
  await page.getByTestId("apply-pick").click();
  await measured(page, 3);
  const after = await report(page);
  assert.equal(after.status, "pass", JSON.stringify(after.findings, null, 1));
  assert.deepEqual(after.findings, []);
  await page.getByRole("tab", { name: "Canvas" }).click();
  const board = page.frameLocator('iframe[title="lantern-open at desktop"]');
  await eventually(page, async () => (await board.locator("label").first().textContent()).trim(), (text) => text === "For how long?", "the board draws the pick");
  await eventually(page, () => board.locator("text=Second floor, 6 seats").count(), (count) => count === 1, "the board draws B's facts");
  await showCode(page, "pages/booking.json");
  const picked = await page.locator('[data-testid="code-editor"]').inputValue();
  assert.notEqual(picked, original);
  // Recorded with which variant supplied which slot, and kept through a reload.
  await page.reload();
  await measured(page, 1);
  await page.getByRole("combobox", { name: "Prototype" }).selectOption("booking-spec");
  await measured(page, 2);
  await page.getByRole("tab", { name: /Variants/ }).click();
  const history = page.getByTestId("pick-history");
  await history.waitFor();
  assert.match(await history.textContent(), /title from Current, facts from Variant B, body from Variant A, alternate from Current, action from Current/);
  assert.match(await history.textContent(), /Variant A: Asks for how long · Variant B: Leads with the floor/);
  await page.getByTestId("undo-pick").click();
  await measured(page, 3);
  assert.equal((await report(page)).status, "pass");
  await showCode(page, "pages/booking.json");
  assert.equal(await page.locator('[data-testid="code-editor"]').inputValue(), original, "undo restores the page as it was");
  await page.getByRole("tab", { name: /Variants/ }).click();
  assert.match(await page.getByTestId("pick-history").textContent(), /\(undone\)/);
  assert.equal(await page.getByTestId("undo-pick").count(), 0);
});

test("a pick answers for its own page: with the rooms page already failing, a passing pick on the booking page applies, and a failing variant still cannot be picked", async ({ browser, base, api }) => {
  const { page } = await openSpec(browser, base);
  // The rooms page breaks a rule of its own: a primary action on a collection (core's own illegal fixture).
  const failingRooms = readFileSync(join(root, "..", "..", "packages", "core", "examples", "nook", "prototypes", "spec", "illegal", "primary-on-collection", "files", "pages", "rooms.json"), "utf8");
  await editFile(page, "pages/rooms.json", () => failingRooms);
  await measured(page, 3);
  const before = await report(page);
  assert.equal(before.status, "fail");
  assert.ok(before.findings.length > 0 && before.findings.every((finding) => finding.page === "rooms"), `only the rooms page fails: ${JSON.stringify(before.findings)}`);
  await showAllRules(page);
  assert.match(await page.getByTestId("checks-headline").textContent(), /to fix/);

  await offerVariants(page, api);
  await page.getByRole("tab", { name: /Variants/ }).click();
  // The page as it is and the variants that are clean on the booking page stand as passing, though the prototype does not pass.
  const current = await standing(page, "current", "pass");
  const a = await standing(page, "a", "pass");
  await standing(page, "b", "pass");
  const c = await standing(page, "c", "fail");
  assert.match(await a.textContent(), /this page follows the rules/);
  assert.match(await a.getByTestId("variant-report").textContent(), /Nothing to fix on this page\./);
  // The other page's failure is shown, in core's words, as not part of the pick.
  await a.getByTestId("variant-elsewhere").locator("summary").click();
  assert.match(await a.getByTestId("variant-elsewhere").textContent(), /Already on another page: \d+ things? to fix, not part of this pick/);
  assert.match(await a.getByTestId("variant-elsewhere").textContent(), /Page "rooms" has 1 primary action, more than 0/);
  assert.match(await current.textContent(), /this page follows the rules/);
  // C breaks a rule on the booking page itself: its own findings block it, and the rooms page's are not among them.
  assert.deepEqual(await c.locator('.variant-issue').evaluateAll((items) => [...new Set(items.map((item) => item.dataset.scope))]), ["page"]);
  assert.match((await c.locator('[data-rule="one-primary-per-page"] [data-testid="variant-finding"]').first().textContent()).trim(), /^Page "booking" has 2 primary actions, more than 1/);
  assert.equal(await c.locator('.variant-issue [data-testid="variant-finding"]').evaluateAll((items) => items.some((item) => item.textContent.includes('"rooms"'))), false);
  for (const slot of ["title", "facts", "body", "alternate", "action"]) assert.equal(await pickRadio(page, slot, "Variant C").isDisabled(), true, `${slot}: C cannot be picked`);
  assert.equal(await pickRadio(page, "body", "Variant A").isDisabled(), false, "A can be picked while another page fails");

  await pickRadio(page, "body", "Variant A").check();
  await pickRadio(page, "facts", "Variant B").check();
  await page.waitForFunction(() => document.querySelector('[data-testid="variant-combination"]')?.getAttribute("data-standing") === "pass", null, { timeout: 90000 });
  assert.equal(await page.getByTestId("apply-pick").isDisabled(), false, "the pick can be applied");
  assert.equal(await page.getByTestId("apply-why").count(), 0);
  assert.match(await page.getByTestId("apply-note").textContent(), /This page follows the rules\. \d+ things? to fix on another page stays? as (it is|they are)\./);
  await shot(page, "variants-scoped-light");
  await page.getByTestId("apply-pick").click();
  await measured(page, 4);
  await eventually(page, () => page.getByTestId("notice").textContent(), (text) => /Pick applied/.test(text ?? ""), "the notice says the pick was applied");
  // The pick is the new revision: the booking page changed, and the rooms page fails exactly as it did.
  const after = await report(page);
  assert.deepEqual(after.findings, before.findings, "the same findings as before the pick, all on the rooms page");
  await page.getByRole("tab", { name: "Canvas" }).click();
  const board = page.frameLocator('iframe[title="lantern-open at desktop"]');
  await eventually(page, async () => (await board.locator("label").first().textContent()).trim(), (text) => text === "For how long?", "the board draws the pick");
  await eventually(page, () => board.locator("text=Second floor, 6 seats").count(), (count) => count === 1, "the board draws B's facts");
});

test("more like this reaches the agent, naming the variant, and its new variants say whose they are like", async ({ browser, base, api }) => {
  const { page } = await openSpec(browser, base);
  await offerVariants(page, api);
  await page.getByRole("tab", { name: /Variants/ }).click();
  const b = await standing(page, "b", "pass");
  const more = threeVariants().slice(0, 2).map((variant, index) => ({ note: `Floor first, take ${index + 1}`, spec: { ...variant.spec, state: { ...variant.spec.state, duration: "60" } } }));
  api.script([
    (body) => {
      const text = lastMessage(body);
      assert.match(text, /^More variants like Variant B \("Leads with the floor"\) of page "booking": and make the seats stand out\nOffer them with propose_variants, with like: "b"\.$/);
      return toolReply("more", "propose_variants", { page: "booking", variants: more, like: "b" }, "Two more like B.");
    },
    () => textReply("D and E lead with the floor, like B."),
  ]);
  await b.getByRole("button", { name: "More like this" }).click();
  await b.getByLabel("What more of it, or what else?").fill("and make the seats stand out");
  await b.getByRole("button", { name: "Ask for more like this" }).click();
  assert.equal(await turnEnded(page), "done");
  assert.equal(api.left(), 0);
  await page.locator('.variant-card[data-variant="e"]').waitFor();
  assert.equal(await page.locator('.variant-card[data-variant="d"] [data-testid="variant-note"]').textContent(), "Floor first, take 1 (like Variant B)");
  assert.equal(await page.getByTestId("variant-count").textContent(), "5");
  // Variants travel with the prototype in the project file.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export", exact: true }).click()]);
  const file = JSON.parse(readFileSync(await download.path(), "utf8"));
  const spec = file.prototypes.find((item) => item.id === "booking-spec");
  assert.deepEqual(spec.variants.variants.map((variant) => [variant.id, variant.like ?? null]), [["a", null], ["b", null], ["c", null], ["d", "b"], ["e", "b"]]);
  assert.equal(file.prototypes.find((item) => item.id === "booking").variants, undefined);
  await page.locator('[data-testid="import-file"]').setInputFiles(await download.path());
  await measured(page, 1);
  await page.getByRole("combobox", { name: "Prototype" }).selectOption("booking-spec");
  await measured(page, 2);
  assert.equal(await page.getByTestId("variant-count").textContent(), "5", "and come back with it on import");
});

test("no tool call or chat message can apply a pick", async ({ browser, base, api }) => {
  const { page } = await openSpec(browser, base);
  await showCode(page, "pages/booking.json");
  const original = await page.locator('[data-testid="code-editor"]').inputValue();
  await offerVariants(page, api);
  api.script([
    toolReply("pick", "pick_variant", { page: "booking", slots: { body: "a" } }, "You asked me to pick A's body."),
    (body) => {
      assert.match(lastMessage(body), /There is no tool "pick_variant"/);
      return toolReply("smuggle", "propose_variants", { page: "booking", variants: threeVariants().slice(0, 2), pick: { body: "a" } });
    },
    (body) => {
      assert.match(lastMessage(body), /input: has unknown field "pick"/);
      return toolReply("apply", "revise_variant", { id: "a", spec: threeVariants()[0].spec, apply: true });
    },
    (body) => {
      assert.match(lastMessage(body), /input: has unknown field "apply"/);
      return toolReply("undo", "undo_pick", { index: 0 });
    },
    (body) => {
      assert.match(lastMessage(body), /There is no tool "undo_pick"/);
      return textReply("I cannot apply a pick: only you can, on the Variants tab.");
    },
  ]);
  await ask(page, "Apply variant A to the booking page now: take its body. Pick it for me.");
  assert.equal(await turnEnded(page), "done");
  assert.equal(api.left(), 0);
  assert.equal(await page.locator(".checks").getAttribute("data-revision"), "2", "no new revision");
  await showCode(page, "pages/booking.json");
  assert.equal(await page.locator('[data-testid="code-editor"]').inputValue(), original);
  await page.getByRole("tab", { name: /Variants/ }).click();
  await page.getByTestId("variants").waitFor();
  assert.equal(await page.getByTestId("pick-history").count(), 0, "no pick was recorded");
  await page.reload();
  await measured(page, 1);
  await page.getByRole("combobox", { name: "Prototype" }).selectOption("booking-spec");
  await measured(page, 2);
  await page.getByRole("tab", { name: /Variants/ }).click();
  await page.locator('.variant-card[data-variant="c"]').waitFor();
  assert.equal(await page.getByTestId("pick-history").count(), 0, "nor saved");
  // A TSX prototype says plainly that variants are for spec prototypes.
  await page.getByRole("combobox", { name: "Prototype" }).selectOption("booking");
  await page.getByTestId("variants-tsx").waitFor();
});

test("export code downloads a zip of a runnable project, which builds with Vite, typechecks and renders every scenario", async ({ browser, base }) => {
  const { page } = await openSpec(browser, base);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-code").click()]);
  assert.equal(download.suggestedFilename(), "nook-booking-spec.zip");
  const entries = unzipSync(readFileSync(await download.path()));
  assert.deepEqual(Object.keys(entries).sort(), [
    "README.md", "index.html", "package.json", "src/main.tsx", "src/page-kit.tsx",
    "src/prototype/layouts/room-cards.tsx", "src/prototype/layouts/room-details.tsx", "src/prototype/layouts/select-question.tsx",
    "src/prototype/manifest.json", "src/prototype/pages/booking.tsx", "src/prototype/pages/rooms.tsx",
    "src/scenarios.ts", "src/shell.css", "tsconfig.json", "vite.config.ts",
  ].map((path) => `nook-booking-spec/${path}`));
  const readme = strFromU8(entries["nook-booking-spec/README.md"]);
  assert.match(readme, /^# Booking \(spec\)\n\nExported from design-harness on \d{4}-\d\d-\d\dT[\d:.]+Z: prototype "Booking \(spec\)" of project "Nook"/);
  assert.match(readme, /Core's checks at export: pass: every rule passes\./);
  assert.deepEqual(JSON.parse(strFromU8(entries["nook-booking-spec/package.json"])).dependencies, { "@tounsoo/todae": "0.11.3", react: "19.3.1", "react-dom": "19.3.1" });

  // Build it with Vite and typecheck it, offline: its packages are this repository's node_modules.
  const dir = mkdtempSync(join(tmpdir(), "design-harness-export-"));
  for (const [path, bytes] of Object.entries(entries)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  const project = join(dir, "nook-booking-spec");
  symlinkSync(join(root, "..", "..", "node_modules"), join(project, "node_modules"), "dir");
  await viteBuild({ root: project, configFile: join(project, "vite.config.ts"), logLevel: "silent" });
  assert.ok(existsSync(join(project, "dist", "index.html")));
  const tsc = spawnSync(process.execPath, [join(root, "..", "..", "node_modules", "typescript", "bin", "tsc"), "-p", project], { encoding: "utf8" });
  assert.equal(tsc.status, 0, `the export typechecks:\n${tsc.stdout}${tsc.stderr}`);

  // Render it in Chromium: each scenario, picked in its switcher.
  const server = await preview({ root: project, configFile: join(project, "vite.config.ts"), logLevel: "silent", preview: { port: 0, host: "127.0.0.1" } });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const app = await context.newPage();
  const errors = [];
  app.on("pageerror", (error) => errors.push(error.message));
  app.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  await app.goto(`${url}?scenario=lantern-open`);
  assert.equal((await app.locator("h1").textContent()).trim(), "Lantern");
  assert.equal(await app.getByRole("button", { name: "Book room" }).count(), 1);
  assert.equal(await app.getByLabel("How long?").count(), 1, "the label names its field");
  await app.getByLabel("How long?").selectOption("60");
  assert.equal(await app.getByLabel("How long?").inputValue(), "60", "the bound answer changes");
  await app.getByRole("combobox", { name: "Scenario" }).selectOption("lantern-booked");
  assert.equal(await app.locator("text=Booked until 3 pm").count(), 1);
  await app.getByRole("combobox", { name: "Scenario" }).selectOption("rooms-list");
  assert.equal((await app.locator("h1").textContent()).trim(), "Rooms");
  assert.deepEqual(await app.getByRole("button").allTextContents(), ["Open Lantern", "Open Harbor"]);
  await app.getByRole("combobox", { name: "Scenario" }).selectOption("lantern-open");
  const details = app.locator("details");
  assert.equal(await details.count(), 1);
  if (shots) await app.screenshot({ path: join(shots, "export-lantern-open.png") });
  assert.deepEqual(errors, []);
  await context.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
});

// ---- findings in frames ----------------------------------------------------

test("a finding about a whole page outlines nothing, and opens its code at once", async ({ browser, base }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  await editFile(page, "pages/booking.tsx", (text) => text.replace(/\n {6}<Slot name="action">\n.*\n {6}<\/Slot>/, ""));
  await measured(page, 2);
  const value = await report(page);
  const finding = value.findings.find((item) => item.rule === "primary-slot");
  assert.ok(finding, `primary-slot fails: ${failing(value)}`);
  assert.match(finding.message, /^Page "booking" does not fill its slot "action"/);
  assert.equal(finding.targets, undefined, "a finding about a whole page has no elements to outline");
  await showAllRules(page);
  await page.locator('.rule[data-rule="primary-slot"] .finding').first().click();
  await page.waitForSelector('[data-testid="code-line"]');
  assert.equal(await page.getByTestId("finding-outline").count(), 0);
  assert.equal(await page.locator('.rule[data-rule="primary-slot"]').getByRole("button", { name: "Show in code" }).count(), 0);
  await page.waitForTimeout(300);
  for (const scenario of SCENARIOS) for (const view of VIEWS) assert.equal((await overlays(page, scenario, view)).length, 0, `${scenario} at ${view} outlines nothing`);
});

/** Opens the app with every frame's snapshot message recorded as it reaches the app, tags on or off. */
async function recording(browser, base, tags) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(() => {
    if (window.top !== window) return;
    window.__frameMessages = [];
    window.addEventListener("message", (event) => {
      if (event.data && event.data.type === "snapshot") window.__frameMessages.push(JSON.parse(JSON.stringify(event.data)));
    });
  });
  const page = await context.newPage();
  await page.goto(tags ? base : `${base}?frame-tags=off`);
  await measured(page, 1);
  await page.getByRole("combobox", { name: "Prototype" }).selectOption("booking-spec");
  await measured(page, 2);
  const messages = await page.evaluate(() => window.__frameMessages);
  await context.close();
  const by = (generation) => Object.fromEntries(messages.filter((item) => item.generation === generation).map((item) => [`${item.snapshot.scenario}@${item.snapshot.view}`, item]));
  return { tsx: by(1), spec: by(2) };
}

test("element tags change nothing a rule measures: Nook's snapshots are identical with and without them, TSX and spec", async ({ browser, base }) => {
  const tagged = await recording(browser, base, true);
  const plain = await recording(browser, base, false);
  for (const format of ["tsx", "spec"]) {
    const keys = SCENARIOS.flatMap((scenario) => VIEWS.map((view) => `${scenario}@${view}`));
    assert.deepEqual(Object.keys(tagged[format]).sort(), [...keys].sort(), `every ${format} frame answered with tags`);
    assert.deepEqual(Object.keys(plain[format]).sort(), [...keys].sort(), `every ${format} frame answered without tags`);
    for (const key of keys) {
      assert.deepEqual(tagged[format][key].snapshot, plain[format][key].snapshot, `${format} ${key}: the same snapshot with and without tags`);
      assert.deepEqual(plain[format][key].tags, [], `${format} ${key}: no tags when they are off`);
      assert.ok(tagged[format][key].tags.length > 0, `${format} ${key}: the frame drew tagged elements`);
    }
  }
  assert.ok(tagged.tsx["lantern-open@desktop"].tags.some((tag) => /^pages\/booking\.tsx:\d+:\d+$/.test(tag)), "a TSX frame draws tags at source positions");
  assert.ok(tagged.spec["lantern-open@desktop"].tags.includes("details/summary"), "a spec frame draws tags at expanded keys, scoped by instance");
});

test("code export writes no element tags, for a TSX prototype or a spec", async ({ browser, base }) => {
  const { page } = await openApp(browser, base);
  await measured(page, 1);
  for (const prototype of ["booking", "booking-spec"]) {
    if (prototype !== "booking") {
      await page.getByRole("combobox", { name: "Prototype" }).selectOption(prototype);
      await measured(page, 2);
    }
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-code").click()]);
    const entries = unzipSync(readFileSync(await download.path()));
    assert.ok(Object.keys(entries).some((path) => path.endsWith("pages/booking.tsx")), `${prototype}: the export has the booking page`);
    for (const [path, bytes] of Object.entries(entries)) assert.ok(!strFromU8(bytes).includes("data-dh-source"), `${prototype}: ${path} has no element tag`);
  }
});

// ---- runner ----------------------------------------------------------------

const server = await preview({ root, configFile: join(root, "vite.config.ts"), logLevel: "silent", preview: { port: 0, host: "127.0.0.1" } });
const address = server.httpServer.address();
const base = `http://127.0.0.1:${address.port}/`;
// The fake Anthropic API answers at api.anthropic.com: Chromium resolves that host to it, with no proxy, so the
// built app talks to the API's real address and no request can reach the real API.
const api = await fakeAnthropic();
const browser = await chromium.launch({ ...executable, args: [`--host-resolver-rules=MAP api.anthropic.com:443 127.0.0.1:${api.port}`, "--no-proxy-server"] });
console.log(`e2e: Chromium ${browser.version()}${executable.executablePath ? ` from ${executable.executablePath}` : ", installed by Playwright"}`);
let failed = 0;
const selected = tests.filter((entry) => only.length === 0 || only.some((word) => entry.name.includes(word)));
for (const item of selected) {
  const started = Date.now();
  try {
    await item.fn({ browser, base, api });
    console.log(`ok   ${item.name} (${Date.now() - started} ms)`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${item.name} (${Date.now() - started} ms)\n     ${error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 30).join("\n     ") : String(error)}`);
  }
}
await browser.close();
await api.close();
await new Promise((resolve) => server.httpServer.close(resolve));
console.log(failed === 0 ? `e2e: ${selected.length} tests passed` : `e2e: ${failed} of ${selected.length} failed`);
process.exit(failed === 0 ? 0 : 1);
