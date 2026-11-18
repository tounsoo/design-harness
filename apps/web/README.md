# @design-harness/web

The design-harness app: a project's prototype rendered as a board of live frames, with `@design-harness/core`'s checks beside it. It runs entirely in the browser. A static build works with no backend, and projects are kept in the browser's IndexedDB.

The left panel is the agent's chat, on the person's own Anthropic API key: ask the agent to build or change the prototype, and the frames and the checks follow, with the agent fixing what the checks report. A plain code view edits the same files by hand.

## Run it

```sh
npm ci                # from the repository root
npm run dev           # Vite dev server for apps/web, after building the local package source
npm run build         # static build in apps/web/dist/, the local package source included
npm run e2e           # builds, then runs the end-to-end tests in Chromium
```

`npm run vendor` (run by `dev`, `build` and `e2e`) prebuilds the packages a frame imports from this repository's `node_modules` into `public/vendor/` (git-ignored). `npm run check` at the root typechecks, lints and runs the unit tests, the app's included.

On first open the app seeds the Nook example from `packages/core/examples/nook/`: its config and its legal booking prototype, read from the files core's own tests read. What you see:

- **Header:** project and prototype, the library, the Canvas and Project views, Export and Import.
- **Canvas:** one row per scenario and one frame per view in it (Nook: 4 scenarios × desktop and phone), each a live render scaled to fit. Zoom is Fit, 25, 50 or 100%. **Open** shows a frame at full size, in place.
- **Checks:** core's report, rule by rule in core's order, with each finding's message word for word and where it is. Selecting a rendered finding outlines the element in its frame; selecting a source finding opens its file at its line. The report is also there as JSON.
- **Code:** each prototype file and `manifest.json` in a plain editor. An edit is a new revision 300 ms after typing stops: the frames re-render and the checks run again. Edits are saved in the browser.
- **Project:** the library and its role mapping, inventories, rule inputs, views, rules and proposals with their status, read-only.
- **Agent:** the chat (below). Paste a key, pick a model and effort, and ask. Each tool call is one line that opens to its input and result; the checks the app ran after a change show their verdict; each turn shows its tokens, an approximate cost and **Undo this turn**. **Stop** stops it at any time.

Nothing in the app decides pass or fail. It renders frames, collects what they painted, and hands both the prototype and the snapshots to `checkPrototype`. The report it shows is core's.

## Where things are

