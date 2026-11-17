# @design-harness/web

The design-harness app: a project's prototype rendered as a board of live frames, with `@design-harness/core`'s checks beside it. It runs entirely in the browser. A static build works with no backend, and projects are kept in the browser's IndexedDB.

This milestone is the shell and the canvas. There is no agent yet: the left panel is reserved for its chat, and a plain code view stands in for it.

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
- **Agent:** a reserved panel that says the chat is not available yet. There is no model or API-key code anywhere.

Nothing in the app decides pass or fail. It renders frames, collects what they painted, and hands both the prototype and the snapshots to `checkPrototype`. The report it shows is core's.

## Where things are

| Path | What it is |
| --- | --- |
| `src/app/` | The UI: `App` (open the store, seed), `Workspace` (layout, edits, selection), `Board`, `ChecksPanel`, `CodePanel`, `ProjectView`, `ChatPanel`, `app.css` |
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
| `@tounsoo/todae` | The app's own components and stylesheet (and Nook's library). |
| `sucrase` | TSX to JavaScript in the browser (above). |
| `@babel/parser` | Already in core; finds import specifiers to rewrite. |
| `dom-accessibility-api` | The accessible-name computation in the frame (12 kB minified). |

Development only: `@types/react`, `@types/react-dom`, `fake-indexeddb` (storage tests in Node). Playwright is not a dependency: `e2e/run.mjs` uses the `playwright` package and Chromium the environment provides.

Size of `npm run build`, in kB of 1000 bytes: the app's JS is 1,048 kB minified, 292 kB gzipped (Todae, React DOM, core with `@babel/parser` at 318 kB, sucrase at 206 kB, and the frame runtime as text: boot script 23 kB, page kit 2.5 kB); its CSS 282 kB, 37 kB gzipped, nearly all Todae's. The local package source adds 907 kB, 239 kB gzipped, fetched once per session: Todae 405 kB, React DOM 215 kB, React 11 kB, Todae's CSS 276 kB.

## Known gaps

- esm.sh is unverified (above). The local source serves only installed versions and root entries.
- A prototype's measurements are trustworthy only as far as core's `no-ambient-globals` rule and the frame's CSP reach (Isolation, above): the rule reads names in the source, not run-time values a library part hands a callback.
- The code view is a textarea with one marked line, by design for this milestone.
- The default shell is generic: no per-page-type shell code and no prototype-wide frame yet.
- Rendered measurements depend on the browser: fonts and scrollbar style differ between machines, so a report is reproducible on one browser and machine, not across them.
- The end-to-end tests are not in CI (see AGENTS.md).
