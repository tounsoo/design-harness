# design-harness

A web app for prototyping product UI with an agent, inside guardrails. A chat talks to the agent, and a canvas renders the prototype as it changes.

Every prototype belongs to a project. The project's configuration names the component library to render with, the inventories a prototype may use, the rules that are checked, and the saved proposals.

Two things hold everywhere:

- **Checks are deterministic.** A check is a pure function of the project's configuration and the prototype. No model decides whether a prototype passes.
- **A proposal becomes a check.** A proposal carries the inventory change, the rule that governs it as data, and examples that must pass and fail. It is adopted only when the rule passes and fails its own examples, and from then on the rule runs on every prototype in the project.

The ideas come from [agent-design-loop](https://github.com/tounsoo/agent-design-loop).

## What is here

- [`packages/core`](packages/core/README.md): the checking engine. Project config and prototype as validated JSON, a page-model extractor, a rule engine of pure, deterministic checks, and the proposal lifecycle.
- [`apps/web`](apps/web/README.md): the browser app. A seeded project (Nook, on [Todae](https://github.com/tounsoo/todae)), its prototype rendered as a board of sandboxed frames, one per scenario and view, and core's report beside it, with each finding pointed at in its frame or its file. An agent chat on your own Anthropic API key builds and changes the prototype: its changes re-render the frames, core's checks go back to it after every change, and when the work needs something outside the inventories it drafts a proposal for you. Each proposal has a review page: what it changes and why, its rule in plain words, its examples rendered side by side and measured in frames with what the rule flags outlined, core's verdict on each, what adopting it would do to every prototype, and its history. Only you approve, decline, send it back to the agent with a note, or adopt it; once adopted, its rule runs on every prototype. No model decides pass or fail; core does. A plain code view edits the same files by hand.

A prototype is TSX, or, since the [json-render trial](docs/trials/json-render.md), a set of json-render specs checked by the same rules.

## Run it

Node 22.

```sh
npm ci
npm run dev     # the app on Vite's dev server
npm run check   # typecheck, lint and unit tests: the one gate
npm run e2e     # build the app and run the end-to-end tests in Chromium (CI runs both)
```

Everything runs in the browser: `npm run build` is a static site, and projects stay in the browser's IndexedDB, with export to and import from one JSON file.

