---
name: verify
description: Prove a design-harness change works before opening or updating a PR, or when a thread has to say how a change was tested. Runs the repo's check, bundle and e2e scripts by change type and ends in one verdict.
---

# Verify

Run every step your change needs, then give one verdict. `AGENTS.md` ("Check") is the source of truth for what each script covers; read it there rather than here.

## 1. Set up

From the repo root, on Node 22 (`node -v`), run `npm ci`. Note the commit you test: `git rev-parse HEAD`. Every step below runs on that commit with a clean tree (`git status --short` empty), or the result does not count for it.

## 2. Run what the change needs

Map the diff (`git diff --name-only origin/main...HEAD` plus uncommitted files) to steps:

| Change touches | Run |
| --- | --- |
| anything | `npm run check` (typecheck, lint, test) |
| `packages/core` | also `npm run bundle:core` |
| `apps/web`, or core changes what rendered pages show | also `npm run e2e` |

`npm run e2e` builds the app, then runs `apps/web/e2e/run.mjs` in Chromium: `/opt/pw-browsers/chromium` when it exists, Playwright's own Chromium otherwise (`npx playwright install chromium` if it is missing). Run one e2e at a time on a machine; two at once starve each other and fail with timeouts. To rerun only some tests after a fix, run `npm run build` at the root, then `node e2e/run.mjs "<part of a test's name>"` in `apps/web`, and finish with one full `npm run e2e` before you call it passed.

A step is done when its command exits: exit 0 is passed, anything else is failed. A step you could not start or finish (no Chromium, no network for `npm ci`, wrong Node) is blocked; write down why.

## 3. Verdict

Give exactly one:

- **PASS**: every needed step ran on the tested commit and passed.
- **FAIL**: a step failed. Name it and quote the failing output.
- **BLOCKED**: a step could not run. Name it and the reason. BLOCKED is not a pass: the change is unproven until that step runs, locally or in CI.

Put the tested commit SHA and each command with its result (passed, failed, blocked and why) in the PR body.