| Path | What it is |
| --- | --- |
| `src/app/` | The UI: `App` (open the store and the key vault, seed), `Workspace` (layout, edits, selection, the agent's host), `Board`, `ChecksPanel`, `CodePanel`, `ProjectView`, `ChatPanel`, `app.css` |
| `src/agent/` | The agent: `request.ts` (client, system prompt, request), `tools.ts` (tool definitions and handlers), `schema.ts` (tool input validation), `history.ts` (the append-only API history), `controller.ts` (the turn loop, stop, retry, undo, saving), `measure.ts` (a report only for fully measured current source), `errors.ts`, `models.ts` (models, effort, prices), `key-vault.ts`, `settings.ts` |
| `src/runtime/session.ts` | One prototype's check loop: revisions, frames, snapshots, core's report |
| `src/runtime/protocol.ts` | The frame protocol's message types and both sides' validators |
| `src/runtime/frame-document.ts` | A frame's `srcdoc`: sandbox, CSP, boot script |
| `src/runtime/transform.ts` | TSX to ES modules, in the browser |
| `src/runtime/package-source.ts` | Where React and the library come from |
| `src/frame/boot.ts` | The script inside each frame: import map, render, settle, measure, highlight |
| `src/frame/kit.tsx`, `slots.ts` | The page kit, `@design-harness/page`: `Slot`, `PageProps` and the default shell |
| `src/frame/collect.ts` | The rendered-snapshot collector |
| `src/frame/determinism.ts` | The frame's fixed clock and seeded `Math.random` |
| `src/store/` | IndexedDB storage and the project file |
| `src/seed/nook.ts` | The seeded project |
| `scripts/build-vendor.mjs` | Builds the local package source |
| `e2e/run.mjs` | End-to-end tests |
| `e2e/fake-anthropic.mjs` | The fake Anthropic API the agent's unit and end-to-end tests run against |
| `test/agent-host.ts` | An agent host over plain values, for the tool and loop tests |

## Isolation

Prototype code will be written by an agent while the user's API key lives in the app's origin, so it never runs in that origin.

- Each frame is an `<iframe sandbox="allow-scripts" srcdoc="...">`. Without `allow-same-origin` its document has an opaque origin (`"null"`): it cannot read the app's DOM, `localStorage`, IndexedDB, cookies or location, and the app's storage is not its storage. Without the other tokens it cannot submit forms, open popups or modals, or navigate the top window.
- The frame's document carries its own Content Security Policy: `default-src 'none'`, scripts only with the document's nonce (the boot script and the import map it adds), from `blob:` (the modules it builds) and from the package source's origins, styles and fonts from inline and those origins, images only `data:` and `blob:`, and `connect-src 'none'`, so `fetch` and XHR fail. The nonce is random per document, and there is no `'unsafe-inline'` or `'unsafe-eval'` for scripts, so nothing in a frame can turn a string into code: `eval`, `new Function`, an inline `onerror` attribute and a `javascript:` URL are all refused.
- The only channel is `postMessage`. Each frame document gets a random channel id per revision. The boot script reads it and removes it from the DOM before any prototype module loads, so it lives on only in the boot script's closure, and a frame's first answer for its revision is its only one: a later snapshot or error on its channel is dropped. The app accepts a message only when `event.source` is the iframe that channel was issued to, the channel and generation are current, and the message has exactly the fields of its type; a snapshot must also pass core's snapshot schema and be of the frame's own scenario and view. The frame accepts a message only from its parent, on its channel, of exactly a render or highlight request's shape. The app posts to a frame with target `*` (an opaque origin cannot be named); the frame posts only to the app's origin.

The end-to-end test "a frame cannot reach the app" proves it in Chromium: it edits a prototype file to write into the parent's DOM and storage at load (both stay untouched, and core's `no-ambient-globals` reports the file) and to run `eval` and `new Function` (both throw `EvalError` in the prototype's own code), checks every iframe's sandbox is exactly `allow-scripts`, and runs, inside each of the 8 frames, attempts to read `parent.document`, `parent.location`, `top.localStorage`, its own `localStorage`, `indexedDB`, `document.cookie` (each throws `SecurityError`, and `self.origin` is `"null"`), to `fetch` the app (a `TypeError`: the CSP refuses it), and to run an inline `onerror` attribute (it never runs), and finds no channel id left in the DOM.

A prototype shares its frame with the collector, and now that a model writes prototype code, core's `no-ambient-globals` rule refuses source that reaches the frame's window, document, message plumbing, timers, constructors or DOM nodes, writes to properties, or reads a property by a computed key (packages/core/README.md, What prototype code may reach). Together: prototype code cannot turn strings into code (CSP), cannot learn the channel (removed from the DOM), cannot answer twice, and source that tries to reach any of it fails the checks. What remains: the rule is a source rule over what the code names; a value a library part hands a callback at run time is only as safe as the names the rule refuses on it. A prototype still cannot change what another frame reports, or reach the app.

## The frame protocol

All messages carry `protocol: "design-harness/frame@1"` and the frame's `channel`.

| Direction | `type` | Fields | When |
| --- | --- | --- | --- |
| frame → app | `ready` | | The boot script is listening. The app sends nothing before it. |
| app → frame | `render` | `generation`, `modules` (bare specifier → `{ url }` or `{ code }`), `styles` (`{ url }` or `{ css }`), `page` (`{ module, export }`), `scenario` (`{ id, state, page }`), `pageType`, `view`, `settleMs` | Once per frame document. |
| frame → app | `snapshot` | `generation`, `snapshot` (core's `RenderedSnapshot`) | The page rendered, settled and was measured. |
| frame → app | `error` | `generation`, `stage` (`load`, `render` or `measure`), `message` (at most 2000 characters) | The page could not be loaded, threw while rendering, or never stopped changing. |
| app → frame | `highlight` | `generation`, `element` (an index into the last snapshot's `elements`, or `null`) | A finding was selected. |

A frame renders once. A new revision gets a new document, so no module, import map or state carries over from the last one. The app waits for every frame of a revision to send a snapshot or an error, or to time out after 20 s, then runs core's checks with the snapshots it has; a scenario and view without one is core's "not measured" finding, so a frame that fails fails the rendered rules rather than passing them.

## Running TSX in the browser

`transform.ts` compiles each file with [sucrase](https://github.com/alangpierce/sucrase) (TypeScript stripped, JSX to `react/jsx-runtime`), then rewrites every relative import to the bare specifier `@prototype/<path>` of the file it resolves to, using core's `resolvePath`, so a frame loads exactly the files the extractor checked. The frame builds an import map: each prototype module and each `{ code }` package module becomes a `blob:` URL, each `{ url }` module keeps its URL, and React, React DOM, the library and the page kit resolve by bare specifier to one instance each. Nothing is bundled at runtime; the browser's own module loader links the files.

Why sucrase with native modules and an import map:

| Option | Size in the app | Startup | Notes |
| --- | --- | --- | --- |
| sucrase (chosen) | 206 kB minified, 48 kB gzipped | synchronous, no warm-up; the 7-file Nook prototype compiles in about 6 ms | Transforms only, which is all a frame needs: the browser links the modules. Pure JS, deterministic. |
| esbuild-wasm | the package unpacks to 14.5 MB, nearly all a WebAssembly binary | an async fetch and instantiation before the first compile | Can bundle, which an import map makes unnecessary. |
| @babel/standalone | the package unpacks to 6.7 MB | slow to parse and start | The app already ships `@babel/parser` for core, but not the transforms. |

The app reuses the `@babel/parser` core already ships to find import specifiers in sucrase's output. A file that does not compile becomes a module that throws its error, so the frame reports it, and core's `extract` rule reports it too.

## Where packages come from

```ts
interface PackageSource {
  readonly name: string;                    // "local" or "esm.sh"
  readonly origins: readonly string[];      // added to the frame's CSP
  module(specifier: string, request: { package: string; version: string }): Promise<{ url: string } | { code: string }>;
  stylesheet(path: string, request: { package: string; version: string }): Promise<{ url: string } | { css: string }>;
}
```

`resolvePackages(config.library, source)` asks it for `react`, `react/jsx-runtime` (at `library.react`), `react-dom`, `react-dom/client` (at `library.react`), the library package (at `library.version`) and each of `library.stylesheets`.

- **`localPackageSource`** (the default): the versions installed in `node_modules`, prebuilt by `npm run vendor` into one ES module per specifier. CommonJS packages get named exports listed from the module itself, and React stays external everywhere, so the library, React DOM and the page share one React. The app reads the files from its own origin and sends their code to the frame, which never fetches. It refuses any other version, naming both: "the local package source has @tounsoo/todae 0.10.1, but the project asks for 0.11.3". It serves only each package's root entry, not subpaths such as `@tounsoo/todae/stack`.
- **`esmShPackageSource`**: `https://esm.sh/<package>@<version>[/<subpath>]`, with `?external=react,react-dom` on everything but React, so every module imports the React the import map names; stylesheets as `https://esm.sh/<package>@<version>/<path>`. Choose it with `VITE_PACKAGE_SOURCE=esm.sh` at build time or `?packages=esm.sh` on the page; `&packages-origin=<origin>` points it at a mirror with the same URL scheme.

What was verified: the local source, end to end, in every test. The URL path, also end to end: a test serves the vendor build from a second local origin in esm.sh's URL scheme, with CORS, and the app opened with `?packages=esm.sh&packages-origin=...` loads React, React DOM and Todae by URL into the import map, the stylesheet by `<link>`, within the frame's CSP, and the legal prototype passes every rule. What was not: esm.sh itself. This environment's network policy refuses esm.sh, jsDelivr and unpkg, so whether esm.sh serves these exact URLs, keeps React external as asked for `react-dom/client`, and serves `dist/todae.css` as CSS, is untested.

## The page kit and the default shell

Prototypes import `Slot` and the `PageProps` type from `@design-harness/page`, which the frame provides. `Slot` renders a `<div data-slot="name">` and takes its place from the default shell, which knows the page type from the config and nothing about the library:

- Slots keep the page type's order. A body slot is one neither chrome nor primary, as core counts them. Every slot after the last body slot is the **trail**: an action page's primary slot and its alternates.
- At 600 CSS px and wider, the page is a centred column at most 760 px wide; lead and body slots are full-width rows and the trail's slots sit side by side under the body. Narrower, every slot is a full-width row.
- A slot name the page type lacks still renders, after the known slots, outlined; core's `page-structure` rule reports it.
- The root gets the view's colour scheme as CSS `color-scheme` and, when the config names `library.schemeAttribute` (Todae's `data-appearance`), as that attribute. The shell sets a system font only at zero specificity, so a library's own root font wins.

The shell needs no new config field beyond `schemeAttribute`: which slots are chrome, primary and body was already in `pageTypes`, and their order gives the lead and the trail. Chrome slots render whatever the page puts in them, its own layouts included; a prototype-wide frame around every page (a top bar) is not modelled in core yet, so the shell renders none.

## How a scenario reaches a page

A page component is rendered as `<Page scenario={scenario.id} state={scenario.state} />`, typed `PageProps`. That is the whole contract. Nook's booking page reads `state` to say "Booked until 3 pm" or "Held for 10 minutes". Core's extractor treats a page's props as unknown, so everything a page shows in any state is in its model and counts, as `packages/core/README.md` explains, with tests in `packages/core/src/extract/extract.test.ts`.

## Rendered snapshots

Inside each frame, after the page settles, `collect.ts` reads the live DOM into core's `RenderedSnapshot`. It records, in document order, every control (native controls, links with `href`, a details element's summary, widget ARIA roles, `contenteditable`, `tabindex >= 0`), every heading (with its `aria-level` or tag level), and every element that paints text of its own.

- Names: `dom-accessibility-api`'s accessible-name computation for controls and headings; an element that only paints text is named by that text. Roles from its `getRole`.
- Visible: rendered, not `visibility: hidden` or opacity 0 up the tree, not clipped to a pixel, not inside a closed `<details>`. A visually hidden control with a visible `<label>` is measured at the label, which is what a person presses.
- Text paint: font size and weight, the colour with every ancestor's opacity multiplied in, and background colours up the tree to the first opaque one; any `oklch()` or other colour is read through a canvas. An image or gradient under the text sets `overImage`. Text in a turned-off control sets `disabled`.
- Inline: a link laid out inline with other text in its block, which WCAG 2.5.8 exempts.
- `scrollWidth` and `viewportWidth` (the root's client width, less a vertical scrollbar drawn beside the page), and the root canvas colour of the used colour scheme.

Determinism: the frame waits for web fonts, image decoding and a DOM that has not changed for three checks 50 ms apart, using timers, not animation frames (a browser may throttle frames in an off-screen iframe). A page still changing after 3 s is an error, not a guess. Animations and transitions run in no time. `Date` and `Date.now()` read a fixed instant (2026-01-05 09:30 UTC) and `Math.random` is seeded. Rects are rounded to a hundredth of a pixel. The end-to-end test "the same prototype gives the same report on reload" compares core's whole report across a reload.

Against a real page, core's rendered rules needed four fixes (each with tests in core): findings now carry the element's index so they can be pointed at; text over an image or gradient is unverifiable rather than passed; text in a turned-off control is exempt from contrast; and sideways scroll is measured against the width beside a vertical scrollbar. The real render also caught a bug the hand-written snapshots hid: the legal Nook prototype's select had no accessible name, because its label named no field.

## The agent

### What a turn is

A turn is one message from the person and everything the agent does about it. The app sends the conversation to the Messages API as a streamed request; text and thinking summaries appear as they arrive, and a tool call shows as soon as it starts, with its input growing. When the reply stops for `tool_use`, the app runs the calls in order against its own state and sends the results back in the next request. After every round in which the agent changed the prototype, the app waits for the new revision to be measured by every frame, runs core's checks, and adds core's report after the tool results, so a failing check reaches the agent whether it asked or not. Then the next request goes out.

A turn ends when:

- the reply stops for any reason but `tool_use` or `pause_turn` (`end_turn` is the usual one; a text reply cut off at `max_tokens` ends with a note);
- the person presses **Stop**: the stream is aborted, a tool waiting on the checks stops waiting, every tool call of the round still gets a result (`Not run: the person stopped the agent.`), and what streamed before the stop is shown but not kept;
- 16 rounds of tool calls have run for the message (`MAX_ROUNDS`): the results go back into the history and the chat says the agent stopped; the next message carries on;
- the reply is a refusal (`stop_reason: "refusal"`): `stop_details`' category and explanation are shown, nothing of the declined reply is kept and none of its tool calls runs;
- the reply hit `max_tokens` in the middle of a tool call: nothing runs, since a cut input can parse as a valid smaller one;
- a request fails. Errors come from the SDK's typed classes: a refused key (401), a key without access (403), a rate limit (429, with `retry-after`), overload (529 or an `overloaded_error` event mid-stream), a timeout or no connection, a refused request (400), a server error. Each is shown plainly, with **Retry** where retrying can help; a retry continues the same turn from the same history. A tool input the SDK could not parse at all is requested again, at most twice in a row.

### The request

```ts
// request.ts: the base client and only the beta Messages resource
const client = new BaseAnthropic({ apiKey, dangerouslyAllowBrowser: true, logLevel: "off", maxRetries: 2 });
new Messages(client).stream({
  model, // claude-opus-5-5 (default), claude-sonnet-5-5 or claude-haiku-5-5
  max_tokens: 32000,
  system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  tools, // the nine below, each with eager_input_streaming: true
  tool_choice: { type: "auto" }, // forced tool choice is a 400 on these models
  thinking: { type: "adaptive", display: "summarized" },
  output_config: { effort }, // low | medium (default) | high | xhigh | max
  cache_control: { type: "ephemeral" }, // caches the conversation up to its newest block
  fallbacks: "default",
  betas: ["server-side-fallback-2026-07-01"],
  messages,
}, { signal });
```

- `dangerouslyAllowBrowser: true` does two things in the SDK (`client.ts`, 1.10.0): it skips the check that throws in a browser, and adds the header `anthropic-dangerous-direct-browser-access: true`, which the API needs to answer a browser's CORS request. The key goes in an `Authorization: Bearer` header to `https://api.anthropic.com/v1/messages`, the SDK's default base URL; the app sets no other base URL and has no setting for one. `logLevel: "off"` keeps the SDK from logging, and its logger redacts auth headers in any case.
- Thinking is adaptive, these models' default and the only kind Opus 5.5 accepts; nothing sends `disabled` or a budget. `display: "summarized"` returns readable summaries, which is also where these models put their notes between tool calls; the chat shows them under **Thinking**. Effort is set explicitly on every request, `medium` by default, Opus 5.5's own default and a good start for agentic coding.
- `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta turns on the server-side refusal fallback: a request a model declines for policy reasons is re-run in the same call on the model Anthropic recommends for that refusal category. A turn a fallback continued carries a `fallback` block, shown as a note; it is echoed back as the API requires (below). On a model without a fallback configuration the request runs on that model alone.
- The system prompt and the tools are fixed text: the same bytes in every request of every conversation, so they are the stable cached prefix, and nothing about the project is in them (the agent reads it with `read_project`). A change to the project therefore never changes the prefix.

### The history

The API history is append-only (`history.ts`): earlier turns are never rewritten or dropped, every appended message is a deep-frozen copy, and an assistant turn goes back exactly as the API returned it, thinking blocks and their signatures included. The one transformation is the API's rule for a turn that a refusal fallback continued: before the last `fallback` block only text and the `fallback` markers go back, and only the tool calls after it run. It is applied once, when the turn is appended, so every later request sends the same bytes. A note the app owes the agent, such as "the person undid your changes", goes into the next user message, before the person's text; the checks after a round go after that round's tool results. Unit tests prove each request extends the previous one exactly.

### The tools

Each tool's input is validated against the same JSON Schema it is declared with (`schema.ts`) before it runs, since with eager input streaming the API no longer validates it; input that fails gets an error result naming every problem, and nothing runs.

| Tool | Input | What it does |
| --- | --- | --- |
| `read_project` | none | The library and role mapping, inventories, rule inputs, views, every rule in force as JSON, and proposals with their status. |
| `list_files` | none | The files with their line counts, and the manifest. |
| `read_file` | `path` | One file, or `manifest.json`. |
| `write_file` | `path` (a `.tsx`, `.ts`, `.jsx` or `.js` path, no `..`), `content` | Creates or replaces a file. |
| `edit_file` | `path`, `old_text`, `new_text` | Replaces text that appears exactly once. |
| `delete_file` | `path` | Deletes a file. |
| `set_manifest` | `pages`, `layouts`, `scenarios`, `flow` | Replaces the manifest; core's `parsePrototype` refuses it or it is applied. |
| `run_checks` | none | Core's report for the current revision, once every frame measured it. |
| `draft_proposal` | `id`, `title`, `reason`, `states`, `inventory`, `rules.add`, `rules.remove`, `examples.pass` and `examples.fail` (each `name`, `files`, `remove_files`, `manifest`; a failing one also `flagged_by`) | Saves the proposal as `open` with core's `propose`, then runs core's `dryRunAdoption` against the current prototype and returns its verdict or refusal. Drafting again with the same id replaces an open draft. |

Every change goes through core's `parsePrototype` and becomes a new revision at once (no debounce), so the frames re-render and the checks run again. `run_checks` and the checks after a round come from `measure.ts`, which resolves only with a report of the app's current source for which every frame answered, using the session's revisions: a report of older source is never returned, and if the source changes while frames measure it waits for the newer revision. The agent cannot approve, decline or adopt a proposal: there is no tool for it. An open proposal shows in the chat and in the Project view; approving is the next milestone.

### Undo

The first change a turn makes records the prototype as it was before it. **Undo this turn** puts that prototype back as one new revision, for the latest turn that changed the prototype and is not undone yet, so turns undo one after another, newest first. The agent is told in its next message.

### The key

- Entered in the chat, it is held in the app's memory by `KeyVault` and used only for the `Authorization` header of requests to api.anthropic.com.
- By default it is kept for the session: a reload or a new tab asks again. **Remember on this device** also stores it in this origin's IndexedDB, in its own database `design-harness-key` (store `keys`), never in the project database. **Forget the key** deletes it from memory and the device. The settings say which of the two it is, show its first characters and last four, and say where the chat is stored.
- It is never written into a prototype, the project config, a chat record, an export, a frame's document, a log or an error message: errors pass through `redact`, which replaces the key, and anything shaped like one, before anything is shown. Frames have an opaque origin, so they cannot read the app's memory or open its databases.
- The end-to-end test "the key is in no frame, export, project storage, page storage or log" proves it in Chromium: with the key remembered and a turn done, each of the 8 frames' documents and string globals hold no key and reading the parent or IndexedDB throws `SecurityError`; no frame `srcdoc` has it; the export has none; the project database (which holds the chat) has none, nor do `localStorage` and `sessionStorage`; the console never printed it; the key database has it until **Forget**, after which it is empty and a reload asks again.

### Storage

The chat of each prototype is saved in the `chats` store of `design-harness` (keyed by project and prototype; the database moved to version 2 to add it): the API history and what the chat shows per turn, with its usage, cost and the prototype before the turn for undo. Model and effort are in `localStorage`. An open proposal is saved in the project config, like any proposal.

### Built with Todae

The chat is Todae's `Conversation` (it follows the newest message while it streams and offers a scroll-to-latest button), `Message` (user and assistant turns, `streaming` while a reply arrives, actions for usage and undo), `Disclosure` for thinking, tool calls and checks, `CodeBlock` for tool input and results, `Alert` for errors, refusals, the round limit and proposals, `Badge`, `Checkbox`, `Field` (`TextInput` for the key, `Textarea` for the message, `Select` for model and effort), `ErrorMessage`, `Label`, `Loader`, `Stack`, `Text` and `Button`. What Todae lacked, done in `app.css`: a bordered compact row for a tool call, a check or a thinking summary (Disclosure has no bordered variant), and a code block that wraps and caps its height rather than scrolling sideways in a narrow column. `Message.Time` was not used: it takes a `Temporal.ZonedDateTime`, which the browsers here do not all have.

### Verified against a fake API only

Nothing in this repository has called the real Anthropic API, and no real key was used. `e2e/fake-anthropic.mjs` writes scripted replies in the API's server-sent-event format (message_start, content blocks with text, thinking and signature deltas, tool input as `input_json_delta` fragments, message_delta with the stop reason, `stop_details` and usage, message_stop) and error bodies. Unit tests feed it to the real SDK through a scripted `fetch`. The end-to-end tests serve it over HTTPS with a throwaway certificate and CORS, and launch Chromium with `--host-resolver-rules` mapping `api.anthropic.com` to it and no proxy, so the built app, unchanged, talks to the API's real address and only the fake answers; the tests also check what the fake received (headers, model, effort, thinking, tool choice, fallbacks, that each request extends the last). They cover: an edit whose frames and checks follow; a second primary action whose failing check reaches the agent, and a fix that passes; a proposal saved open with its dry run, surviving a reload; stopping mid-stream; an auth error and a refusal; undo; and the key's absence from frames, exports and storage. What only the real API can show is untested: that it accepts this exact request (the beta names, `fallbacks: "default"`, `display: "summarized"`, the tool schemas), real streaming timing, real refusal and fallback behaviour, prompt caching hit rates, and the costs shown.

## Storage and the project file

IndexedDB database `design-harness`: `projects` (by id) and `prototypes` (by project and id). What is read back is validated with core again, and a record that no longer validates is reported, not loaded. Export writes `<project id>.design-harness.json`:

```json
{ "format": "design-harness/project", "version": 1, "project": { "...": "the ProjectConfig" }, "prototypes": [{ "id": "booking", "name": "Booking", "prototype": { "...": "the Prototype" } }] }
```

Import refuses the file whole on any problem, listing every one with its path (core's config and prototype validation, unknown fields, duplicate ids), and otherwise replaces the stored project of that id with exactly the file's prototypes.

## Dependencies

Runtime, each for one job:

| Package | Why |
| --- | --- |
| `@design-harness/core` | The checks, validation and the extractor. |
| `react`, `react-dom` | The app's UI, and the React frames render with. |
| `@tounsoo/todae` | The app's own components and stylesheet (and Nook's library). The chat uses its `Conversation`, `Message`, `Disclosure`, `Alert`, `Badge`, `Checkbox`, `Field`, `Label`, `Loader`, `Stack`, `Text` and `Button`. |
| `@anthropic-ai/sdk` (1.10.0, exact) | The Messages API client: streaming, the stream accumulator, typed errors. Only its base client and the beta Messages resource are imported, about 160 kB minified (50 kB gzipped) with the 10 kB of `@opentelemetry/api` it imports; the full client would be 381 kB. Its other dependencies (`standardwebhooks`, `json-schema-to-ts`) stay out of the build. |
| `sucrase` | TSX to JavaScript in the browser (above). |
| `@babel/parser` | Already in core; finds import specifiers to rewrite. |
| `dom-accessibility-api` | The accessible-name computation in the frame (12 kB minified). |

Development only: `@types/react`, `@types/react-dom`, `fake-indexeddb` (storage and key tests in Node). Playwright is not a dependency: `e2e/run.mjs` uses the `playwright` package and Chromium the environment provides.

Size of `npm run build`, in kB of 1000 bytes: the app's JS is 1,292 kB minified, 368 kB gzipped (Todae, React DOM, core with `@babel/parser` at 318 kB, sucrase at 206 kB, the Anthropic SDK at 160 kB, and the frame runtime as text: boot script 23 kB, page kit 2.5 kB); its CSS 284 kB, 38 kB gzipped, nearly all Todae's. The agent milestone added 244 kB minified and 76 kB gzipped to the JS (the web shell's build was 1,048 kB and 292 kB): the SDK, the chat and the agent, and core's source scan. The local package source adds 907 kB, 239 kB gzipped, fetched once per session: Todae 405 kB, React DOM 215 kB, React 11 kB, Todae's CSS 276 kB.

## Known gaps

- esm.sh is unverified (above). The local source serves only installed versions and root entries.
- A prototype's measurements are trustworthy only as far as core's `no-ambient-globals` rule and the frame's CSP reach (Isolation, above): the rule reads names in the source, not run-time values a library part hands a callback.
- The code view is a textarea with one marked line.
- The agent has been run only against the fake API (The agent, above).
- The chat renders the agent's text as plain text, not Markdown.
- Undo restores the prototype as it was before a turn; an edit made by hand in the code view after that turn is undone with it.
- A project stored before this milestone keeps its own copy of the rules, without `no-ambient-globals`: the seed has it, and a stored project gets it by importing a config that has it (or, later, by a proposal).
- The default shell is generic: no per-page-type shell code and no prototype-wide frame yet.
- Rendered measurements depend on the browser: fonts and scrollbar style differ between machines, so a report is reproducible on one browser and machine, not across them.
- The end-to-end tests are not in CI (see AGENTS.md).
