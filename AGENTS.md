# Agent notes

design-harness is a browser-only web app for prototyping product UI with an agent, inside guardrails. This milestone is the core library, `packages/core`. The web app, the agent and the UI come later, under `apps/`.

## Set up

Node 22. `npm ci` from the root installs every workspace (`packages/*`, `apps/*`). `.npmrc` sets `legacy-peer-deps`.

## Check

```sh
npm run check
```

It runs `typecheck` (each workspace's `tsc`: the library against the ES2022 lib only, its tests with Node types), `lint` (ESLint) and `test` (Vitest). CI runs `npm ci && npm run check` on every pull request and every push to `main`. `npm run bundle:core` bundles the core library for the browser and prints its size.

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

A new illegal fixture is a folder under `packages/core/examples/nook/prototypes/illegal/` with a `case.json` (what it shows, and the rule and message fragment that must flag it) and the files it replaces under `files/`. It must fail for that reason and no other.
