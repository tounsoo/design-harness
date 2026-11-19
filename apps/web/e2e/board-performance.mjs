/**
 * Measures how heavy a board is, on a built app in Chromium: Nook's board
 * (the seed: 4 scenarios at 4 views, 16 frames) and the Variants view with
 * four variants of the booking page (5 sources at 16 frames each, 80). For
 * each it prints:
 *
 * - the time to the first full report: from navigation (or the click that
 *   opens the Variants view) until core's report has every frame's answer;
 * - live iframes and memory once measured: iframes in the DOM, the app's
 *   JS heap after a garbage collection, and Chromium's renderer processes
 *   with their memory (a sandboxed frame's document runs in a renderer of
 *   its own, so its memory is not in the app's heap);
 * - for the board, typing five words into a file (a revision after each
 *   word, as a person types) until the last revision is measured: the
 *   main thread's long tasks (over 50 ms), their total and the longest, and
 *   the slowest keystroke's event duration.
 *
 * It asserts nothing: timings depend on the machine. `npm run build` in
 * apps/web, then `node e2e/board-performance.mjs [--dist <folder>] [--runs 3]`;
 * `--dist` measures another build of the app, such as one from before a change.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { preview } from "vite";
import { fakeAnthropic, streamEvents } from "./fake-anthropic.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argument = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};
const dist = resolve(argument("--dist", join(root, "dist")));
const runs = Number(argument("--runs", "3"));
const only = argument("--only", "all");
const PREINSTALLED_CHROMIUM = "/opt/pw-browsers/chromium";
const executable = existsSync(PREINSTALLED_CHROMIUM) ? { executablePath: PREINSTALLED_CHROMIUM } : {};
const KEY = "sk-ant-e2e-fake-0123456789abcdefghijklmnop";
const BOOKING_SPEC = JSON.parse(readFileSync(join(root, "..", "..", "packages", "core", "examples", "nook", "prototypes", "spec", "legal", "booking", "pages", "booking.json"), "utf8"));

const server = await preview({ root, configFile: join(root, "vite.config.ts"), logLevel: "silent", build: { outDir: dist }, preview: { port: 0, host: "127.0.0.1" } });
const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
const api = await fakeAnthropic();
const browser = await chromium.launch({ ...executable, args: [`--host-resolver-rules=MAP api.anthropic.com:443 127.0.0.1:${api.port}`, "--no-proxy-server"] });

/** In the page from its first script: when each revision's report became complete, and every long task and slow event. */
function instrument() {
  if (window.top !== window) return;
  window.__perf = { measured: {}, longtasks: [], events: [] };
  new window.MutationObserver(() => {
    const checks = document.querySelector(".checks[data-measured]");
    const revision = checks?.getAttribute("data-revision");
    if (revision && window.__perf.measured[revision] === undefined) window.__perf.measured[revision] = window.performance.now();
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-measured", "data-revision"], childList: true });
  new window.PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__perf.longtasks.push({ start: entry.startTime, duration: entry.duration });
  }).observe({ type: "longtask", buffered: true });
  new window.PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__perf.events.push({ name: entry.name, start: entry.startTime, duration: entry.duration });
  }).observe({ type: "event", durationThreshold: 16, buffered: true });
}

async function open(viewport = { width: 1600, height: 1000 }) {
  const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
  await context.addInitScript(instrument);
  const page = await context.newPage();
  return { context, page };
}

const measured = (page, revision) => page.waitForSelector(`.checks[data-measured][data-revision="${revision}"]`, { timeout: 300000, state: "attached" });

/**
 * Chromium's renderer processes under this script, and their memory in MB
 * (proportional set size where Linux gives it, else resident): a sandboxed
 * frame has an opaque origin, so Chromium runs its document out of the
 * app's process, and its memory is in a renderer of its own.
 */
