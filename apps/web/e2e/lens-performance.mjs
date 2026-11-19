/**
 * Measures the lenses on the built app in Chromium, with Nook at 16 frames
 * (the seed: 4 scenarios at 4 views) and at 40 (the same project imported
 * with 10 views). It prints, for each lens:
 *
 * - how long turning it on takes: from the click until every artboard's
 *   layer is in the DOM and the next frame has painted;
 * - how many SVG nodes the layers add;
 * - the board scrolled from top to bottom over two seconds: the median and
 *   the worst frame interval, and how many frames took over 50 ms, against
 *   the same scroll with no lens.
 *
 * It asserts nothing: timings depend on the machine. Run it on a quiet one:
 * `npm run build` in apps/web, then `node e2e/lens-performance.mjs`.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { preview } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PREINSTALLED_CHROMIUM = "/opt/pw-browsers/chromium";
const executable = existsSync(PREINSTALLED_CHROMIUM) ? { executablePath: PREINSTALLED_CHROMIUM } : {};
const UNDERSIZED = (text) => text.replace("{lantern.seats} seats, {lantern.floor}\n        </Text.Root>", '{lantern.seats} seats, {lantern.floor}\n        </Text.Root>\n        <Text.Root as="span" role="button" tabIndex={0}>A</Text.Root>\n        <Text.Root as="span" role="button" tabIndex={0}>B</Text.Root>');

const server = await preview({ root, configFile: join(root, "vite.config.ts"), logLevel: "silent", preview: { port: 0, host: "127.0.0.1" } });
const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch({ ...executable, args: ["--no-proxy-server"] });

const measured = (page, revision) => page.waitForSelector(`.checks[data-measured][data-revision="${revision}"]`, { timeout: 180000, state: "attached" });

/** Scrolls the board from top to bottom over `ms`, and returns the intervals between the frames painted on the way. */
async function scrollBoard(page, ms = 2000) {
  return page.evaluate(
    (duration) =>
      new Promise((resolve) => {
        const area = document.querySelector(".board-area");
        const distance = area.scrollHeight - area.clientHeight;
        const intervals = [];
        let last = window.performance.now();
        const start = last;
        const step = (now) => {
          intervals.push(now - last);
          last = now;
          const progress = Math.min(1, (now - start) / duration);
          area.scrollTop = distance * progress;
          if (progress < 1) window.requestAnimationFrame(step);
          else resolve(intervals.slice(1));
        };
        area.scrollTop = 0;
        window.requestAnimationFrame(step);
      }),
    ms,
  );
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const summary = (intervals) => `median ${median(intervals).toFixed(1)} ms, worst ${Math.max(...intervals).toFixed(1)} ms, ${intervals.filter((value) => value > 50).length} of ${intervals.length} frames over 50 ms`;

async function run(views) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(base);
  await measured(page, 1);
  let revision = 1;
  if (views > 4) {
    // The same project with more views: Nook's two sizes over and over, light and dark.
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export", exact: true }).click()]);
    const project = JSON.parse(readFileSync(await download.path(), "utf8"));
    project.project.views = Array.from({ length: views }, (_, index) => ({ name: `view-${index + 1}`, width: index % 2 === 0 ? 1280 : 390, height: index % 2 === 0 ? 900 : 844, scheme: index % 4 < 2 ? "light" : "dark" }));
    const file = join(mkdtempSync(join(tmpdir(), "design-harness-lens-")), "nook.design-harness.json");
    writeFileSync(file, JSON.stringify(project));
    await page.locator('[data-testid="import-file"]').setInputFiles(file);
    await page.locator('iframe[title="rooms-list at view-1"]').waitFor({ state: "attached" });
    await measured(page, 1);
  }
  // A failing board, so the tap-target lens has circles and labels to draw.
  await page.getByRole("tab", { name: "Code" }).click();
  await page.locator(".code-file select").first().selectOption("pages/booking.tsx");
  const editor = page.locator('[data-testid="code-editor"]');
  await editor.fill(UNDERSIZED(await editor.inputValue()));
  await measured(page, (revision += 1));
  const frames = await page.locator(".frame-card").count();
  console.log(`\n${frames} frames (${views} views)`);
  console.log(`  no lens: scroll ${summary(await scrollBoard(page))}`);
  for (const lens of ["Tap targets", "First view"]) {
    const button = page.getByTestId("lens-control").getByRole("button", { name: lens });
    const took = [];
    for (let round = 0; round < 5; round += 1) {
      const started = await page.evaluate(() => window.performance.now());
      await button.click();
      await page.waitForFunction((count) => document.querySelectorAll('[data-testid="lens-layer"]').length === count, frames);
      took.push((await page.evaluate(() => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(window.performance.now()))))) - started));
      if (round < 4) {
        await button.click();
        await page.waitForFunction(() => document.querySelectorAll('[data-testid="lens-layer"]').length === 0);
      }
    }
    const nodes = await page.evaluate(() => [...document.querySelectorAll('[data-testid="lens-layer"]')].reduce((sum, layer) => sum + layer.querySelectorAll("*").length, 0));
    // In the page itself: one click, and the time React takes to put every layer in the DOM, without the test's round trips.
    await button.click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="lens-layer"]').length === 0);
    const inPage = await page.evaluate(
      ([name, count]) =>
        new Promise((resolve) => {
          const target = [...document.querySelectorAll('[data-testid="lens-control"] button')].find((item) => item.textContent.trim() === name || item.getAttribute("aria-label") === name);
          const started = window.performance.now();
          target.click();
          const check = () => (document.querySelectorAll('[data-testid="lens-layer"]').length === count ? window.requestAnimationFrame(() => resolve(window.performance.now() - started)) : window.requestAnimationFrame(check));
          check();
        }),
      [lens, frames],
    );
    console.log(`  ${lens}: on in ${inPage.toFixed(0)} ms in the page (click to painted; ${median(took).toFixed(0)} ms median of 5 through the test driver), ${nodes} SVG nodes in ${frames} layers`);
    console.log(`  ${lens}: scroll ${summary(await scrollBoard(page))}`);
    await button.click();
  }
  await context.close();
}

for (const views of [4, 10]) await run(views);
await browser.close();
await new Promise((resolve) => server.httpServer.close(resolve));
