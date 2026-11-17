# @design-harness/core

The checking engine behind design-harness. It reads a project's config and a prototype, both plain JSON, and returns a report of which rules pass and what each failing rule found. It also runs a proposal's lifecycle: a proposal is adopted only when its rules pass and fail its own examples.

Everything here is a pure function. Nothing reads a clock, randomness, the network or a file, so the same input gives the same report, in the same order, in a browser and in Node. ESLint enforces this in `src/` (no Node built-ins, no `Date`, `Math.random`, `fetch`, `process`, `window`), the library typechecks against the ES2022 lib only (no DOM, no Node types), and a test runs the browser bundle in a realm with no Node or DOM globals and compares its reports with Node's.

```ts
import { checkPrototype, parseProjectConfig, parsePrototype } from "@design-harness/core";

const config = parseProjectConfig(configJson); // { ok, value } or { ok: false, error: Issue[] }
const prototype = parsePrototype(prototypeJson);
if (config.ok && prototype.ok) {
  const report = checkPrototype({ config: config.value, prototype: prototype.value, snapshots });
  // report.status: "pass" | "fail" | "incomplete"; report.rules[i]: { rule, type, status, findings }
}
```

The worked example is [`examples/nook/`](examples/nook/): Nook, a room booking app on Todae. [`project.ts`](examples/nook/project.ts) is its config, [`prototypes/legal/booking/`](examples/nook/prototypes/legal/booking/) passes every rule, and each folder under [`prototypes/illegal/`](examples/nook/prototypes/illegal/) changes the legal prototype in one way and names the rule and message that must flag it. [`rendered-cases.ts`](examples/nook/rendered-cases.ts) does the same for the rendered rules, over [`snapshots.ts`](examples/nook/snapshots.ts).

## Project config

`ProjectConfig` ([`src/config/types.ts`](src/config/types.ts)) is JSON. `parseProjectConfig` checks its shape (objects are strict, so a misspelled field is an error, not a silent no-op) and then every reference inside it: unique ids, caps and ranks a rule names, slots a page type names, and roles that map to inventoried components. A rule that could never fire is a config error.

