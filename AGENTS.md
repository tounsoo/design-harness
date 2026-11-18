# Agent notes

design-harness is a browser-only web app for prototyping product UI with an agent, inside guardrails. It has the core library, `packages/core`, and the web app, `apps/web`: the shell, the canvas, a code view, and the agent chat on the person's own Anthropic API key.

## Set up

Node 22. `npm ci` from the root installs every workspace (`packages/*`, `apps/*`). `.npmrc` sets `legacy-peer-deps`.

## Check

```sh
npm run check
```

It runs `typecheck` (each workspace's `tsc`: the library against the ES2022 lib only, its tests with Node types; the app against the DOM, its tests with Node types too), `lint` (ESLint) and `test` (Vitest, core's tests and the app's unit tests). CI runs `npm ci && npm run check` as its `check` job, and the end-to-end tests below as its `e2e` job, on every pull request and every push to `main`. `npm run bundle:core` bundles the core library for the browser and prints its size.

```sh
npm run e2e
```

builds the app and runs `apps/web/e2e/run.mjs` in Chromium: every frame renders, the legal prototype passes every rule, an edit's finding is pointed at in its file or frame, the same prototype gives the same report on reload, export and import round-trip, packages load by URL from a CDN-shaped origin, a frame cannot reach the app, and the agent's whole loop runs against a fake Anthropic API at api.anthropic.com's address (edits, failing checks fed back, proposals, stop, errors, refusals, undo, and the key's absence from frames, exports and storage). It uses `playwright`, pinned as a root dev dependency, with the Chromium at `/opt/pw-browsers/chromium` when that exists and Playwright's own Chromium otherwise. CI's `e2e` job installs that Chromium with `npx playwright install --with-deps chromium`. Run it before pushing a change to `apps/web` or to what core says about rendered pages.

## The two rules not to break

1. **Checks are deterministic.** A check is a pure function of the project config and the prototype that returns findings: same input, same output, in the same order, whatever order keys, files or rules come in. No model, clock, randomness, network or file system anywhere in the checking path. Library code under `packages/core/src` must also run unchanged in a browser and in Node: no `node:` imports, no DOM globals. ESLint fails a change that reaches for them, and `packages/core/test/browser-bundle.test.ts` runs the browser bundle in a realm with neither.
2. **A proposal becomes a check.** A proposal carries the inventory change, the rule that governs it as data in the fixed rule vocabulary, and examples that must pass and must fail. It is adopted only when its rules pass the passing examples and fail each failing example for the named rule's reason alone. Once adopted, the rule runs on every prototype in the project, and its examples stay as regression tests (`rerunExamples`).

When the extractor cannot resolve something a rule depends on, the rule reports that it cannot be checked. Never let it pass silently.

## Where things live

- `packages/core/src/config/`: the project config types, schema and cross-reference checks.
- `packages/core/src/prototype/`: the prototype model.
- `packages/core/src/extract/`: the page-model extractor (parsing, module resolution, evaluation, the source scan).
- `packages/core/src/rules/`: the rule vocabulary as types and schema. `src/builtins.ts` is the built-in rule set.
- `packages/core/src/engine/`: selector matching, one evaluator per rule type in `rules/`, and the report.
- `packages/core/src/rendered/`: the rendered snapshot type and its arithmetic.
- `packages/core/src/proposals/`: proposal operations, classification and lifecycle.
- `packages/core/examples/nook/`: the worked example project and its legal and illegal prototypes, which are the engine's regression fixtures.
- `packages/core/README.md`: the config, the rule vocabulary and the proposal lifecycle.
- `apps/web/`: the browser app. `src/app/` is the UI, built with Todae; `src/review/` a proposal's review (the actions, each a step of core's lifecycle by "you", the history, the inventory diff); `src/agent/` the agent (the API client and request, the tools and their input validation, the append-only history, the turn loop, the key vault); `src/runtime/` the parent side of the frames (the check session, the frame protocol, the frame document and its sandbox, the TSX transform, the package sources); `src/frame/` what runs inside a frame (the boot script, the page kit `@design-harness/page` and its default shell, the snapshot collector); `src/store/` IndexedDB (projects, prototypes, chats) and the project file; `e2e/` the end-to-end tests and `e2e/fake-anthropic.mjs`, the fake Anthropic API every agent test runs against; `test/` helpers for the app's unit tests. `apps/web/README.md` documents the agent, the frame protocol, the scenario contract, the package-source interface and the isolation model.

Nothing in `apps/web` decides pass or fail: it renders, measures and shows `checkPrototype`'s report unchanged, and the agent gets that report; no model decides. Prototype code runs only in frames sandboxed without `allow-same-origin`, and talks to the app only by validated `postMessage`; keep it that way. The API key stays in the app's memory and its own IndexedDB database, never in a prototype, export, frame, log or error message. Tests never call the real Anthropic API.

A new illegal fixture is a folder under `packages/core/examples/nook/prototypes/illegal/` with a `case.json` (what it shows, and the rule and message fragment that must flag it) and the files it replaces under `files/`. It must fail for that reason and no other.
