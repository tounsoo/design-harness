# Trial: prototypes as json-render specs

Question: would design-harness be more solid if a prototype were a [json-render](https://github.com/vercel-labs/json-render) spec instead of TSX?

Branch `claude/json-render-trial` builds a second prototype format beside TSX, end to end: core reads and checks it, the board renders and measures it, the agent writes it, and proposals work on it. This page is the decision and the evidence. "Verified" means a test or a command in this branch shows it; "inferred" means read from source or docs and not run.

## Recommendation: keep both, own the format, keep json-render at the edges

Do not switch, and do not drop the spec format.

- **Keep the spec format** as a second prototype format, and make it the one the agent writes for new prototypes once layouts can take parameters (see What got harder). It closes the frame's measurement loophole by construction and makes every check more precise, and every rule ran on it unchanged.
- **Keep TSX** for what a spec cannot say yet, and because existing TSX prototypes cannot be converted to specs.
- **Own the spec format and its validation in core**, as this branch does. Use json-render only where it earns its place: its React renderer in the frame and its catalog prompt and stream compiler in the agent. Pin it exactly and keep it behind the four small modules listed under Maturity.

The three strongest pieces of evidence:

1. **The loophole closes by construction.** A spec frame imports React, React DOM, Todae, json-render, the page kit and the spec renderer, and no prototype module (verified: e2e "a spec frame loads ... no prototype code" reads every frame's import map). 13 of the 41 illegal TSX fixtures cannot be written as a spec at all, all 7 `ambient-*` ones among them, and 5 more are refused by the catalog before any rule runs. The 1,849 lines of extractor and source scan, and `@babel/parser` and sucrase, are not on the spec path.
2. **The rules carry over unchanged.** A spec becomes core's existing `PrototypeModel`, so all 33 rules run with no change to the engine (`check.ts` gained one line). The legal Nook spec passes all 33 with real measured frames (verified, e2e), 23 ported illegal specs fail for their one named rule (verified, unit tests), and the Toast proposal is refused, then adopted, and then flags a fresh spec (verified, e2e).
3. **json-render itself contributes less than the format does, and costs a lot.** Its `catalog.validate` accepts `variant: "danger"` and a `style` prop when a catalog has more than one component (verified, unit test), so core had to validate specs itself (434 lines). Its prompt is 25,576 characters for Nook and teaches features core must refuse. Its renderer adds 528 kB minified (116 kB gzipped) to every spec frame, mostly zod. It is at 0.23.1 after 37 releases in ten months.

## What was built

| Part | Where | What it does |
| --- | --- | --- |
| Format | `Prototype.format: "spec"` | The same manifest (pages, layouts, scenarios, flow); each page and layout is a JSON file holding a json-render flat spec (`root`, `elements` of `{ type, props, children }`, `state`). A page's root is a `Page` whose named `slots` are its page type's; a body slot holds `{ "type": "Layout", "props": { "id": "room-details" } }`. |
| Library description | `packages/core/scripts/describe-library.mjs`, `packages/core/libraries/todae-0.10.1.json` | Reads Todae's `.d.ts` with the TypeScript compiler: per part, the props it declares itself whose values JSON can hold, required or not, bindable (an `on<Prop>Change` callback), whether it takes children, whether it can be pressed, and required props a spec cannot give (`needs`). One hand override: `Field.Select` takes its `<option>`s as an `options` prop. 198 parts, 46 kB of JSON, stored in `config.library.parts`. A test regenerates it and compares. |
| Catalog | `core/src/spec/catalog.ts` | `specCatalog(config)`: the parts of the inventoried components (minus those with `needs`), each with its props schema, `text` where it takes children, its roles in words, `press` only on an action; plus `Page` and `Layout`. Nook: 39 entries. |
| Reading | `core/src/spec/json.ts`, `read.ts` | A JSON parser that keeps every key's line and column, refuses duplicate keys and words its own errors (so a parse error reads the same in every engine), then validation of every element against the catalog. What fails is reported where it is and left out of what renders. |
| Page model | `core/src/spec/model.ts` | The spec as core's `PrototypeModel`: Page → page node with `Slot` nodes, Layout drawn in place as a layout node, parts as library nodes. Values are resolved where the spec says them (below). Validation issues become `extract` findings. |
| Frame spec | `core/src/spec/resolve.ts` | `resolvePageSpec(prototype, config, scenario)`: the page as one flat spec, layouts copied in under keys of their own, only the elements that passed, state with `scenario: { id, state }`. Exactly what core checked. |
| Frame | `apps/web/src/frame/spec.tsx` | A json-render registry built over the library from the catalog: each part gets only its catalog props, its text or options, a bound value and its callback, and `onClick` that emits `press` when bound. A Page fills the kit's `Slot`s in the page type's order. Drawn with `JSONUIProvider` and `Renderer`. |
| Agent | `apps/web/src/agent/spec-*.ts`, `json-render-catalog.ts` | Spec mode: a spec system prompt plus `catalog.prompt()` for core's catalog as a second cached system block; `write_spec` and `patch_spec` (SpecStream JSONL) in place of the file tools, refused on any validation issue; the canvas follows a streaming `patch_spec` through `createSpecStreamCompiler`. |

## Rules: by construction, still checked, not applicable

Of the 33 rules in Nook's config (the 32 built-ins and Todae's `text-as-heading-or-paragraph`, plus `extract`):

**Impossible to break by construction** (the catalog and validation make the violation unwritable; a hand edit in the code view is reported by `extract`, and the agent's tools refuse it):

| Rule | Why |
| --- | --- |
| `components-from-inventory` | The catalog holds only inventoried components' parts. |
| `no-raw-controls` | There are no HTML elements in the catalog. |
| `no-inline-styles` | No part's props include `style` or `className`; the registry passes only catalog props, so even an unchecked `style` never reaches the DOM (verified, e2e). |
| `no-page-inside-a-page` | A spec cannot refer to another page; a `Page` anywhere but a page's root is refused. |
| `page-structure`, in part | A slot cannot sit inside a slot (slots are keys of the Page), and cannot be filled twice (JSON keys are unique, and the parser refuses a duplicate). Still checked: a slot the page type lacks, an element outside every slot. |

**Do not apply** (nothing to check; they pass vacuously):

| Rule | Why |
| --- | --- |
| `no-ambient-globals` | No prototype code exists, so nothing reaches the frame's window, timers, DOM or built-ins. |
| `imports-from-library` | A spec imports nothing. |

**Still checked, and needed** (all ran unchanged): `page-structure` (the rest), `primary-slot`, `body-from-layouts`, `one-primary-per-page`, `primary-is-rank-1`, `rank-1-shown`, `rank-2-secondary`, `primary-outside-disclosure`, `disclosed-sections`, `disclosures-per-page`, `disclosure-depth`, `no-primary-on-collection-or-content`, `visible-questions`, `counted-parts-reached` (an element nothing lists is not reached), `text-as-heading-or-paragraph`, the page-type, layout and flow-state membership rules, `state-coverage`, `step-budget` and the six rendered rules. `extract` changes meaning: for a spec it reports what the catalog refuses.

## The fixtures

**Ported, failing for the named rule alone** (23, `packages/core/examples/nook/prototypes/spec/illegal/`): second-primary (from aliased-second-primary), block-in-body, extra-in-primary-slot, outside-every-slot, unknown-slot, primary-not-rank-1, primary-on-collection, rank-2-not-secondary, text-as-strong, two-disclosures, nested-disclosure, two-questions, missing-disclosed-section, computed-variant, conditional-text-as (from computed-text-as), orphan-primary (from primary-built-in-a-handler), route-over-budget, scenario-unknown-page, state-without-scenario, task-without-flow, unknown-flow-state, unknown-layout, unknown-page-type.

Two changed character. `computed-variant` is a `$cond` on the scenario's flow state; core reads both values, and the three rules report that they cannot tell, as for TSX. `conditional-text-as` (`as` is `h1` when booked, `strong` otherwise) is now a definite violation, where the TSX extractor could only say it cannot tell: core sees every value a `$cond` can take.

**Refused by the catalog, reported by `extract` alone** (5 from TSX, `spec/refused/`): off-inventory-component, raw-button, inline-style, page-inside-a-layout, parse-error. Three more show what else validation refuses: off-schema-variant (`variant: "danger"`, which the TSX path never checked against Todae's types), computed-function (`$computed`) and custom-action (an action other than setState, pushState, removeState).

**Cannot be expressed as a spec at all** (13, the finding): ambient-computed-key, ambient-constructor, ambient-event-target, ambient-patched-builtin, ambient-post-message, ambient-ref, ambient-timer, computed-require, dynamic-import, foreign-module, element-factory, namespace-second-primary and primary-split-across-files. The last two are mechanisms (a namespace import, a barrel re-export) whose outcome, a second primary action, is the ported second-primary.

## What got simpler, or disappeared

- **The extractor is not on the spec path**: `extract/evaluator.ts` (764 lines), `ambient.ts` (453), `modules.ts` (278), `source-scan.ts` (130), `values.ts` (130) and `index.ts` (94): 1,849 lines, plus the isolation rule (36) and the imports check (33). With them, `@babel/parser` (310 KiB of core's 450 KiB bundle) and, in the app, sucrase (206 kB) and `transform.ts` (108 lines). Their tests (`extract.test.ts` 252 lines, `isolation.test.ts` 144) guard code a spec never reaches. None of this is deleted: TSX still needs it.
- **What replaced it is smaller and plainer**: `core/src/spec/` is 1,139 lines (catalog 123, JSON parser 173, reading and validation 434, model 346, frame spec 63) plus the 119-line description script. It is data walking, with no scope analysis and no fail-closed evaluator.
- **More precise checks.** A value is resolved from the spec: from the page's state when nothing writes that path; `/scenario/state` as the set of flow states the page's scenarios show; per item for a `repeat` over a list nothing writes (exactly, as the extractor does for a list literal); a `$cond` as a choice of both values. Core now also catches what TSX never did: a prop value Todae's types do not allow, a prop a part does not take, a read of a state path the page does not have (verified, unit tests).
- **Findings point at JSON lines**: every element's position is kept, so the code view marks the element's line (verified, e2e).
- **The agent's edits are checked against the catalog before they apply**, not after (verified, unit and e2e tests).

## What got harder

- **Layouts lost their parameters.** A TSX layout is a component with props (`SelectQuestion label choices`); a json-render spec has no parameters, so a layout reads fixed paths in its page's state (`/durations`, `/room/details`). Drawing one twice draws the same thing twice: the ported two-questions draws "How long?" twice, with the same element id. This is the main reason not to switch now. It needs a design: parameters as a state scope per Layout element, or a `$param` directive of our own.
- **Ids are literal.** TSX used `useId()` for the label and field; a spec writes `"duration"`, so two copies collide.
- **Text is a prop.** A spec has no text nodes, so the catalog adds `text` to every part that takes children, and mixed text needs `$template`.
- **Types cannot say everything.** `Field.Select`'s children must be `<option>`s; the description needed a hand override for it. Parts whose required props are objects or functions (`Toast.Region`'s `toaster`, the date inputs' `Temporal` values) cannot be rendered from a spec at all; the catalog leaves 5 Field parts and `Toast.Region` out and says why.
- **json-render's validation is shallow**, so core does it all (verified: with more than one component, `catalog.validate` checks only that `type` is a catalog key; its props schema is `z.record(z.string(), z.unknown())`). Its patch application is lenient for streaming (`replace` of a missing path adds it, `remove` of nothing does nothing), so `patch_spec` checks every target first.
- **The config carries the library's description**: 46 kB in `library.parts`, in every stored project and export. A project stored before this branch has none, so it cannot check a spec prototype until its config gains them.
- **A part that throws disappears silently.** json-render wraps each element in an error boundary that logs and renders nothing (inferred from `renderer.tsx`), so the frame reports a snapshot rather than a render error; the rendered rules see what is missing, but nothing names the crash.
- **Streaming into the canvas is crude.** Each preview is a revision, so all 8 frames re-render from blank (about a second) per redraw; a frame that re-renders in place would need a second message type in the frame protocol.

## Expressiveness: what Nook needed

| Need | TSX | Spec |
| --- | --- | --- |
| State | `state` prop from the scenario | `/scenario/state` in the page's state, set per frame |
| Conditional content | `{state === "booked" && ...}` | `"visible": { "$state": "/scenario/state", "eq": "booked" }` |
| Data | a `data/rooms.ts` module | the page spec's `state` |
| Lists | `rooms.map(...)` | `"repeat": { "statePath": "/rooms" }` with `$item` and `$template` |
| Computed text | `{lantern.seats} seats, {lantern.floor}` | `{ "$template": "${/room/seats} seats, ${/room/floor}" }` |
| Reusable layout with props | `<SelectQuestion label choices />` | not expressible: fixed state paths |
| Form value | uncontrolled `Field.Select` | `"value": { "$bindState": "/duration" }` (Todae's types require `value`) |
| Interaction | none in Nook (the flow is data) | `on.press` with setState is expressible and validated, but not tied to the flow's transitions |

Everything the legal Nook prototype shows was expressible except parameterised layouts. Nothing in Nook needed event handlers.

## What the agent produced in the scripted tests

Only the fake Anthropic API was used; no real model wrote a spec, so nothing here measures a model's output. What is verified is the loop around it:

- The request carries the spec prompt and `catalog.prompt()` as two cached system blocks and the spec tools, without `write_file` (verified, unit and e2e).
- A scripted `patch_spec` adding a `Badge.Root` is refused with core's words ("element "free" is a Badge.Root, which is not in the catalog"), the refusal reaches the next request, and a second patch renaming the page applies, streams onto the canvas and passes every rule (verified, e2e).
- A patch making Hold room primary gets the failing `one-primary-per-page` report without asking; the fix passes (verified, unit test).
- After the Toast proposal is adopted, the next request's catalog prompt lists `Toast.Root` and not `Toast.Region` (verified, e2e).

The catalog prompt for Nook is 25,576 characters (roughly 6,400 tokens) with 39 components, on top of a 2,153-character spec prompt; the TSX system prompt is 1,858. It is written for a model that answers with JSONL only, and teaches `watch`, `validateForm`, `$bindItem` and "always include realistic sample data ... for blogs", which this app refuses or does not want; seven custom rules counter that. `catalog.prompt()` offers `system`, `customRules`, `mode`, `editModes` and `directives`, but no way to drop a section; a full replacement would need a schema of our own with a `promptTemplate`. Untested: whether a real model follows the custom rules over the default ones.

## Determinism

- **Checks:** deterministic, and engine-neutral. Core uses its own JSON parser (so even a parse error's words are its own), sorts keys and slots, and the browser-bundle test now runs every spec fixture in a realm with no Node or DOM globals and compares reports with Node's (verified). A model is the same for any key order in the files (verified).
- **Frames:** the same settle, fixed clock and seeded random as TSX frames. "The same spec prototype gives the same report on reload" passes (verified). json-render uses `Date.now()` only for action dispatch ids, inside the frame's fixed clock (inferred). zod probes `new Function` for speed; the frame's CSP forbids it and zod falls back; no CSP refusal appeared in the console Playwright collects (verified, but Playwright may not see every frame's CSP report).

## Frame security: does `no-ambient-globals` still matter?

Not for spec prototypes. It exists because prototype code shares a frame with the code that measures it; a spec frame runs no prototype code. What a spec can still do is choose data: which parts, which catalog props, which text, and setState, pushState or removeState on its own state. The registry passes a part only the props the catalog lists, so a spec cannot set `style`, `dangerouslySetInnerHTML`, `ref` or an event handler, whatever validation said. The rule still matters for TSX prototypes, and the CSP, sandbox and channel rules are unchanged for both.

What a spec frame trusts instead: json-render's renderer (528 kB of third-party code that resolves expressions) and the registry adapter (89 lines). Neither runs strings as code: `$computed` and custom directives are refused by validation, and the frame registers no functions.

## Bundle size

Measured against `origin/main` built the same way:

| What | main | this branch |
| --- | --- | --- |
| Core, browser bundle | 422.7 KiB min, 113.8 KiB gz | 450.2 KiB min (+27.5), 123.1 KiB gz (+9.3) |
| App JS, loaded on start | 1,351 kB min, 385 kB gz | 1,449 kB min (+98), 404 kB gz (+19) |
| App JS, loaded on first spec agent turn | none | 178 kB min, 54 kB gz (json-render core and zod for the prompt and patches) |
| Spec frame, per frame (local source, sent as code) | none | +528 kB min, 116 kB gz (`@json-render/react` with its core and zod) and the 1.5 kB spec renderer |

Of the +98 kB on start: core's spec code (about 28 kB), Todae's part description inside the seeded config (46 kB), the seeded spec prototype and the agent's spec tools. A spec frame does not load sucrase-compiled prototype modules, but in this branch the app still ships sucrase and core still ships `@babel/parser` for TSX.

Why json-render is not in core: its browser bundle is 464 kB minified, 454 kB of it zod (verified with esbuild); it reads `process.env.NODE_ENV` unguarded, which fails core's realm test without a build-time define (inferred from `dist/index.mjs`); and the one thing core would want from it, validation, is the part that is shallow.

## json-render's maturity

- **Version:** 0.23.1, published 2026-11-16, two days before this trial; 0.23.0 the day before. The repository marks the project Labs; experimental APIs are prefixed `experimental_`, and the README says to pin exact versions.
- **Pace:** 37 versions from 0.0.1 (2026-01-14) to 0.23.1: 23 minor versions in ten months, about one every two weeks (npm). Breaking or renaming changes in that time: 0.12.1 renamed prompt modes `generate`/`chat` to `standalone`/`inline` (old names deprecated); 0.20.0 changed the `executeAction` callback's signature for custom renderers (its one release note marked Breaking); 0.18.0 changed how zod 4 types read in generated prompts. The package changelogs stop at 0.16.0; later notes are in the root `CHANGELOG.md`.
- **Pinned here:** `@json-render/core` and `@json-render/react` 0.23.1 and `zod` 4.6.7, exact, in `apps/web`; the frame's version is `JSON_RENDER` in `package-source.ts`, and a test checks it against `package.json` and node_modules.
- **Wrapped:** core owns the format, the catalog, validation and the model, with no json-render dependency. json-render is used in four places only: the frame's registry and `Renderer` (`frame/spec.tsx`), the catalog prompt (`json-render-catalog.ts`), patch application (`spec-tools.ts`) and the stream compiler (`spec-stream.ts`). An upgrade touches those four and re-runs their tests.

## What code export would mean

json-render ships `@json-render/codegen` (tree traversal and prop serialisation, not a full exporter; read, not used). A Nook spec maps onto TSX mechanically: Page to a component with `Slot`s, Layout to a layout component, a part to its JSX, `visible` to `&&`, `repeat` to `.map`, `$template` to a template literal, page state to a data module. Export from spec to TSX is therefore straightforward and lossless for what a spec can say (inferred; not built). The reverse, TSX to spec, is not possible in general, which is the migration cost below.

## Migration cost

- **TSX prototypes stay TSX.** Arbitrary code has no general translation to a spec; each would be rewritten, by hand or by the agent.
- **Stored projects need `library.parts`** before they can hold a spec prototype; the seed has it, an older stored project does not. A proposal or an import would add it.
- **Two of everything:** two agent modes and prompts, two sets of fixtures, a second frame path. This branch added 1,139 lines to core's library, 522 to the app's spec modules, and 8 e2e tests.
- **Layout parameters** need a design before the spec format can be the default.
- **A latent bug this trial found and fixed**: with more than one prototype in a project, the review page's impact never finished measuring, because the other prototypes' frames were never put in the page (verified: the proposal e2e tests timed out with the second prototype seeded, and pass with the fix).

## Commands and results

- `npm run check`: typecheck, lint and Vitest; 29 files, 310 tests pass (236 on `main`), 74 of them new for specs: in core 35 fixture tests (legal, 23 illegal, 8 refused) and 23 for the JSON parser, catalog, description, model, validation and frame spec; in the app 16 for the spec tools, prompt, stream preview, session, protocol and version pin. The browser-bundle test also runs every spec fixture.
- `npm run e2e`: 36 tests pass in Chromium 153 (28 on `main`), 8 of them new for specs; the export and impact tests were changed to expect the second prototype.
- `npm run bundle:core`: 450.2 KiB, 123.1 KiB gzipped.

## Not verified

- Any real model: whether it writes valid specs, follows the custom rules over json-render's defaults, or prefers patches to whole files. Only the fake API was used.
- esm.sh serving `@json-render/react@0.23.1?external=react,react-dom` (the network here refuses esm.sh).
- Prompt-cache hit rates with the catalog prompt as a second system block.
- Specs larger than Nook, and how the catalog prompt scales with a large inventory (it lists every part with every prop).

## After the trial

Branch `claude/spec-layouts` closed the gap this trial named, and made specs the default. What changed:

- **Layouts take parameters, in core's own format.** A layout file declares `params` (`text`, `number`, `boolean`, `enum`, `list`, `binding`, `slot`), reads them with `{ "$param": "name" }` (a prop, a `repeat`'s list, or an entry of `children` for a slot), and a page's `Layout` element sets them as its other props and fills slots in its `slots`. Core expands every instance before it builds the page model or a frame's spec (`core/src/spec/expand.ts`), so the rules see the expanded tree and json-render never sees a parameter. Instances do not collide: an instance's elements are keyed `<instance>/<key>`, and `{ "$scopedId": "field" }` is an element id unique per instance (and per item inside one keyed repeat). A literal list given for a repeat goes in the page's state at `/params/<instance>/<param>`. A finding inside an instance carries `via`, the layout's use on the page (or, for an element a page passed into a slot, where the layout places it), and its message names both places. A value a rule depends on that core cannot resolve, such as a summary read from state the page changes, makes the rule say it cannot tell, as everywhere else.
- **Why core and not json-render:** json-render 0.23.1 has no reusable fragment with parameters. Its custom directives (`defineDirective`) resolve at render time in the frame, where core cannot see them, so the rules would check something other than what renders; its `$id` means an id generated for a `pushState` value, not a scoped element id; and the nearest thing to a reusable layout, `experimental_composeSpec`'s candidates, is experimental and chooses elements with a model through Vercel's AI Gateway. Expansion in core keeps the checks deterministic, keeps json-render behind the same four modules, and ties nothing to an experimental API (inferred from json-render's `.d.ts` files and `dist/` in node_modules; its GitHub source was not read, and cdn.jsdelivr.net is blocked).
- **Nook's layouts take parameters** as the TSX ones take props: `select-question` (`label`, `choices`, `answer` as a binding, an optional `hint` slot), `room-details` (`items`, `summary` defaulting to "Room details"), `room-cards` (`rooms`). The legal spec passes all 33 rules with measured frames. Five new illegal fixtures each fail for their one rule: a wrong parameter type, a missing required parameter, an instance of a layout the manifest lacks, a second primary action passed in through a slot (flagged where the page writes it and where the layout places it), and a summary read from state the page changes (`disclosed-sections` cannot tell).
- **The agent's own prompt.** The spec mode's second system block is now written from core's catalog by the app (`apps/web/src/agent/spec-prompt.ts`): the spec format core accepts, layouts with parameters, and each part with its props. It is 9,471 characters for Nook (json-render's was 25,576), and with the 2,373-character spec system prompt the spec mode's system text is 11,844 characters (the TSX system prompt is 1,858). It no longer teaches watchers, `$computed`, `validateForm` or JSONL-only replies. json-render is used for patches and the stream preview only; `json-render-catalog.ts` and its zod catalog are gone.
- **Layout tools:** `list_layouts`, `insert_layout` and `set_layout_params`, each checked by core before it applies, beside `write_spec` and `patch_spec`. A new layout is a proposal with `add-layout`, a rule and spec examples, as before.
- **Spec is the default format** for a new prototype (New prototype in the header); TSX stays one choice away, and existing TSX prototypes are unchanged. The seed still opens on the TSX Booking prototype.
- **The app:** a finding inside an instance shows the layout's element and the page's use in the Checks panel and as buttons above the code; the Project view lists the open spec prototype's layouts with their parameters and a preview of each, drawn with its examples (core's `layoutPreview`).
- **Small gaps closed:** a streamed `patch_spec` is now drawn in place in the frames already on the board (a `redraw` message), so a streaming patch makes one revision, not one per preview; a stored project without `library.parts` gets the description bundled for its library version on load, or a plain notice when the app has none.

Since then, branch `claude/param-visible-template` closed the first gap left open here: a layout reads a parameter in a condition (`visible`, or a `$cond`'s), as `{ "$param": "detail", "eq": "seats" }` or as the value compared, and in a template, as `${$param:verb}`. Each use is checked against the parameter's type (a boolean alone in a condition, numbers for `gt` and the like, a value the parameter can hold for `eq`; text, a number or an enum in a template), and core expands it into json-render's own condition or template before anything reads the page, working out a condition of literals to true or false. A value json-render cannot read there is an `extract` finding with `via`; text read from state the page changes still makes a rule say it cannot tell. Nook's `room-cards` uses both, and two illegal fixtures give each use a wrong type.

Still open: a static finding inside an instance is pointed at in the code, not outlined in its frame, since the frame does not map DOM nodes to spec elements; whether a real model writes good parameterised layouts is unmeasured, since only the fake API was used.
