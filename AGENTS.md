# Agent notes

design-harness is a browser-only web app for prototyping product UI with an agent, inside guardrails. It has the core library, `packages/core`, and the web app, `apps/web`: the shell and the canvas, with a code view standing in for the agent, which comes next.

## Set up

Node 22. `npm ci` from the root installs every workspace (`packages/*`, `apps/*`). `.npmrc` sets `legacy-peer-deps`.

## Check

```sh
npm run check
```

It runs `typecheck` (each workspace's `tsc`: the library against the ES2022 lib only, its tests with Node types; the app against the DOM, its tests with Node types too), `lint` (ESLint) and `test` (Vitest, core's tests and the app's unit tests). CI runs `npm ci && npm run check` on every pull request and every push to `main`. `npm run bundle:core` bundles the core library for the browser and prints its size.

```sh
npm run e2e
```

builds the app and runs `apps/web/e2e/run.mjs` in Chromium: every frame renders, the legal prototype passes every rule, an edit's finding is pointed at in its file or frame, the same prototype gives the same report on reload, export and import round-trip, packages load by URL from a CDN-shaped origin, and a frame cannot reach the app. It uses the `playwright` package and Chromium the environment provides (on `NODE_PATH`), so it is not in CI: a CI job would need Playwright added as a dev dependency and its Chromium installed. Run it before pushing a change to `apps/web` or to what core says about rendered pages.

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
- `apps/web/`: the browser app. `src/app/` is the UI, built with Todae; `src/runtime/` the parent side of the frames (the check session, the frame protocol, the frame document and its sandbox, the TSX transform, the package sources); `src/frame/` what runs inside a frame (the boot script, the page kit `@design-harness/page` and its default shell, the snapshot collector); `src/store/` IndexedDB and the project file; `e2e/` the end-to-end tests. `apps/web/README.md` documents the frame protocol, the scenario contract, the package-source interface and the isolation model.

Nothing in `apps/web` decides pass or fail: it renders, measures and shows `checkPrototype`'s report unchanged. Prototype code runs only in frames sandboxed without `allow-same-origin`, and talks to the app only by validated `postMessage`; keep it that way.

A new illegal fixture is a folder under `packages/core/examples/nook/prototypes/illegal/` with a `case.json` (what it shows, and the rule and message fragment that must flag it) and the files it replaces under `files/`. It must fail for that reason and no other.
