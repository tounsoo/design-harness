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
import { errorBody, fakeAnthropic, streamEvents } from "./fake-anthropic.mjs";

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
  assert.equal(value.rules.length, 33);
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
    await page.getByRole("button", { name: "Open lantern-open at desktop full size" }).click();
    const viewport = await page.locator('.frame-card[data-frame-key="lantern-open@desktop"] .frame-viewport').boundingBox();
    assert.equal(Math.round(viewport.width), 1280);
    await shot(page, `full-size-${colorScheme}`);
    await page.getByRole("button", { name: "Back to board" }).click();
    await page.getByRole("tab", { name: "Project" }).click();
    await page.getByRole("heading", { name: "Component library" }).waitFor();
    for (const text of ["@tounsoo/todae 0.10.1", "primary-action", "Room details", "TARGET_MIN_PX", "Rules in force (32)", "No proposals yet"]) {
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
  assert.equal(await reply.locator('.chat-tool[data-tool="edit_file"] .chat-tool-title').textContent(), "Edited pages/rooms.tsx");
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
  assert.match(await card.textContent(), /Proposal drafted: A toast that confirms a booking \(booking-toast\), open/);
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

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export" }).click()]);
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

// ---- runner ----------------------------------------------------------------

const server = await preview({ root, configFile: join(root, "vite.config.ts"), logLevel: "silent", preview: { port: 0, host: "127.0.0.1" } });
const address = server.httpServer.address();
const base = `http://127.0.0.1:${address.port}/`;
// The fake Anthropic API answers at api.anthropic.com: Chromium resolves that host to it, with no proxy, so the
// built app talks to the API's real address and no request can reach the real API.
const api = await fakeAnthropic();
const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP api.anthropic.com:443 127.0.0.1:${api.port}`, "--no-proxy-server"] });
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
