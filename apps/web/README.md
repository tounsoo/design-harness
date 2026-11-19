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

The canvas is the product, and everything else is a panel around it: the chat on the left, the checks and code on the right, each collapsible and resizable.

- **Header:** the project (a picker once the browser holds more than one) and prototype, a quiet badge for the prototype's format (Spec or TSX; its tooltip says which), the Canvas, Variants, Project and Proposals views (the Variants tab shows how many variants the open prototype has, the Proposals tab how many proposals are open), New prototype, New project ([New project](#new-project)), and icon buttons, named in their tooltips, for Export (the project file), Import and Export code (the open prototype as a runnable React project, [Code export](#code-export)), then Canvas only and the panel toggles. New prototype makes an empty prototype with a name, a spec by default; TSX is one choice away (and the default only when the project's library has no part description to check specs against). Prototypes already in the project keep their format.
- **Panels:** the chat and the checks and code sit in Todae Splitters, after Todae's app-shell recipe. Each hides and shows from its header button, its own close button, Enter on its handle, or a shortcut: Ctrl+B (⌘B on a Mac) for the chat, Ctrl+Alt+B (⌥⌘B) for checks and code. Drag a handle, or focus it and use the arrow keys, to resize. Whether each panel is open and how wide it is are kept per viewer in this browser's localStorage (`design-harness.panels`) and restored on load; blocked storage only means they last for the visit.
- **Canvas only:** the header and both panels step aside, and a floating bar keeps the prototype's name, zoom, a quiet verdict and **Show panels**. Ctrl+. (⌘.) or the header's button turns it on and off, and Escape leaves it. Focus moves to Show panels on the way in and back to the toggle on the way out, and a screen reader hears each change.
- **Canvas:** the frames as artboards on a dotted board, one row per scenario, named the way a designer names a screen, by page and state ("Booking, room held", with the scenario's own name, "Lantern held", beside it), and one artboard per view ("Desktop 1280 × 900"), each a live render scaled to fit. A badge shows only while a frame measures or when it failed. Zoom is Fit, 25, 50, 75 or 100%, with zoom out and in buttons. The open button on an artboard shows it at full size, in place.
- **Checks:** a summary first ("Everything follows the project's rules", or "3 things to fix"), then one card per failing rule: the rule in plain words (its description, with the project's caps written as their values), core's message for the place shown word for word beside it, every place it was found by scenario and view or by file and line, **Show me** (the outline in its frame, or its line in the code) and **Ask the agent to fix** (a message put in the chat, to edit and send), with the rule's id and type and every finding as core wrote it under Details. Every rule in force, in core's order with its status and findings, and core's report as JSON, sit under one more Details. A finding inside a spec layout instance opens the layout's element, with a button for each layout use above the code. Selecting a finding about elements in the source (core's `targets`, such as both primary actions of a page with two, or an element inside a layout instance) outlines each of them in every frame that draws them, and says under the finding (on its card, and in the Details list) where it is outlined and in which scenarios it is not drawn ([Element tags](#element-tags)); **Show in code** beside it opens its file at its line. A finding about a whole page has nothing to outline and opens its code at once. A finding inside a spec layout instance opens the layout's element, with a button for each layout use above the code, so the page's use (or, for an element passed into a slot, where the layout places it) is one click away. The report is also there as JSON.
- **Code:** a tab behind the checks: each prototype file and `manifest.json` in a plain editor. An edit is a new revision 300 ms after typing stops: the frames re-render and the checks run again. Edits are saved in the browser.
- **Variants:** a spec prototype's variants side by side with the page as it is, each measured in frames with core's report under it, and the slot-by-slot pick ([Variants](#variants)).
- **Project:** read-only, for a designer first: what a prototype can use, the rules in force in plain words (each opens to its id, type and data), the tasks and limits the rules read, the proposals, and every adopted proposal's examples re-run on demand; the library's role mapping and the views are under Technical details. For a spec prototype it starts with the prototype's layouts: each drawn alone with its examples in a frame of its own (core's `layoutPreview`), where the prototype draws it, and its parameters (type in core's words, required or not, default or example, description) under a disclosure.
- **Proposals:** every proposal, and each one's review page, where you approve, decline, send back or adopt it ([Reviewing a proposal](#reviewing-a-proposal)).
- **Agent:** the chat (below). Add a key, then describe a change, or start from a suggestion. Each tool call reads as one line in plain words ("Changed the booking page") that opens to its tool, input and result; the checks the app ran after a change read the same way ("Checked the rules: all good"); each reply's thinking, tokens and approximate cost are under its Details, beside **Undo this turn**. **Stop** stops it at any time.

Nothing in the app decides pass or fail. It renders frames, collects what they painted, and hands both the prototype and the snapshots to `checkPrototype`. The report it shows is core's.

## Where things are

| Path | What it is |
| --- | --- |
| `src/app/` | The UI: `App` (open the store and the key vault, seed, migrate), `Workspace` (layout, edits, selection, the agent's host, picks and their undo, code export), `Board`, `VariantsView` (variants side by side and the pick), `ChecksPanel`, `CodePanel`, `ProjectView`, `LayoutsView` (a spec prototype's layouts and their previews), `NewPrototype` and `new-prototype.ts` (a new prototype, spec by default), `ChatPanel`, `ProposalsView` (the list), `ProposalPage` (a proposal's review page), `proposal-parts.tsx` (status and class badges, a rule in words), `sessions.ts` (prototypes measured in frames of their own), `panels.ts` (the panels' state kept per viewer), `shortcuts.ts`, `words.ts` and `chat-words.ts` (plain words for screens, scenarios, rules, places, tool calls and checks), `app.css` (layout only, in the `app` cascade layer after Todae's) |
| `src/app/ProjectWizard.tsx`, `WizardRoles.tsx`, `wizard-model.ts`, `projects.ts` | New project: the wizard's page and steps, the role cards with their live frames, the wizard's state as core's answers (pure), and which project this browser had open last |
| `src/libraries/registry.ts` | The component libraries this deployment ships: each described and vendored, with how a project loads it |
| `tokens/` | The design-harness token layer on Todae's tokens, a DTCG resolver: `npm run tokens` builds it into `src/theme/todae-theme.css` with Todae's `todae-tokens`, and a unit test fails when that file is stale |
| `src/review/` | The review's logic, pure: `actions.ts` (approve, decline with a note, send back, adopt on a measurement), `timeline.ts` (the history and who "you" is), `diff.ts` (the inventory diff) |
| `src/agent/` | The agent: `request.ts` (client, system prompts, request), `tools.ts` (tool definitions and handlers), `spec-tools.ts` (the spec and layout tools), `variant-tools.ts` (the variant tools), `spec-prompt.ts` (the spec mode's catalog instructions), `spec-stream.ts` (a streaming patch drawn on the canvas), `schema.ts` (tool input validation), `history.ts` (the append-only API history), `controller.ts` (the turn loop, stop, retry, undo, saving), `measure.ts` (a report only for fully measured current source), `errors.ts`, `models.ts` (models, effort, prices), `key-vault.ts`, `settings.ts` |
| `src/runtime/session.ts` | One prototype's check loop: revisions, frames, snapshots, core's report |
| `src/runtime/protocol.ts` | The frame protocol's message types and both sides' validators |
| `src/runtime/frame-document.ts` | A frame's `srcdoc`: sandbox, CSP, boot script |
| `src/runtime/transform.ts` | TSX to ES modules, in the browser, with element tags added after core has read the source |
| `src/runtime/tags.ts` | Element tags: the tag sites of a TSX prototype, a finding's targets as tags, and where a finding is outlined (`planOutline`) |
| `src/runtime/package-source.ts` | Where React and the library come from |
| `src/frame/boot.ts` | The script inside each frame: import map, render, settle, measure, highlight |
| `src/frame/kit.tsx`, `slots.ts` | The page kit, `@design-harness/page`: `Slot`, `PageProps` and the default shell |
| `src/frame/collect.ts` | The rendered-snapshot collector |
| `src/frame/tags.ts` | What each element tag drew, read from React's tree |
| `src/frame/determinism.ts` | The frame's fixed clock and seeded `Math.random` |
| `src/store/` | IndexedDB storage, the project file (each prototype with its variants and picks), and `migrate.ts` (a stored project's missing `library.parts`) |
| `src/export/code-zip.ts` | Code export: core's project files zipped with fflate |
| `src/seed/nook.ts`, `tally.ts` | The seeded project, and the Tally example a person can add |
| `scripts/build-vendor.mjs` | Builds the local package source |
| `e2e/run.mjs` | End-to-end tests |
| `e2e/fake-anthropic.mjs` | The fake Anthropic API the agent's unit and end-to-end tests run against |
| `test/agent-host.ts` | An agent host over plain values, for the tool and loop tests |

## Spec prototypes

The seed holds Nook's booking prototype twice: in TSX, and as json-render specs ("Booking (spec)"). A new prototype is a spec unless the person picks TSX. A spec prototype's frames load React, the library, the page kit, `@json-render/react` (0.23.1, pinned in `JSON_RENDER`) and the spec renderer (`src/frame/spec.tsx`), and get each page as data from core's `resolvePageSpec`, with every layout instance already expanded; no prototype code exists to load. The spec renderer builds a json-render registry over the library that gives each part only the props core's catalog lists. A part that throws while it renders fails its frame with the part's name ("NumberInput could not render: ..."), rather than being drawn as nothing by json-render's own boundary and measured as missing.

Its agent writes specs. The request carries the spec system prompt and, as a second cached system block, the catalog's instructions, which `spec-prompt.ts` writes from core's catalog: the spec format core accepts, layouts with parameters (core's own format: `params`, `$param`, `$scopedId` and instances), and each part with its props, with nothing json-render teaches that core refuses. For Nook that block is 9,471 characters, and the spec system prompt 2,373 (the TSX system prompt is 1,858); json-render's `catalog.prompt()`, which the trial used, was 25,576. The prototype's own layouts are not in the prompt, since they change as the agent works: it reads them with `list_layouts`. Its tools, in place of the file tools:

| Tool | Input | What it does |
| --- | --- | --- |
| `write_spec` | `path`, `spec` | Creates or replaces a spec file, one element per line. |
| `patch_spec` | `path`, `patches` (JSON Patch, one operation per line) | Applies the operations with json-render's patch code, after checking each target exists. While it streams, the canvas draws the draft in place. |
| `list_layouts` | none | The prototype's layouts: id, file, whether the inventory has it, each parameter (type, in words, required or not, default, example, description), and where it is drawn (core's `specLayouts`). |
| `insert_layout` | `path`, `into` (`element`, `slot` on a Page, `index`), `key`, `layout`, `params`, `slots` | Draws a new instance of a layout in a Page's slot or a part's children. |
| `set_layout_params` | `path`, `key`, `set`, `remove`, `slots` | Changes an instance's parameters and fills its slots anew. |
| `propose_variants` | `page`, `variants` (2 to 4, each `note` and `spec`), `like` | Keeps whole pages beside the prototype as variants of one page, each checked by core's `checkVariant` first: if any has an issue, none is kept. Returns each one's id and core's checks of it without frames. |
| `revise_variant` | `id`, `spec`, `note` | Replaces one variant's spec, checked the same way, keeping its id. |
| `list_variants` | none | The variants with their checks, and the picks the person applied. |

The edit tools are checked by core before they apply, with the catalog and each layout's parameters: a change with any issue is refused whole, in core's words, and nothing changes. A new layout file is judged as a layout until `set_manifest` registers it. A layout the inventory lacks is a proposal (`add-layout`, a rule that governs it, and examples whose files hold the layout, its manifest entry and a page that draws it), drafted with `draft_proposal` as any other. [docs/trials/json-render.md](../../docs/trials/json-render.md) has the trial's details, sizes and gaps, and what changed after it.

A project stored before spec prototypes has no `library.parts`. On load the app adds the description it ships for exactly that library version (`src/store/migrate.ts`; today Todae 0.10.1 and 0.11.3) and says so, or says plainly that spec prototypes cannot be checked in that project when it has none; TSX prototypes never need it.

## Variants

Ben's ask was that designers create with guardrails and iterate, and that much of the choosing be a visual pick. Variants are that pick, for spec prototypes.

- **The agent offers them.** Asked for options, it calls `propose_variants` with 2 to 4 complete pages for one page of the prototype, each built only from the catalog and the prototype's layouts, with one line on what is different. Core's `checkVariant` checks each against the catalog before any is kept. They are stored with the prototype (`variants` beside `prototype` in its IndexedDB record and in the project file), apart from its files, so the prototype does not change; they survive a reload and an export and import. The chat shows a card that opens the Variants view.
- **The board shows them side by side.** For the page being compared, the page as it is and each variant get a check session of their own (`useSessions`, as a proposal's examples do): every scenario and view rendered and measured in sandboxed frames, the scenario picked at the top shown and the rest measured out of sight, with core's whole report under each: "every rule passes", or each failing rule with its findings word for word.
- **A pick answers for its own page.** Core's `pickScope` sorts each source's measured report against the prototype's as it is: findings about the picked page (it names the page, one of its scenarios, its file, or a layout its file draws; static and rendered, every scenario and view), findings elsewhere that the change brings or changes (a flow, step-budget or whole-prototype count finding that is not in the prototype's report word for word), and findings another page already had. The first two block; the third never does, and is listed under "Already on another page" in core's words. A rule that ran on the prototype and did not run on the source blocks too. So a prototype whose rooms page fails can still take a pick on its booking page, and the same failure is there after it.
- **A variant with something to fix on the page cannot be picked.** Its radio buttons and its "Every slot from" button are disabled until its measured report is clear for the page. **Ask the agent to fix it** sends the agent a message quoting core's findings and asking for `revise_variant` with its id.
- **Pick by slot.** A table has one row per slot of the page type, and a choice per source; a slot can come from any source that is clear for the page. Core's `recombine` builds the page (keys, literal ids and disagreeing state named for their source, so nothing collides), and the combination is measured in frames of its own and checked like any page. **Apply this pick** is enabled only when the combination is clear for the page in the same sense, where it used to need the whole prototype to pass every rule, measured. It makes the combination a new revision of the prototype, records the pick (when, which source supplied each slot, each variant's note, the page's file before and after) and tells the agent in its next message. **Undo this pick** puts the page back as one more revision, for the newest pick not undone, while the page is still what the pick made.
- **More like this.** From a variant, a note and **Ask for more like this** send the agent a message naming the variant, its note and yours, asking for `propose_variants` with `like` set; the new variants say whose they are like.
- **The agent never picks.** No tool picks, applies or undoes (the tool names hold none of those words, which a unit test checks); `propose_variants`, `revise_variant` and `list_variants` reach the app only through the host's `variants()` and `saveVariants(variants)`, which takes a list of variants and nothing else, so no tool can record a pick or change the prototype's files; every tool's input is a closed object, so `pick` or `apply` in an input is refused; and nothing reads the chat's text for a pick. The end-to-end test "no tool call or chat message can apply a pick" scripts `pick_variant`, a `pick` field, an `apply` field and `undo_pick`, each refused, and a message asking for a pick, and finds no new revision, the page's file unchanged and no pick recorded, before and after a reload.
- **TSX prototypes:** the Variants view says plainly that variants are for spec prototypes, and the TSX agent has no variant tools. Picking by slot needs each page as data; for TSX it would mean rewriting code by its slots, which the extractor can read but not safely write.

Built with Todae: `Card` (each source and the combination), `Table` and `RadioGroup` (the pick), `Badge`, `Alert`, `EmptyState`, `Disclosure` (what another page already had, and the rule ids), `Field` (`Select` for page, scenario and view, `Textarea` for "more like this"), `Label`, `Stack`, `Text` and `Button`. What Todae lacked, done in `app.css`: a grid of columns that hold scaled frames, with the scenarios not shown kept laid out and measuring out of sight, and the red outline on a failing variant's card.

## Code export

**Export code** downloads the open prototype as a runnable React project, `<project>-<prototype>.zip`, built in the browser. Core writes every file (`exportReactProject`; a spec prototype is written as TSX first, a TSX prototype goes in as it is, packages/core/README.md, Code export); `src/export/code-zip.ts` zips them under one folder with [fflate](https://github.com/101arrowz/fflate), deflated, every entry dated the export's time, so the same export is the same bytes. The README in the zip names the project, the prototype, the library and React versions, the time, core's verdict at export, and anything the export could not carry over.

```text
nook-booking-spec/
  package.json          exact @tounsoo/todae, react and react-dom from the project config; Vite, TypeScript and React's types pinned
  README.md             where it came from, and how to run it
  index.html
  vite.config.ts        aliases @design-harness/page to src/page-kit.tsx
  tsconfig.json
  src/main.tsx          the entry: a scenario switcher (?scenario=<id>) and the page shell
  src/page-kit.tsx      Slot, PageProps and the shell that lays out a page type's slots
  src/scenarios.ts      each page with its page type, and the scenarios
  src/shell.css
  src/prototype/manifest.json
  src/prototype/pages/booking.tsx, pages/rooms.tsx
  src/prototype/layouts/room-cards.tsx, room-details.tsx, select-question.tsx
```

Why fflate 0.8.3: it zips synchronously in the browser with no worker or stream plumbing, tree-shakes to what is imported (`zipSync` and `strToU8` are 9.0 kB minified, 4.4 kB gzipped, in the build), has no dependencies, and is maintained (0.8.3 was published 2026-05-16, six months before this milestone, with patch releases for its older lines in July 2026). JSZip (3.10.1, 2022, then 3.10.2 in 2026) is about ten times the size and async; client-zip (2.5.1) streams but stores without compressing, and has no reader for the tests, where fflate's `unzipSync` reads the zip back.

The end-to-end test "export code downloads a zip ..." downloads the zip from the built app, checks its files, unpacks it, builds it with Vite and typechecks it with `tsc` offline (its `node_modules` is this repository's), serves the build, and opens it in Chromium: each scenario renders, the label names its field, the bound answer changes, and nothing is logged as an error.

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
| app → frame | `render` | `generation`, `modules` (bare specifier → `{ url }` or `{ code }`), `styles` (`{ url }` or `{ css }`), `page` (`{ module, export }`), `scenario` (`{ id, state, page }`), `pageType`, `view`, `settleMs`, `tags` (whether to find element tags; false only with untagged modules) | Once per frame document. |
| frame → app | `snapshot` | `generation`, `snapshot` (core's `RenderedSnapshot`), `tags` (the element tags the frame drew: at most 20,000 strings of at most 1,024 characters, empty when `tags` was false; the app keeps them sorted and once each) | The page rendered, settled and was measured. |
| frame → app | `error` | `generation`, `stage` (`load`, `render` or `measure`), `message` (at most 2000 characters) | The page could not be loaded, threw while rendering, or never stopped changing. |
| app → frame | `highlight` | `generation`, and either `element` (an index into the last snapshot's `elements`, or `null` to clear) or `tags` (1 to 256 element tags, each 1 to 1,024 characters), never both | A finding was selected: a rendered one by its index, one about source elements by its targets' tags, each drawn with the same overlay. |
| app → frame | `redraw` | `generation`, `spec` (a spec page's payload, as `render`'s `page.spec`) | A spec frame draws a draft in place while the agent's patch streams, or its own spec again after: no new document, no snapshot. A TSX frame ignores it. |

A frame renders once. A new revision gets a new document, so no module, import map or state carries over from the last one. The one exception is a spec frame's `redraw`: the streaming preview of a `patch_spec` is drawn in the frames already on the board as a React update, so a streaming patch takes one revision (the patch, once it applies) instead of one per preview, and frames do not go blank. A redraw is a picture: it is never measured or checked, and the revision's report stays that of the prototype it was made for. The app waits for every frame of a revision to send a snapshot or an error, or to time out after 20 s, then runs core's checks with the snapshots it has; a scenario and view without one is core's "not measured" finding, so a frame that fails fails the rendered rules rather than passing them.

## Element tags

A finding about elements (core's `Finding.targets`, packages/core/README.md, The report) is outlined in every frame that draws them. For that, each frame knows which spec or source element each part of its page came from.

- **The tag.** One prop, `data-dh-source`, on the React element of a library part, a page kit part or an HTML element. In a **spec** prototype the spec renderer passes each part its key in the expanded page, which carries the layout instance's scope (`details/summary` is the room details instance's summary), and each of a Page's slots `<page key>/slots/<name>`; json-render hands a part its element but not its key, so the renderer stores the key on each element first. In a **TSX** prototype the transform adds the prop as the last attribute of each JSX element, after core has read the source: `file:line:column`, exactly core's location of that element, for a library part, a kit part or an HTML element (read from core's model of the source), and `undefined` for one of the prototype's own components or a tag core could not name. Core reads the files as written and code export writes them as written, so neither ever sees a tag.
- **Where it lands.** The frame never reads tags from the DOM. After the page settles and is measured, `frame/tags.ts` walks React's tree from the root: the outermost fiber carrying a tag owns it, and the tag's elements are the outermost DOM elements under that fiber, across portals. A part that renders one element gives that element; one that renders several gives all of them; one that renders only other parts (a provider), their outermost elements; one that renders nothing, none, so the tag is not drawn. A fiber below with the same tag (a part passing its props on to an inner part or to the DOM, as Todae's do) adds nothing. The snapshot message carries the drawn tags; an outline request is answered by walking the tree again, so a spec redraw is followed. An element that is not drawn, such as one in a closed disclosure, is outlined around its nearest drawn ancestor.
- **Matching.** A target's tag is its `key` (spec) or `file:line:column` (TSX). `planOutline` outlines a finding in every measured frame of a scenario on the target's page (any page, for a target core read from the source with no page) that drew one of its tags, and lists the scenarios that could show it and drew none, which the Checks panel says ("Not drawn in scenario lantern-booked"). A finding about several elements outlines all of them.
- **Measurement is unchanged.** The prop is a `data-` attribute where a part passes it to the DOM, which has no layout or accessibility-tree effect, and tags are found after the snapshot is taken. The end-to-end test "element tags change nothing a rule measures" renders Nook's TSX and spec prototypes with tags and again with `?frame-tags=off` (untagged modules, no prop passed, no tags found) and gets identical snapshots in all 16 frames, the tags apart.
- **Prototype code cannot read or forge them in a way that matters.** `no-ambient-globals` refuses every way to a DOM node (`ref`, `document` and every other global, `event.target` and the other event and node paths, `findDOMNode`), so prototype code can never hold an element to read `dataset` or `getAttribute` from; the rule does not name data attributes, and does not need to. Writing a tag as JSX is not a DOM access and the rule does not cover it, so the transform makes the real tag the last attribute of every JSX element (a hand-written `data-dh-source`, or one spread in, is overridden), sets it to `undefined` on the prototype's own components (so they never receive a tag to pass on), and the frame reads tags only from React's props, never from DOM attributes, so an attribute set any other way is ignored. What remains: a library part may hand a render callback its props, tag included, which tells prototype code only its own source position; and a part built with `createElement` gets no tag, which core's `extract` rule already fails. Tags only drive outlines: core never reads them, so no tag can change a check.

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

- **`localPackageSource`** (the default): React, React DOM, json-render and every component library `package.json` lists under `designHarness.libraries` (today Todae 0.11.3 and Mantine's `@mantine/core` 9.7.4, each with the stylesheets a project may name), at the versions installed in `node_modules`, prebuilt by `npm run vendor` into one ES module per specifier. `public/vendor/manifest.json` keys each package by name and exact version, so a project's library and its stylesheet are served by what its config names, and two versions of one library can sit side by side. CommonJS packages get named exports listed from the module itself, and React stays external everywhere, so the library, React DOM and the page share one React. The app reads the files from its own origin and sends their code to the frame, which never fetches. It refuses any other package or version, naming both: "the local package source has @tounsoo/todae 0.11.3, but the project asks for 0.10.1". It serves only each package's root entry, not subpaths such as `@tounsoo/todae/stack`. Serving another library offline is one line in `designHarness.libraries` and the dependency at an exact version.
- **`esmShPackageSource`**: `https://esm.sh/<package>@<version>[/<subpath>]`, with `?external=react,react-dom` on everything but React, so every module imports the React the import map names; stylesheets as `https://esm.sh/<package>@<version>/<path>`. Choose it with `VITE_PACKAGE_SOURCE=esm.sh` at build time or `?packages=esm.sh` on the page; `&packages-origin=<origin>` points it at a mirror with the same URL scheme.

What was verified: the local source, end to end, in every test. The URL path, also end to end: a test serves the vendor build from a second local origin in esm.sh's URL scheme, with CORS, and the app opened with `?packages=esm.sh&packages-origin=...` loads React, React DOM and Todae by URL into the import map, the stylesheet by `<link>`, within the frame's CSP, and the legal prototype passes every rule; another does the same for the Tally project on Mantine. What was not: esm.sh itself. This environment's network policy refuses esm.sh, jsDelivr and unpkg, so whether esm.sh serves these exact URLs, keeps React external as asked for `react-dom/client`, and serves `dist/todae.css` as CSS, is untested.

## The page kit and the default shell

Prototypes import `Slot` and the `PageProps` type from `@design-harness/page`, which the frame provides. `Slot` renders a `<div data-slot="name">` and takes its place from the default shell, which knows the page type from the config and nothing about the library:

- Slots keep the page type's order. A body slot is one neither chrome nor primary, as core counts them. Every slot after the last body slot is the **trail**: an action page's primary slot and its alternates.
- At 600 CSS px and wider, the page is a centred column at most 760 px wide; lead and body slots are full-width rows and the trail's slots sit side by side under the body. Narrower, every slot is a full-width row.
- A slot name the page type lacks still renders, after the known slots, outlined; core's `page-structure` rule reports it.
- The root gets the view's colour scheme as CSS `color-scheme` and, when the config names `library.schemeAttribute` (Todae's `data-appearance`), as that attribute. The shell sets a system font only at zero specificity, so a library's own root font wins.
- When the config names `library.root` (Mantine's `MantineProvider`), the page and the shell render inside that part of the library, with its literal props and the view's scheme in its `schemeProp` (`forceColorScheme`). The render request carries it as `root` (the library's module, the export, the props), and the boot script takes the component from the library module, never from prototype code.

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
  tools, // the ten below, each with eager_input_streaming: true
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
| `draft_proposal` | `id`, `title`, `reason`, `states`, `inventory`, `rules.add`, `rules.remove`, `examples.pass` and `examples.fail` (each `name`, `files`, `remove_files`, `manifest`; a failing one also `flagged_by`) | Saves the proposal as `open` with core's `propose`, then runs core's `dryRunAdoption` against the current prototype and returns its verdict or refusal. An id that exists is refused, pointing to `revise_proposal`. |
| `revise_proposal` | `id`, `note`, and any of the fields `draft_proposal` takes but `id`; each one given replaces that field whole | Revises an open proposal with core's `revise`: the status stays open, and the version it replaces is kept in its history with the note. Runs the dry run again. A proposal that is not open is refused. |

Every change goes through core's `parsePrototype` and becomes a new revision at once (no debounce), so the frames re-render and the checks run again. `run_checks` and the checks after a round come from `measure.ts`, which resolves only with a report of the app's current source for which every frame answered, using the session's revisions: a report of older source is never returned, and if the source changes while frames measure it waits for the newer revision. The agent cannot approve, decline or adopt a proposal: no tool does, no tool's input has a status field (the schemas refuse unknown fields), and nothing reads the chat's text for one. A drafted or revised proposal shows in the chat as a card that opens its review page.

The dry run the agent gets reads source only: it has no frames. A proposal that adds a rendered rule therefore cannot be proven there, and the result says so (`needsMeasurement` on the card, which stays an info card rather than a warning) instead of telling the agent to fix it; the review page measures every example before the person can adopt it.

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

The chat is Todae's `Conversation` (it follows the newest message while it streams and offers a scroll-to-latest button) and `Message` (your turns and the agent's, `streaming` while a reply arrives, actions for undo and details), put together after Todae's message-parts, tool-call, reasoning, message-actions and suggestions recipes: each tool call and check is a `Disclosure` whose summary is a plain line with a status mark, opening to a `DataList` of the tool, its input and its result in `CodeBlock`s; thinking, tokens and cost are in each reply's details; before the first message, suggestions fill the box. The composer is the composer recipe's frame, `Field.Textarea` with a `Field.Row` for Send or Stop, without mentions, which nothing here needs. The key entry is a form of `Field.TextInput`, `Checkbox`, `ErrorMessage` and `Button`, with how the key is kept under a `Disclosure`. What Todae lacked, done in `app.css` with Todae's tokens: the round status mark beside a step, a code block that wraps and caps its height rather than scrolling sideways in a narrow column, and the bordered card for a proposal or variants offered. `Message.Time` was not used: it takes a `Temporal.ZonedDateTime`, which the browsers here do not all have.

### Verified against a fake API only

Nothing in this repository has called the real Anthropic API, and no real key was used. `e2e/fake-anthropic.mjs` writes scripted replies in the API's server-sent-event format (message_start, content blocks with text, thinking and signature deltas, tool input as `input_json_delta` fragments, message_delta with the stop reason, `stop_details` and usage, message_stop) and error bodies. Unit tests feed it to the real SDK through a scripted `fetch`. The end-to-end tests serve it over HTTPS with a throwaway certificate and CORS, and launch Chromium with `--host-resolver-rules` mapping `api.anthropic.com` to it and no proxy, so the built app, unchanged, talks to the API's real address and only the fake answers; the tests also check what the fake received (headers, model, effort, thinking, tool choice, fallbacks, that each request extends the last). They cover: an edit whose frames and checks follow; a second primary action whose failing check reaches the agent, and a fix that passes; a proposal saved open with its dry run, surviving a reload; stopping mid-stream; an auth error and a refusal; undo; and the key's absence from frames, exports and storage. For the review: a drafted proposal opening to its page with its examples side by side and the flagged line marked; approve then adopt, after which the Checks panel runs the new rule and flags a prototype that breaks it; a refused adoption shown in core's words; a decline that needs a note; a send-back that reaches the agent, which revises the proposal (scripted), with both versions in the history; the impact list; a rendered rule adopted on measured snapshots, outlined in its frame, with the same results after a reload; tool calls and a chat message that try to change a status and change nothing; and asking the agent from a finding. For variants: a scripted agent offers three, which render side by side in measured frames with their reports; the failing one cannot be picked until the agent, asked from its card, fixes it; a pick of slots from two variants applies a revision that passes every rule and undoes; "more like this" reaches the agent naming the variant; and tool calls and a message that try to pick change nothing. For spec prototypes: the catalog's instructions and the spec tools in the request, a patch the catalog refuses, a streamed patch drawn in place, a scripted agent that lists the layouts, draws an instance of one and changes its parameters, and a new prototype's agent writing specs by default. What only the real API can show is untested: that it accepts this exact request (the beta names, `fallbacks: "default"`, `display: "summarized"`, the tool schemas), real streaming timing, real refusal and fallback behaviour, prompt caching hit rates, and the costs shown.

## New project

**New project**, beside New prototype, opens a wizard that takes the whole page. A designer names a product, connects the component library it is built with, confirms by eye which of the library's parts play each role the rules read, and gets a project with a starter prototype on the board that passes every rule. Cancel leaves everything as it was. Nothing is saved until Create.

### How the browser gets a library's description

The app is a static site, and two things about a library cannot be made in a browser on one:

- **Its description.** Core's `describe-library.mjs` reads a package's TypeScript declarations with the TypeScript compiler, after installing that exact version with npm so its dependencies and React's types resolve the same on every run.
- **Its code.** A frame loads only what the deployment's package source serves, and its Content Security Policy refuses everything else.

So the first version does what works with no server, and says so:

1. **Pick a library the deployment ships.** `src/libraries/registry.ts` lists each library that is both described (`packages/core/libraries/<name>.json`) and vendored (`designHarness.libraries` in `package.json`): today Todae 0.11.3 and Mantine's `@mantine/core` 9.7.4. Each entry carries what a description cannot say: its stylesheets, the React it renders with, the attribute or root part that switches light and dark, a rule of its own, and props its starter needs to pass the rules (Mantine's buttons are violet, since its default blue under white text is 3.5:1). Mantine's 3 MB description is a chunk of its own, fetched when it is picked (46 kB gzipped). `registry.test.ts` holds each entry to the description file, to `package.json` and to the version installed, and builds a project on it.
2. **Import a description file.** The JSON `describe-library.mjs` writes, validated by core's `parseLibraryDescription`. The person gives its stylesheets, and the part every page renders inside and how it switches schemes when it needs them. This covers a description made outside the deployment, but not the code: leaving the step, the app resolves the library through the package source, and when that refuses (`the local package source has no @acme/ui`) the wizard stops there and says the deployment cannot render it. With `?packages=esm.sh` the source resolves any published package, so an imported description goes on; that path is untested against esm.sh itself ([Where packages come from](#where-packages-come-from)).
3. **Describing in the browser was left out.** It would mean shipping the TypeScript compiler (about 3 MB minified), fetching a package's declarations and those of everything they import from a CDN, and resolving versions without npm's `--before`, so the same package could describe differently on two days. It is neither light nor deterministic yet, and this environment cannot reach a CDN to test it.

Adding a library is a change to the repository, which the wizard spells out under "Use a library that is not listed": the dependency at an exact version and a line in `designHarness.libraries`, a description written by `describe-library.mjs`, and an entry in the registry.

### The steps

Built after Todae's wizard recipe: a `Steps` list for where the person is, a `Form` per step whose Next is its submit button, and focus moved to each step's heading. One thing differs from the recipe, which keeps every step mounted: only the current step is mounted, because a step's previews are live frames and a frame in a hidden form has no viewport to render in. The answers live in the wizard, so Back keeps them.

1. **Name the product.** The id core will give it shows under the field (`projectId`: "Ledger" is `ledger`, a second one `ledger-2`). An aside adds core's Tally example, or opens it when the browser already has it.
2. **Pick the library.** The shipped libraries, or a description file. What the project will say about the library is shown before going on: package, exact version, parts described, stylesheet, React, and each note of the registry entry.
3. **Confirm the roles.** One card per role (action, primary action, secondary action, disclosure, disclosure summary, question):
   - the drafted parts **drawn live** in a frame sandboxed exactly as the board's are (`allow-scripts` alone, the same document, CSP and protocol), with the library's own stylesheet and inside its root part, in the app's light or dark scheme. Core's `rolePreview` writes the one-page spec: an action as a pressable part, a primary or secondary action once per prop value and once with no prop when `whenMissing` (so the person sees what a button with no variant looks like), a disclosure with its summary, a question with its label. The frame shows as much of its view as the page fills;
   - core's confidence as a badge and its evidence, word for word;
   - **what it could be instead** (core's `roleOptions`), under "Pick another part" or "Pick other values": the parts as checkboxes, or every value of the action part's emphasis prop, with one more frame that draws all of them to pick from by eye. The preview follows what is checked.

   A drafted role counts only once **Accept** is pressed (or "Accept all as drafted"). A changed role is a correction and needs a reason, which core's `confirmRoles` refuses without; the refusal shows on the card in core's words. A role left with no part shows what core's `missingRoleEffects` says: the rules that leave the project, each by its description and id, since a config holding a rule that could never fire is refused.
4. **Confirm the style props.** The props core drafts to exclude from specs, with its evidence, as a list to accept or change (uncheck one, or add names and `*` patterns); a change needs a reason.
5. **Starting rules.** Tasks with their step budgets, the two ranked actions, and the four caps, each with a sentence on what it means and core's defaults (`defaultStarterRules`: one task in three steps, "Continue" and "Not now", one question and one disclosure a page, 24 px targets). Then the parts a prototype may use: core's `starterInventory`, changeable, with the parts the roles map to locked in. The page types and views every new project starts with are listed, not editable here.
6. **Review and create.** The project as core built it (`buildProject`), and its starter page drawn in a frame per scenario and view and measured, with core's verdict: "It follows all 32 rules", or each rule that finds something. Create is held until the frames have answered. It stores the config and the starter, opens the board on it, and says so in a notice.

### What decides

Nothing in the wizard decides what is valid. Each Next runs core's `buildProject` on the answers so far and shows the refusals that belong to that step, each beside what it is about (`wizard-model.ts`'s `routeIssue` sorts them by path); Create is reachable only with a config that came back from `buildProject`, which returns one only after `parseProjectConfig` accepts it. The starter is core's too (`starterPrototype`), returned only when `checkPrototype` finds nothing in it; when a library has no part core can tell writes a heading or text, the project is created with an empty prototype and a notice saying why. How each role was decided, reasons included, is kept in the config (`library.confirmed`) and shown under the Project view's technical details.

### Projects

The header's project picker lists every project in the browser's store (it appears with the second one), and switching opens the other project in a fresh workspace. Which project was open last is kept per viewer in localStorage (`design-harness.project`) and restored on load; blocked storage only means the first project opens. An imported project file opens as its own project, and no longer hides the one that was open.

### Built with Todae

`Steps` (progress), `Form`, `Field` (`TextInput`, `Textarea`, `NumberInput`, `Group`), `Label`, `RadioGroup` (the libraries), `Checkbox` (parts, values, props), `Card` (a role, the library's facts, the summary), `Badge` (confidence and standing), `Alert` (refusals, what leaves the project, the verdict), `Disclosure` (the options, the repository steps, the rules in words), `DataList`, `ErrorMessage`, `Button` (Accept is a pressed button), `Code`, `Loader`, `Stack` and `Text`. What Todae lacked, done in `app.css` with Todae's tokens and five sizes added to `tokens/harness.json`: the page itself (a rail beside a scrolling step with actions that stay in reach), a radio option with a second line, a scrolling grid of checkboxes, the role card's frame on the canvas colour, and a row of an input with its button.

## Reviewing a proposal

The Proposals view lists every proposal: title and id, status, core's classification (only adds, tightens, or loosens or removes), who drafted it and when, and its examples, filtered by status with a count on each filter. The Proposals tab shows the number of open proposals as a badge, and nothing else asks for attention. A proposal opens to its review page from the list, from the chat's card, or from the Project view.

### The page

- **Header and actions.** Title, status, classification, id, who drafted it and when. The actions are a sticky bar with core's adoption dry run beside them: Approve (open), Adopt (approved), Send back to the agent (open), Decline. Each is a deliberate click; decline and send back open a note form and refuse to go on without a note. Every status change goes through core's lifecycle and is stamped with the time and `by: "you"`: there is one user, and the field is kept for accounts. A refusal is shown in core's words with its code, the example it names (a button scrolls to it), and for an earlier adopted proposal's broken example, that proposal (a button opens its page), with its findings.
- **Why.** The reason and the state notes.
- **What it changes.** The inventories and rule inputs before and after, from core's `applyProposal` on the config as it is (`src/review/diff.ts`): lists as badges, with what is added or removed marked, and changed rows (caps, tasks, page types, ranking, roles) as before and after. Each rule it adds or removes in core's `describeRule` words, its author's description under them, and its data one click away.
- **Examples.** Passing examples on the left, failing on the right, each a card with its frames at the chosen scenario and views (below), core's verdict as a badge ("passes", "fails for one-toast-per-page alone", "does not behave"), core's words for what happened, and the findings. On a failing example, a rendered finding is outlined in its frame with the board's own highlight (the frame's overlay), and a source finding's line is shown marked, as the code view marks it. The scenario picker opens on the scenario the first failing example is flagged in.
- **Impact on the project.** Core's adoption check against every prototype in the project, each measured: the prototypes that would newly fail, with the findings, and Open on the board, which shows the prototype and points at the finding. When the dry run refuses (an example misbehaves), the impact still comes from core's `newlyFailingOf` with the proposal applied.
- **Classification**, change by change with core's reasons, and **History**: every status change, revision and send-back, by whom and when, with its note; a revision opens to the version it replaced.

Once adopted, the page says which rules are in force and what the re-check of every prototype found; the open prototype's checks run again at once with the new rule, and the Checks panel shows a rule without a description in core's words. An adopted proposal's examples are judged with core's `rerunExamples`, on the snapshots stored at adoption.

### How examples are rendered and measured

Each example is a prototype. `useSessions` (`src/app/sessions.ts`) gives each one a check session of its own, the same `Session` the board uses, with the same frame documents, sandbox, protocol and collector: one frame per scenario and view, rendered with the proposal applied to the config (so a component or page type it adds is there). A session is keyed by a hash of everything a frame's paint depends on: the library, its version and stylesheets, the views, the page types and the example's source. When a revision changes an example, its key changes, a new session measures it from scratch and the old one is dropped, so no measurement is ever reported for content it was not taken of. Frames of other scenarios stay laid out, hidden, so every scenario is measured, not only the one shown. The project's other prototypes are measured the same way for the impact; the open prototype's snapshots are the board's.

The verdicts wait for a complete measurement: until every frame of every example has answered with a snapshot, the cards say how many have, and Adopt is disabled with the reason beside it. A frame that fails or times out leaves its example "not measured", and core's `withExampleSnapshots` would refuse the partial measurement anyway, so adoption never runs on one.

### Where the adoption snapshots are stored

With the proposal, in the project config: Adopt calls core's `withExampleSnapshots` with the measurement, which stores each example's snapshots on the example (`examples.pass[i].snapshots`, `examples.fail[i].snapshots`, core's existing optional field), and then core's `adopt` on that config, which keeps them on the adopted proposal. The config is saved to IndexedDB and goes into the export. Re-running the examples later, on the Project view or after a reload, reads those snapshots: nothing is rendered again, and the end-to-end test checks that no example frame exists while it re-runs and that the results equal the ones at adoption.

### Send back, and the agent's revision

Send back records the note in the proposal's history (core's `sendBack`) and sends it as the person's next chat message, naming the proposal and asking for `revise_proposal`. It needs a key and an idle agent; the page says which is missing. The agent revises with `revise_proposal`, which keeps the history; the chat shows a "Proposal revised" card, the open review page follows the new version, and its examples are measured again.

### Asking the agent to propose

A failing check whose finding is about something outside the inventories (a membership rule over components, page types, layouts or flow states) offers "Ask the agent to propose this" in the Checks panel, when a key is set. It puts a message into the chat's box, quoting core's finding and where it is, for the person to edit and send; it never sends on its own.

### Built with Todae

The review uses Todae's `Card` (actions, example cards, impact), `Table` (the list, rows of the diff, the classification, the re-run examples), `ToggleGroup` (filters), `Badge`, `Steps` (the history), `Disclosure` (rule data, earlier versions), `Alert` (refusals, the adopted notice), `DataList`, `EmptyState`, `Field` (`Textarea` for notes and the read-only marked excerpt, `Select` for scenario and view), `ErrorMessage`, `Label`, `Code`, `Stack`, `Text` and `Button`. What Todae lacked, done in `app.css`: two columns of example cards that hold scaled frames, a before-and-after layout for the diff, a sticky action bar, and a read-only code excerpt sized to its lines. `ToggleGroup` wraps each text child of an item in its own span, which splits the button's accessible name, so each filter label is one string.

## Storage and the project file

IndexedDB database `design-harness`: `projects` (by id) and `prototypes` (by project and id). What is read back is validated with core again, and a record that no longer validates is reported, not loaded. Export writes `<project id>.design-harness.json`:

```json
{ "format": "design-harness/project", "version": 1, "project": { "...": "the ProjectConfig" }, "prototypes": [{ "id": "booking", "name": "Booking", "prototype": { "...": "the Prototype" } }] }
```

Import refuses the file whole on any problem, listing every one with its path (core's config and prototype validation, unknown fields, duplicate ids), and otherwise replaces the stored project of that id with exactly the file's prototypes. It then opens that project; the other projects in the browser stay as they are ([Projects](#projects)).

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
| `fflate` (0.8.3, exact) | Zips the code export in the browser ([Code export](#code-export)): 9.0 kB minified, 4.4 kB gzipped, of it in the build. |

Development only: `@types/react`, `@types/react-dom`, `fake-indexeddb` (storage and key tests in Node), and at the root `playwright` 1.63.0, exact, for `e2e/run.mjs`. CI installs its Chromium (`npx playwright install --with-deps chromium`); a local run uses the Chromium at `/opt/pw-browsers/chromium` when it is there, and Playwright's own otherwise.

Size of `npm run build`, in kB of 1000 bytes: the app's JS is 1,292 kB minified, 368 kB gzipped (Todae, React DOM, core with `@babel/parser` at 318 kB, sucrase at 206 kB, the Anthropic SDK at 160 kB, and the frame runtime as text: boot script 23 kB, page kit 2.5 kB); its CSS 284 kB, 38 kB gzipped, nearly all Todae's. The agent milestone added 244 kB minified and 76 kB gzipped to the JS (the web shell's build was 1,048 kB and 292 kB): the SDK, the chat and the agent, and core's source scan. The proposal review milestone took the JS from 1,292 kB to 1,351 kB minified (+59 kB) and from 368 kB to 385 kB gzipped (+17 kB), and the CSS from 284 kB to 286 kB (38 kB gzipped): the Proposals view and review page, the review logic, and core's rule words and lifecycle additions. It adds no runtime dependency. The json-render trial took the JS to 1,449 kB minified (404 kB gzipped); layouts with parameters took it to 1,505 kB (421 kB gzipped): core's parameters and expansion (about 20 kB), the layouts view, New prototype, the layout tools, the catalog instructions and the redraw. Variants and code export took it to 1,582 kB minified (447 kB gzipped), +77 kB and +27 kB: core's variant checks, recombination and TSX writer (about 43 kB), the Variants view, the variant tools, the code export with fflate (9 kB of it), and the stored variants; the CSS to 287 kB. The chunk loaded on a spec agent's first patch, json-render's core with zod, is 171 kB (51 kB gzipped); the prompt no longer needs it, and the 7 kB catalog chunk is gone. The local package source adds 907 kB, 239 kB gzipped, fetched once per session: Todae 405 kB, React DOM 215 kB, React 11 kB, Todae's CSS 276 kB. Library onboarding adds Mantine to it, fetched only by a project on Mantine: `@mantine/core` 9.7.4 with `@mantine/hooks` bundled in, 652 kB (201 kB gzipped), and its `styles.css`, 295 kB (42 kB gzipped); the app's own JS goes to 1,589 kB minified (449 kB gzipped), +7 kB and +2 kB, for core's unknown props and root part and the frame's part boundary. New project takes the app's JS from 1,709 kB minified (474 kB gzipped), which is where the canvas-first redesign on Todae 0.11.3 left it, to 1,737 kB (485 kB gzipped), +28 kB and +10 kB, for core's project builder and the projects switcher; the wizard itself is a chunk of 72 kB (23 kB gzipped) loaded when it opens, Mantine's description one of 1,853 kB (46 kB gzipped) loaded when Mantine is picked, and the Tally example one of 87 kB (6 kB gzipped) loaded when it is added. The CSS goes from 310 kB to 317 kB (42 kB gzipped).

## Known gaps

- esm.sh is unverified (above). The local source serves only installed versions and root entries.
- Element tags (above) read React's fiber tree (`child`, `sibling`, `tag`, `stateNode`, `memoizedProps`, the fiber root's `current` and the container's `__reactContainer$` key), fields React has kept since 16 and 17 but does not document; another React could need `frame/tags.ts` to change, and until then frames would report no tags and findings would say they are not drawn.
- A TSX element is tagged by where it is written, so a finding about one render of a component drawn twice on a page outlines both; a spec element in a repeat over a known list is one key, so a finding about one item outlines every item. Spec layout instances have keys of their own, so two instances never share an outline.
- A finding about code rather than an element (`no-ambient-globals`, imports, extraction problems) and a finding about an element core cannot name have no targets and point at the code only.
- The outline is sent when a finding is selected; a frame that finishes measuring later is not outlined until the finding is selected again.
- A layout parameter cannot stand in a `visible` condition or inside a `$template`; the page gives the whole prop's value instead.
- A new prototype starts empty; the agent or the code view builds its first page and flow.
- New project uses a library the deployment ships, or an imported description of one its package source can load; a library the deployment does not serve stops at the library step ([New project](#new-project)). The wizard does not keep its answers across a reload.
- A role's preview is composed from part names (a family's root around its item, a summary beside a panel, a label for a field). A library built another way may not draw, and the frame then says which part could not render; the mapping can still be confirmed.
- The wizard asks for tasks, ranked actions and caps. Page types, views, disclosed sections and layouts start from core's fixed set, and change afterwards by proposal or by importing an edited project file.
- Opening New project closes the open workspace, so an agent turn that is running stops, as it does on a reload.
- A project cannot be renamed or deleted in the app yet.
- A prototype's measurements are trustworthy only as far as core's `no-ambient-globals` rule and the frame's CSP reach (Isolation, above): the rule reads names in the source, not run-time values a library part hands a callback.
- The code view is a textarea with one marked line.
- The agent has been run only against the fake API (The agent, above).
- The chat renders the agent's text as plain text, not Markdown.
- Undo restores the prototype as it was before a turn; an edit made by hand in the code view after that turn is undone with it.
- A project stored before this milestone keeps its own copy of the rules, without `no-ambient-globals`: the seed has it, and a stored project gets it by importing a config that has it (or, later, by a proposal).
- The default shell is generic: no per-page-type shell code and no prototype-wide frame yet.
- Rendered measurements depend on the browser: fonts and scrollbar style differ between machines, so a report is reproducible on one browser and machine, not across them.
- The review page measures every example in every scenario and view, so a proposal with many examples renders many frames at once (Nook: 8 per example); nothing yet limits how many.
- The agent's dry run reads source only, with no frames: for a rendered rule, the first verdict with measurements is the review page's. The same holds for the checks `propose_variants` returns: the Variants view measures them.
- Variants and slot picks are for spec prototypes only. The Variants view renders every source in every scenario and view (Nook, three variants and a combination: 40 frames), and nothing yet limits how many.
- Recombination takes each slot's elements as the source lists them; elements outside every slot are left out unless every slot comes from one source.
- Code export writes what core read: a part of a spec the catalog refused is not in the export, and its README says so.
- The project's other prototypes are measured for the impact while a review page is open, but only the open prototype is re-checked on the board after an adoption; another prototype's checks run when it is opened.
- A send-back is recorded in the history before its chat message is sent; if the request then fails, the note stays recorded and the turn shows the error, with Retry where it helps.
- An adopted proposal's examples keep the snapshots measured at adoption: if the project's views or library change later, re-running them reports the missing views as not measured rather than measuring again.