function renderers() {
  const parents = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      parents.set(Number(name), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch {
      // Gone already.
    }
  }
  const mine = (pid) => {
    for (let at = pid; at > 1; at = parents.get(at) ?? 0) if (at === process.pid) return true;
    return false;
  };
  let count = 0;
  let kb = 0;
  for (const pid of parents.keys()) {
    if (!mine(pid)) continue;
    let command = "";
    try {
      command = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (!command.includes("--type=renderer")) continue;
    count += 1;
    try {
      const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
      kb += Number(/^Pss:\s+(\d+)/m.exec(rollup)?.[1] ?? /^Rss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0);
    } catch {
      kb += Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
    }
  }
  return { renderers: count, renderersMB: Math.round(kb / 1024) };
}

/** Iframes in the DOM, Chromium's documents and frames, the app's JS heap after a collection, and every renderer's memory, in MB. */
async function memory(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const metric = (name) => metrics.find((item) => item.name === name)?.value ?? 0;
  const iframes = await page.locator("iframe").count();
  // A moment for frames just parked to leave their processes.
  await page.waitForTimeout(1500);
  return { iframes, frames: metric("Frames"), heapMB: Math.round((metric("JSHeapUsedSize") / 1048576) * 10) / 10, ...renderers() };
}

async function board() {
  const { context, page } = await open();
  await page.goto(base);
  await measured(page, 1);
  const first = await page.evaluate(() => window.__perf.measured["1"]);
  const atRest = await memory(page);
  // Typing: five words at the end of a file, 60 ms a key, with a pause after each word long enough for the edit to become a revision, as a person types.
  await page.getByRole("tab", { name: "Code" }).click();
  await page.locator(".code-file select").first().selectOption("pages/booking.tsx");
  const editor = page.locator('[data-testid="code-editor"]');
  await editor.focus();
  await page.keyboard.press("Control+End");
  const revisionBefore = Number(await page.locator(".checks").getAttribute("data-revision"));
  const started = await page.evaluate(() => window.performance.now());
  for (const word of ["\n// typing", " on the", " board,", " a word", " at a time"]) {
    await page.keyboard.type(word, { delay: 60 });
    await page.waitForTimeout(450);
  }
  // The last revision, once the edit debounce has passed and every frame has answered.
  await page.waitForFunction((before) => Number(document.querySelector(".checks")?.getAttribute("data-revision")) > before, revisionBefore);
  await page.waitForTimeout(800);
  const last = await page.locator(".checks").getAttribute("data-revision");
  await measured(page, last);
  const typed = await page.evaluate((from) => {
    const tasks = window.__perf.longtasks.filter((task) => task.start >= from);
    const keys = window.__perf.events.filter((event) => event.start >= from && /key|input|beforeinput/.test(event.name));
    return { tasks: tasks.length, total: Math.round(tasks.reduce((sum, task) => sum + task.duration, 0)), longest: Math.round(Math.max(0, ...tasks.map((task) => task.duration))), slowestKey: Math.round(Math.max(0, ...keys.map((event) => event.duration))), done: Math.round(window.performance.now() - from) };
  }, started);
  const afterTyping = await memory(page);
  await context.close();
  return { firstFullReportMs: Math.round(first), atRest, typing: { revisions: Number(last) - revisionBefore, ...typed }, afterTyping };
}

const toolReply = (id, name, input, text) => ({ events: streamEvents({ id: `msg_${id}`, blocks: [{ type: "text", text }, { type: "tool_use", id: `toolu_${id}`, name, input }], stopReason: "tool_use" }), delayMs: 5 });
const textReply = (text) => ({ events: streamEvents({ id: "msg_end", blocks: [{ type: "text", text }], stopReason: "end_turn" }), delayMs: 5 });

function fourVariants() {
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const asks = copy(BOOKING_SPEC);
  asks.elements.question.props.label = "For how long?";
  const floor = copy(BOOKING_SPEC);
  floor.elements.seats.props.text = { $template: "${/room/floor}, ${/room/seats} seats" };
  const both = copy(BOOKING_SPEC);
  both.elements.hold.props.variant = "primary";
  const plain = copy(BOOKING_SPEC);
  plain.elements.question.props.label = "How long do you need it?";
  return [
    { note: "Asks for how long", spec: asks },
    { note: "Leads with the floor", spec: floor },
    { note: "Both actions primary", spec: both },
    { note: "Asks in a sentence", spec: plain },
  ];
}

async function variants() {
  const { context, page } = await open();
  await page.goto(base);
  await measured(page, 1);
  await page.getByRole("combobox", { name: "Prototype" }).selectOption("booking-spec");
  await measured(page, 2);
  api.script([toolReply("variants", "propose_variants", { page: "booking", variants: fourVariants() }, "Four ways the booking page could go."), textReply("Four variants are on the Variants tab.")]);
  await page.getByLabel("Your Anthropic API key").fill(KEY);
  await page.getByRole("button", { name: "Use this key" }).click();
  await page.getByText("Settings and key").waitFor();
  await page.getByRole("textbox", { name: "Message the agent" }).fill("Give me four variants of the booking page");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Compare variants" }).waitFor({ timeout: 120000 });
  const started = await page.evaluate(() => window.performance.now());
  await page.getByRole("button", { name: "Compare variants" }).click();
  // Every source's card has core's verdict on its measured frames.
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll(".variant-card[data-variant]")];
    return cards.length === 5 && cards.every((card) => ["pass", "fail"].includes(card.getAttribute("data-standing") ?? ""));
  }, null, { timeout: 300000, polling: 50 });
  const allMs = Math.round((await page.evaluate(() => window.performance.now())) - started);
  const frames = await page.locator(".variant-card .frame-card").count();
  const atRest = await memory(page);
  await context.close();
  return { frames, allStandingMs: allMs, atRest };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = { board: [], variants: [] };
for (let run = 0; run < runs; run += 1) {
  if (only === "all" || only === "board") results.board.push(await board());
  if (only === "all" || only === "variants") results.variants.push(await variants());
}
console.log(`dist: ${dist}`);
console.log(JSON.stringify(results, null, 1));
if (results.board.length > 0) {
  const b = results.board;
  console.log(`board (16 frames): first full report median ${median(b.map((item) => item.firstFullReportMs))} ms; iframes ${median(b.map((item) => item.atRest.iframes))}, renderers ${median(b.map((item) => item.atRest.renderers))} using ${median(b.map((item) => item.atRest.renderersMB))} MB, app heap ${median(b.map((item) => item.atRest.heapMB))} MB`);
  console.log(`board typing: long tasks median ${median(b.map((item) => item.typing.tasks))}, total ${median(b.map((item) => item.typing.total))} ms, longest ${median(b.map((item) => item.typing.longest))} ms, slowest key ${median(b.map((item) => item.typing.slowestKey))} ms over ${median(b.map((item) => item.typing.revisions))} revisions`);
}
if (results.variants.length > 0) {
  const v = results.variants;
  console.log(`variants (${v[0].frames} frames): every card measured median ${median(v.map((item) => item.allStandingMs))} ms; iframes ${median(v.map((item) => item.atRest.iframes))}, renderers ${median(v.map((item) => item.atRest.renderers))} using ${median(v.map((item) => item.atRest.renderersMB))} MB, app heap ${median(v.map((item) => item.atRest.heapMB))} MB`);
}
await browser.close();
await api.close();
await new Promise((done) => server.httpServer.close(done));
