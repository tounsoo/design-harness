---
name: verify
description: Verify a design-harness change before opening or updating a PR, or when a thread has to say how a change was tested.
---

# Verify

Run every step the change needs, then give one verdict. `AGENTS.md` ("Check") says what each script covers and its gotchas; read it there.

## 1. Set up

Commit the change first: you verify a commit, not a working tree. From the repo root, on Node 22 (`node -v`), run `npm ci`. Note the commit you test: `git rev-parse HEAD`.

## 2. Run what the change needs

Map the files the change touches (`git diff --name-only origin/main...HEAD`) to steps:

| Change touches | Run |
| --- | --- |
| anything | `npm run check` (typecheck, lint, test) |
| `packages/core` | also `npm run bundle:core` |
| `apps/web`, or core changes what rendered pages show | also `npm run e2e` |

`npm run e2e` builds the app and runs `apps/web/e2e/run.mjs` in Chromium, at `/opt/pw-browsers/chromium` when that exists and Playwright's own otherwise; `AGENTS.md` says how CI installs it. To rerun some tests after a fix, run `npm run build`, then `node e2e/run.mjs "<part of a test's name>"` in `apps/web`. A filter that matches no test still exits 0, so a filtered run proves only the tests it printed; finish with one full `npm run e2e`.

Each step is passed (exit 0), failed (any other exit) or blocked (it could not start or finish: no Chromium, no network for `npm ci`, the wrong Node). Note why a step was blocked.

## 3. Verdict

Give exactly one:

- **PASS**: every needed step ran on the tested commit and passed.
- **FAIL**: a step failed. Name it and quote the failing output.
- **BLOCKED**: a step could not run. Name it and the reason. BLOCKED is not a pass: the change stays unproven until that step runs, locally or in CI.

Put the tested commit SHA and each command with its result in the PR body.