| Field | What it holds |
| --- | --- |
| `library` | The npm `package` and its exact `version`, the exact `react` version it renders with, optional `stylesheets` (paths inside the package, such as `dist/todae.css`) and `schemeAttribute` (the root attribute that switches it to a view's colour scheme, such as Todae's `data-appearance`), and `roles`: which parts and prop values are the `action`, `primary-action`, `secondary-action`, `disclosure`, `disclosure-summary` and `question`. Rules select by role, so they hold for any library. Versions are exact, never ranges, so a prototype renders with the same code on every load. |
| `inventories` | `components` (the library's top-level exports a prototype may render), `layouts` (ids), `pageTypes` (each with `kind` `action`, `collection` or `content`, its `slots`, its `chrome` slots, and for `action` its `primarySlot`), `flowStates`. |
| `inputs` | `tasks` (success state, max steps), `ranking` (rank 1 is the primary action), `disclosedSections`, and `caps`: named numbers rules read, each with the direction that is `stricter`. |
| `views` | The viewports rendered snapshots are expected at. |
| `rules` | The rules in force. [`BUILT_IN_RULES`](src/builtins.ts) is the starting set. |
| `proposals` | Every proposal and its history. |

Todae's roles, from the example:

```json
"primary-action": { "components": ["Button.Root"], "prop": { "name": "variant", "values": ["primary"], "whenMissing": true } }
```

`whenMissing: true` says a `Button.Root` with no `variant` is primary, as Todae's default variant is.

## Prototype

`Prototype` ([`src/prototype/types.ts`](src/prototype/types.ts)) is `files` (path to TSX text), `pages` (id, page type, and the component: a file and an export name), `layouts` (id and component), `scenarios` (id, flow state, page), and `flow` (`states`, and per task a `start` and its `transitions`). The flow is data, so the step budget is a graph search rather than a run of reducer code.

A page fills its page type's slots with `Slot` from the page kit, `@design-harness/page`. When a page is rendered for a scenario, it receives that scenario as props, `PageProps`: `scenario` (its id) and `state` (its flow state). That is the whole contract between a scenario and a page:

```tsx
import { Slot, type PageProps } from "@design-harness/page";
import { Button, Text } from "@tounsoo/todae";

export function BookingPage({ state }: PageProps) {
  return (
    <>
      <Slot name="title"><Text.Root as="h1">Lantern</Text.Root></Slot>
      <Slot name="facts">{state === "booked" && <Text.Root as="p">Booked until 3 pm</Text.Root>}</Slot>
      <Slot name="action"><Button.Root variant="primary">Book room</Button.Root></Slot>
    </>
  );
}
```

The extractor reads code, not one scenario: a page's props are unknown to it, so what a page shows in any state is in its model, marked conditional, and every rule counts it. A primary action shown only when `state === "held"` still counts toward the page's one primary action, and a prop whose value depends on the state (`variant={state === "held" ? "primary" : "secondary"}`) makes the rule report that it cannot tell. The imports rule allows `Slot` and the `PageProps` type from the page kit.

## The page model

`extractPrototype` parses the files with [`@babel/parser`](https://babeljs.io/docs/babel-parser) and builds, for each manifest page, the tree of elements it renders. Local components are expanded in place, across files, so a rule counts what the page renders, not what one file holds. It resolves:

- import aliases (`Button as Control`), namespace imports (`UI.Button.Root`), parts held in constants (`const Strong = Button.Root`, `const { Root } = Button`)
- default exports, `export { X as default }`, renamed re-exports, `export *` and `export * as`
- props passed to local components: destructured, defaulted, read as `props.x`, spread on with `{...rest}`, and `children`
- JSX hoisted into constants, helper functions called in JSX, `memo` and `forwardRef`, early returns, `&&` and `?:`
- `.map` over a list written in the source (each item, exactly) and over any other list (once, marked repeated)
- JSX passed in a library part's props, and render props the part calls

It **fails closed**. What it cannot resolve becomes part of the model, and every rule that depends on it reports that it cannot be checked (`kind: "unverifiable"`), which fails the rule:

| The source has | The model has | A rule that depends on it says |
| --- | --- | --- |
| a prop computed at runtime (`variant={tone}`) | the prop as `dynamic`, with the expression | cannot tell whether it is a primary action |
| a ternary of literals (`urgent ? "primary" : "secondary"`) | a `choice` of both | unknown unless every value agrees |
| a spread it cannot see through | `openProps`; earlier props become unknown | cannot tell |
| a tag it cannot name, a class component, `React.lazy`, a component that renders itself, a call to a function it cannot see, in child position | an `unresolved` element with the reason | cannot tell |
| a list of unknown length | elements marked `repeated` | a count may be exceeded |
| text computed at runtime | `textDynamic` | cannot tell whether it reads the rank-1 action |
| JSX no page renders (built in an event handler, in an unused file) | not in any page's tree | the `reachable` rule: no page reaches it |
| `import()`, `require()`, a computed specifier | a module load | the imports rule cannot check it |
| `createElement`, `cloneElement`, a file that does not parse, a manifest component that is missing or not a function | an extraction problem | the always-on `extract` rule |

The extractor reads code, not runtime state: an element under a condition still counts.

## Rule vocabulary

A rule is data with a stable `id`, a `type` from a fixed set, and an optional `description`. Each type is one pure evaluator in [`src/engine/rules/`](src/engine/rules/). Selectors ([`src/rules/types.ts`](src/rules/types.ts)) pick elements by `component` (library part names after aliases are undone, or lowercase HTML tags), `role`, `props` equality, `hasProp`, `text` (a literal, `{ "rank": 1 }`, or `{ "each": true }`), `page`, `layout`, `inside`, `notInside`, `not` and `anyOf`. Matching is three-valued: a field the source cannot decide makes the match unknown, and the rule reports it only when it could change the answer. A bound is a number or `{ "cap": "NAME" }` from the inputs.

| Type | Example |
| --- | --- |
| `membership`: only inventoried `components`, `imports`, `page-types`, `layouts`, `flow-states` | `{ "type": "membership", "id": "components-from-inventory", "of": "components" }` |
| `count` within `page`, `pages` or `source`, with `min`/`max`, optional `pages` filter and `each` | `{ "type": "count", "id": "one-primary-per-page", "scope": "page", "select": { "role": "primary-action" }, "max": 1 }` |
| `containment`: `must` `be-inside`, `not-be-inside`, or `nest-at-most` a depth | `{ "type": "containment", "id": "primary-outside-disclosure", "select": { "role": "primary-action" }, "must": "not-be-inside", "of": { "role": "disclosure" } }` |
| `prop-values`: a prop takes only listed literals | `{ "type": "prop-values", "id": "text-as", "select": { "component": "Text.Root" }, "prop": "as", "allowed": ["h1", "h2", "p"], "required": true }` |
| `requires`: every match also matches `must` | `{ "type": "requires", "id": "rank-2-secondary", "select": { "role": "action", "text": { "rank": 2 } }, "must": { "role": "secondary-action" } }` |
| `slot`: what a named slot (`$primary`, `$body`, `$chrome`, or a name) holds at its top level | `{ "type": "slot", "id": "primary-slot", "slot": "$primary", "holds": { "role": "primary-action" }, "min": 1, "max": 1, "only": { "role": "primary-action" } }` |
| `reachable`: matching elements anywhere in the source are rendered from a page | `{ "type": "reachable", "id": "counted-parts-reached", "select": { "role": "action" } }` |
| `page-structure` (named built-in): pages fill only their type's slots, once each, nothing outside | `{ "type": "page-structure", "id": "page-structure" }` |
| `flow` (named built-in): `state-coverage`, `step-budget` | `{ "type": "flow", "id": "step-budget", "check": "step-budget" }` |
| `rendered` (named built-ins over snapshots): `target-size`, `headings`, `contrast`, `accessible-names`, `first-view`, `no-sideways-scroll` | `{ "type": "rendered", "id": "target-size", "check": "target-size", "minPx": { "cap": "TARGET_MIN_PX" } }` |

`step-budget` measures every route from a task's start to its success state that never returns to a state it passed, and fails the longest one over the task's max steps, not only the shortest. Rendered rules read `RenderedSnapshot`s ([`src/rendered/types.ts`](src/rendered/types.ts)): per scenario and view, the page's content width and the width it lays out in (`viewportWidth`, less a vertical scrollbar drawn beside the page), and the elements with role, accessible name, rect, heading level, whether a control is turned off (`disabled`, which WCAG 1.4.3 exempts from contrast), and painted colours (with `overImage` when an image or gradient lies under the text, which makes contrast unverifiable rather than passed). The web app produces them from the live page in each frame. Without snapshots they report `not-run` and the report is `incomplete`; with them, a scenario and view with no snapshot is unverifiable. A rendered finding about one element carries `element`, its index in that snapshot's `elements`, so the app can point at it on the page.

### Built-in rules

[`BUILT_IN_RULES`](src/builtins.ts) carries agent-design-loop's checks over. Each is data; the ones whose type is a named check rather than a selector rule are marked.

| Rule | Type | From agent-design-loop |
| --- | --- | --- |
| `components-from-inventory`, `imports-from-library`, `page-types-from-inventory`, `layouts-from-inventory`, `flow-states-from-inventory` | membership (named subjects) | `lint:product-ui`, `check:inventories` |
| `no-raw-controls`, `no-inline-styles` | count, source | `lint:product-ui` |
| `page-structure` | page-structure (named) | the page shells |
| `primary-slot`, `body-from-layouts` | slot | `lint:slots`, page bodies from content layouts |
| `one-primary-per-page`, `primary-is-rank-1`, `rank-1-shown`, `disclosed-sections` | count | `check:priority` |
| `rank-2-secondary` | requires | `check:priority` |
| `primary-outside-disclosure`, `disclosure-depth` | containment | `check:priority`, `check:disclosure` |
| `disclosures-per-page` | count | `check:disclosure` |
| `no-page-inside-a-page`, `no-primary-on-collection-or-content`, `visible-questions` | count | `check:one-thing` |
| `counted-parts-reached` | reachable | the "not reached from any page" failures |
| `state-coverage`, `step-budget` | flow (named) | `check:state-coverage`, `check:step-budget` |
| `target-size`, `accessible-names`, `heading-structure`, `text-contrast`, `rank-1-in-first-view`, `no-sideways-scroll` | rendered (named) | `check:target-size`, `check:accessible-names`, `check:rendered-page` |

## The report

`CheckReport` ([`src/engine/report.ts`](src/engine/report.ts)) is `{ status, rules, findings }`. Each `RuleReport` is `{ rule, type, status, description?, note?, findings }` with status `pass`, `fail` or `not-run`. A `Finding` is `{ rule, kind, message, file?, line?, column?, page?, scenario?, state?, view?, element? }`; the field names follow agent-design-loop's `Finding`. Rules are ordered with `extract` first and then by id, and findings by rule, file, line, column, page, scenario, view, kind and message, using code-unit order, never the runtime's locale.

## Proposals

A proposal ([`src/proposals/types.ts`](src/proposals/types.ts)) carries an id, title, reason, notes on the states it shows, `inventory` operations, `rules` to add and remove, and `examples`: prototypes that must pass, and prototypes that must fail, each naming the rule (and optionally a message fragment) that must flag it.

```text
propose -> open -> approve -> approved -> adopt -> adopted
             \---------------- decline -----------> declined
```

No step is skipped, and `adopted` and `declined` are final. Every function takes the time and who as arguments and returns `{ ok: true, value }` or `{ ok: false, error: Refusal }`.

`adopt(config, id, stamp, existing?)` applies the operations, re-validates the config, and refuses unless:

- there is at least one passing and one failing example, and every rule the proposal adds is named by a failing example;
- every passing example passes every rule of the new config, and runs every new rule;
- every failing example fails its named rule, with its message, and no other rule;
- every example of an earlier adopted proposal still behaves as it did: its passing examples pass every rule, and its failing examples are still flagged by their rule. The one exception is a failing example whose rule this proposal removes: the example has nothing left to prove, so it is retired, not broken.

A refusal names the example and what happened instead, such as `failing example "only-one" is not flagged as it must be: "one-toast-per-page" passed it`, or, for an earlier proposal's example, `adopting "no-toasts" breaks passing example "one-toast" of adopted proposal "toast": ...` with `proposal` and `example` set on the refusal. Replacing a rule with another of the same id is not a removal: the earlier examples are held to the new rule. On success it returns the new config with the proposal adopted, a deterministic `classification` (`adds`, `tightens`, or `loosens-or-removes`, with each change's reason), the caller's `existing` prototypes that newly fail, and the earlier examples it retires. `rerunExamples(config)` re-runs every adopted proposal's examples against the config as it is now, and marks a failing example `retiredBy` the adopted proposal that removed its rule.

## Size

`npm run bundle:core` bundles the library for the browser platform, which refuses Node built-ins, and prints its size. At this commit it is about 399 KiB minified and 107 KiB gzipped, of which `@babel/parser` is about 310 KiB minified. The parser is the one runtime dependency: it parses TSX with positions in the browser, synchronously, with no WebAssembly to load.
