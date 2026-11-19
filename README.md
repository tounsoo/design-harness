# design-harness

A web app for prototyping product UI with an agent, inside guardrails. A chat talks to the agent, and a canvas renders the prototype as it changes.

Every prototype belongs to a project. The project's configuration names the component library to render with, the inventories a prototype may use, the rules that are checked, and the saved proposals.

Two things hold everywhere:

- **Checks are deterministic.** A check is a pure function of the project's configuration and the prototype. No model decides whether a prototype passes.
- **A proposal becomes a check.** A proposal carries the inventory change, the rule that governs it as data, and examples that must pass and fail. It is adopted only when the rule passes and fails its own examples, and from then on the rule runs on every prototype in the project.

New checks come only through that loop. There is no rule builder: the app notices what keeps coming up (a rule the agent fixed in two turns, a fix asked for twice, notes that repeat) and offers, quietly, to ask the agent to propose a rule; the agent drafts it with examples that prove it; you adopt it or not. When a rule cannot be said in core's rule vocabulary, the agent files a request for a new rule type instead, which core never adopts: it is a code change, and its review page copies the request to file.

The ideas come from [agent-design-loop](https://github.com/tounsoo/agent-design-loop).

## What is here

- [`packages/core`](packages/core/README.md): the checking engine. Project config and spec prototype as validated JSON, the page model read from the specs, a rule engine of pure, deterministic checks, the proposal lifecycle, and code export.
- [`apps/web`](apps/web/README.md): the browser app. A seeded project (Nook, on [Todae](https://github.com/tounsoo/todae)), its prototype rendered as a board of sandboxed frames, one per scenario and view, and core's report beside it, with each finding pointed at in its frame or its file and, where the rule is about what a designer sees, drawn: a figure of what was measured on each check card, lenses that draw tap targets and the first view over every frame, a grid of states against views and a map of each task's routes. Core decides; the app only draws what core's report carries as evidence. An agent chat on your own Anthropic API key builds and changes the prototype: its changes re-render the frames, core's checks go back to it after every change, and when the work needs something outside the inventories it drafts a proposal for you. Each proposal has a review page: what it changes and why, its rule in plain words, its examples rendered side by side and measured in frames with what the rule flags outlined, core's verdict on each, what adopting it would do to every prototype, and its history. Only you approve, decline, send it back to the agent with a note, or adopt it; once adopted, its rule runs on every prototype. No model decides pass or fail; core does. You can pin a note on any spot of any frame: it anchors to the element under it, stays with that element as the prototype changes (or says "moved or gone"), and goes to the agent with your next message as a finding to fix beside core's; the agent can answer it, and only you close it. A note is your feedback, never a check: it changes no report. A plain code view edits the same files by hand. **New project** is a wizard: a designer names a product, picks a component library the deployment ships (Todae and Mantine today) or imports a description of one, confirms each role on a card that draws the library's own parts live, and gets a project with a starter prototype that passes every rule.

For a spec prototype the agent can also offer variants: two to four whole pages built from the same inventories and layouts, shown side by side in measured frames, each with core's report. You pick each slot of the page from any variant with nothing to fix on that page (the body from one, the actions from another); core recombines them, the combination is checked like any page, and applying it is a new revision you can undo. A pick answers for the page it changes: a failure already on another page does not block it. The agent never picks. **Export code** downloads any prototype as a runnable React project (Vite, the project's exact library and React versions, a scenario switcher); a spec prototype is written as the TSX a person would write, and core gives that TSX the same report as the spec.

A prototype is a set of json-render specs. Specs came out of the [json-render trial](docs/trials/json-render.md): each page and layout is data, checked against a catalog the project generates, and layouts take typed parameters, so a page draws one many times with different data. Core expands every layout instance before it checks, and a finding inside an instance names both the layout and the page's use of it. The app is spec-only: New prototype, the seed and the agent make and change specs alone. Core reads specs only. A TSX prototype from an older store or an imported file is kept for its files: it shows a notice and its files read-only, nothing renders, checks or edits it, and it offers **Export code** and **Start a spec version** ([TSX prototypes, notice only](apps/web/README.md#tsx-prototypes-notice-only)).

## Run it

Node 22.

```sh
npm ci
npm run dev     # the app on Vite's dev server
npm run check   # typecheck, lint and unit tests: the one gate
npm run e2e     # build the app and run the end-to-end tests in Chromium (CI runs both)
```

Everything runs in the browser: `npm run build` is a static site, and projects stay in the browser's IndexedDB, with export to and import from one JSON file. A browser can hold several projects, and the header switches between them.


## Deploy

CI builds the app, tests that build end to end, and deploys it to Vercel as prebuilt output: a pull request gets a preview, and a push to `main` deploys production. Vercel never builds. `AGENTS.md` says how.
