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

The worked example is [`examples/nook/`](examples/nook/): Nook, a room booking app on Todae. The second, [`examples/tally/`](examples/tally/), is Tally, an expense app on Mantine, onboarded as [Bring your own library](#bring-your-own-library) says. [`project.ts`](examples/nook/project.ts) is its config, [`prototypes/legal/booking/`](examples/nook/prototypes/legal/booking/) passes every rule, and each folder under [`prototypes/illegal/`](examples/nook/prototypes/illegal/) changes the legal prototype in one way and names the rule and message that must flag it. [`rendered-cases.ts`](examples/nook/rendered-cases.ts) does the same for the rendered rules, over [`snapshots.ts`](examples/nook/snapshots.ts).

## Project config

`ProjectConfig` ([`src/config/types.ts`](src/config/types.ts)) is JSON. `parseProjectConfig` checks its shape (objects are strict, so a misspelled field is an error, not a silent no-op) and then every reference inside it: unique ids, caps and ranks a rule names, slots a page type names, and roles that map to inventoried components. A rule that could never fire is a config error.

| Field | What it holds |
| --- | --- |
| `library` | The npm `package` and its exact `version`, the exact `react` version it renders with, optional `stylesheets` (paths inside the package, such as `dist/todae.css`), `schemeAttribute` (the root attribute that switches it to a view's colour scheme, such as Todae's `data-appearance`) and `root` (a part of the library every page renders inside, such as Mantine's `MantineProvider`, with literal `props` and the `schemeProp` that takes the view's scheme), `excludedProps` (names and `*` patterns of props a spec may never set, the library's style props: the catalog leaves them out and a spec that sets one is refused), and `roles`: which parts and prop values are the `action`, `primary-action`, `secondary-action`, `disclosure`, `disclosure-summary` and `question`. Rules select by role, so they hold for any library. Versions are exact, never ranges, so a prototype renders with the same code on every load. |
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

### Spec prototypes

A prototype with `"format": "spec"` is written as [json-render](https://github.com/vercel-labs/json-render) specs instead of TSX: the same manifest, and each page and layout a JSON file holding a flat spec (`root`, `elements` of `{ type, props, children }`, and on a page `state`). A page's root is a `Page` whose `slots` are its page type's; a body slot holds `{ "type": "Layout", "props": { "id": "room-details" } }`. A page reads its scenario at `/scenario/state` and `/scenario/id`.

#### Layouts with parameters

A spec layout is a reusable fragment with typed parameters, so a page draws it many times with different data, as a TSX page renders a layout component with props. The layout file declares them under `params`, and reads them with `{ "$param": name }`:

```json
{
  "params": {
    "label": { "type": "text", "example": "How long?" },
    "choices": { "type": "list", "of": "option" },
    "answer": { "type": "binding" },
    "hint": { "type": "slot", "required": false }
  },
  "root": "question",
  "elements": {
    "question": { "type": "Stack.Root", "props": { "gap": "condensed" }, "children": ["label", "field", { "$param": "hint" }] },
    "label": { "type": "Label.Root", "props": { "htmlFor": { "$scopedId": "field" }, "text": { "$param": "label" } }, "children": [] },
    "field": { "type": "Field.Root", "props": { "id": { "$scopedId": "field" } }, "children": ["select"] },
    "select": { "type": "Field.Select", "props": { "value": { "$param": "answer" }, "options": { "$param": "choices" } }, "children": [] }
  }
}
```

A page draws an instance with the parameters as the `Layout` element's other props, and a slot's elements in its `slots`:

```json
"question": { "type": "Layout", "props": { "id": "select-question", "label": "How long?", "choices": { "$state": "/durations" }, "answer": { "$bindState": "/duration" } }, "children": [] }
```

| Type | A page gives | The layout reads it as |
| --- | --- | --- |
| `text`, `number`, `boolean`, `enum` (`values`) | a literal of the type, or an expression that reads the page (`$state`, `$item`, `$index`, `$template` for text, `$cond`) | a prop's value; the prop's schema must take the type (an enum's values must be the prop's). In a condition (`visible`, or a `$cond`'s): a `boolean` alone, or any of the four compared with `eq` or `neq` to a value it can hold, `gt`, `gte`, `lt` and `lte` for a `number`. In a `$template` as `${$param:name}`: `text`, `number` or `enum` |
| `list` (`of`: `text`, `number`, `boolean`, `option`, or `{ "record": { field: type } }`) | a literal list, `$state` or `$item` | `"repeat": { "param": name, "key"?: field }`, or a prop such as `options` |
| `binding` | `{ "$bindState": "/path" }` | a bindable prop: each instance writes its own path |
| `slot` | element keys in the instance's `slots` | `{ "$param": name }` among an element's `children`, placed once |

A parameter is required unless it has a `default` or `"required": false`; `description` and `example` are for people and the agent. Inside another layout, an instance may pass on its own parameters with `$param` where the types fit.

A condition and a template read parameters too. Nook's `room-cards` shows each card's seats only when the page asks for them, and puts its button's verb before the room's name:

```json
"params": {
  "detail": { "type": "enum", "values": ["seats", "none"], "default": "seats" },
  "verb": { "type": "text", "default": "Open" }
},
"elements": {
  "seats": { "type": "Text.Root", "props": { "as": "p", "text": { "$template": "${seats} seats" } }, "visible": { "$param": "detail", "eq": "seats" }, "children": [] },
  "open": { "type": "Button.Root", "props": { "variant": "secondary", "text": { "$template": "${$param:verb} ${name}" } }, "children": [] }
}
```

`{ "$param": name }` is a condition's source or the value it compares with; `${$param:name}` is a template's reference, beside `${/path}` for state and `${field}` for the repeat item.

[`src/spec/params.ts`](src/spec/params.ts) reads the declarations and checks each value an instance gives, and [`src/spec/read.ts`](src/spec/read.ts) checks every use of a parameter against the prop it feeds: a wrong type, a missing required parameter, a parameter the layout lacks, a slot placed twice or nowhere, and an instance of a layout the manifest lacks are each an `extract` finding where they are written. [`src/spec/expand.ts`](src/spec/expand.ts) then expands every instance, deterministically and before anything else reads a page, so the page model and the frame's spec are the same expanded tree and neither sees a parameter:

- an instance's elements are keyed `<instance>/<key>`, with nested instances joined by `/`, so two instances never collide; a key in a file holds no `/`;
- `{ "$scopedId": "field" }` is `<instance>/field`, an element id unique per instance, and per item, through the repeat's key, inside one keyed repeat (anywhere else it is an `extract` finding, since the id would repeat);
- a literal list given for a repeat is kept in the page's state at `/params/<instance>/<param>`, where json-render's repeat reads it (`params` is reserved in a page's state, as `scenario` is);
- a condition that reads a parameter becomes json-render's own: the value given stands in as its source or operand (`{ "$param": "detail", "eq": "seats" }` given `{ "$state": "/card-detail" }` is `{ "$state": "/card-detail", "eq": "seats" }`), a literal compared with state turns the comparison round so state is the source, and a condition of literals alone is worked out: true drops it, and false leaves the element out of the page model (and hides it in the frame), as `"visible": false` does. A `$cond` whose condition is worked out is the value it picks;
- `${$param:name}` in a template becomes what was given: a literal's text, `${/path}` for `$state`, `${field}` for `$item`, a page's own `$template` spliced in, and for a `$cond` a `$cond` of two templates, one per value;
- a value json-render has no way to read there, such as `$index` or `{ "$item": "" }` in a template or a `$template` in a condition, is an `extract` finding at the layout's element, with `via`: the element stays in the page model, shown, so no rule passes on it unseen;
- a value from outside a layout that reads a repeat item, used inside a repeat of the layout, is an `extract` finding: it would read the layout's item;
- a layout that draws itself is drawn once, as an unresolved element, and the rules that depend on it say they cannot tell.

Each expanded element keeps where it is written and `via`: the layout uses that draw it, nearest first (`LayoutUse` in [`src/extract/model.ts`](src/extract/model.ts)). A finding about it is at the layout's element, with `via` naming the page's use (or, for an element a page passed into a slot, where the layout places it), and its words name both: `Button.Root "Book room" at layouts/room-details.json:11:5 (in layout "room-details" used at pages/booking.json:21:5)`. A parameter value a rule depends on that core cannot resolve, such as text read from state the page changes, makes the rule say it cannot tell, which fails it, as for any value. `specLayouts(prototype, config)` lists a prototype's layouts with their parameters and uses, and `layoutPreview(prototype, config, id)` writes a one-page prototype that draws one layout alone with its examples, which the web app renders as its preview. Parameters are core's own format, not json-render's: [docs/trials/json-render.md](../../docs/trials/json-render.md#after-the-trial) says why.

Layout membership is unchanged: a layout is in the manifest and in `inventories.layouts`, and adding one is an inventory change with a rule and examples.

`specCatalog(config)` ([`src/spec/catalog.ts`](src/spec/catalog.ts)) is the catalog a spec is written from: the parts of the inventoried components, described in `library.parts` (generated from the library's declarations by [`scripts/describe-library.mjs`](scripts/describe-library.mjs); Todae 0.11.3's is [`libraries/todae-0.11.3.json`](libraries/todae-0.11.3.json), and [`libraries/todae-0.10.1.json`](libraries/todae-0.10.1.json) stays for projects stored on 0.10.1), plus `Page` and `Layout`. Core reads each file with its own JSON parser, which keeps every key's position, validates every element against the catalog ([`src/spec/read.ts`](src/spec/read.ts)), and builds the same page model the extractor builds ([`src/spec/model.ts`](src/spec/model.ts)), so every rule runs unchanged; what the catalog refuses is the `extract` rule's finding and does not render. A prop the description records as `unknown` is left out of the catalog (`unknownProps` names it), and a spec that sets it is refused: its type could not be read, so no value could be checked. `resolvePageSpec` gives a frame one page as one spec. Core has no json-render dependency. The legal Nook prototype as specs, and its illegal and refused cases, are under [`examples/nook/prototypes/spec/`](examples/nook/prototypes/spec/). [docs/trials/json-render.md](../../docs/trials/json-render.md) is the trial that built it and what it found.

## Bring your own library

A project can render with any React component library on npm whose styles are a plain CSS file. Onboarding one is three steps, each deterministic, and none of them guesses on the project's behalf.

**Describe it.** [`scripts/describe-library.mjs`](scripts/describe-library.mjs) takes a package name and an exact version and writes its parts and props, the file `library.parts` carries, from the package's own TypeScript declarations:

```sh
node packages/core/scripts/describe-library.mjs @mantine/core 9.7.4 --out packages/core/libraries/mantine-core-9.7.4.json
node packages/core/scripts/describe-library.mjs @mantine/core 9.7.4 --only Accordion,Button,MantineProvider --out parts.json
```

It reads the copy installed in this repository's `node_modules` when that is the version asked for, and otherwise installs that version alone into `node_modules/.cache/design-harness/libraries/`, with npm's `--before` at the moment the version was published, so its dependencies and React's types resolve the same on every run. A part is a plain component (`Button`), or a capitalised member of an export (`Button.Root`, `Accordion.Item`, a namespace's `Callout.Root`); a generic, polymorphic component is read as a JSX tag instantiates it, with its default element. A prop is a `boolean`, a `number`, a `string` (any union that takes any string, such as `ReactNode`, since a spec gives text), an `enum` of a union's string literals (the open-string idiom `"a" | (string & {})` and a responsive `"1" | { md: "1" }` read as their literals), or `unknown`: an object, a union of unlike types, `any`. A prop is bindable when its `on<Prop>Change` reports a value the prop takes back. It lists the library's style props in `styleProps`: `style`, `className`, `sx` and `css` by name, and every prop a part takes from a set of the library's own named like `MantineStyleProps` or `SystemProps`, with the sets it found. The same package, version and TypeScript give byte-identical output; [`test/library.test.ts`](test/library.test.ts) holds Todae's description to the committed file and reads a fixture library with every kind of part and prop. `--only` keeps the parts of some exports, for a config that carries what it inventories.

**Draft its roles.** `draftRoles(description)` ([`src/library/roles.ts`](src/library/roles.ts)) proposes the role mapping from names, props and enum values, each guess with a confidence (`high`, `medium`, `low`) and its evidence: `action` is the Button family's root part; `primary-action` and `secondary-action` are its `variant` (or `kind`, `intent`, `appearance`, ...) values `primary` (else `solid`, `filled`, ...) and `secondary` (else `outline`, `soft`, ...); `disclosure` is a `Disclosure`, `Details`, `Collapsible` or `Accordion` family's root, or its `Item` when it has one, and `disclosure-summary` its `Summary`, `Trigger` or `Control`; `question` is a `Field`, `FormField`, `TextField` or `TextInput`. Declarations never say which value a part draws with no prop, so `primary-action` always drafts `whenMissing: true` at no more than medium confidence, saying so. What it cannot find is listed in `missing` with why, and `missingRoleEffects(rules, roles)` says what each rule that selects a missing role will do: a rule that selects a role mapped to no part could never fire, so the config is refused until the rule leaves the project or a part is mapped. It also proposes excluding the description's style props (`excludedProps`, high confidence, with the sets they came from as evidence): they style a part around the library's variants and tokens, the inline-style escape hatch `no-inline-styles` closes in TSX. `node packages/core/scripts/draft-roles.mjs <description.json>` prints the draft.

**Confirm it.** A draft is never applied by itself. `confirmRoles(description, confirmation)` takes what a person decided, the roles they `accept` and each `correction` with `why`, and returns the `roles` a config carries and a record of each decision; it refuses a role left undecided, an accepted role the draft has no guess for, a correction with no reason or equal to the draft, and a part or enum value the library lacks. A library with no part for a role is confirmed as a correction to `{ "components": [] }`, saying so. When the draft proposes excluded props, the confirmation must decide them too: `"excludedProps": "accept"`, or a list of names and patterns with why; the result carries the `excludedProps` a config sets. `draft-roles.mjs <description.json> --confirm <confirmation.json>` is the same step on the command line, and the web app's wizard will call the same function.

On Todae 0.11.3, as on 0.10.1, the draft is Nook's hand-written roles exactly, `primary-action` at medium confidence because of `whenMissing`. On Mantine 9.7.4 it drafts `Button` with `variant` `filled` and `outline`, `Accordion.Item` and `Accordion.Control`, and `TextInput`; Tally's [`roles.json`](examples/tally/roles.json) accepts five, corrects `question` to `NumberInput` and `TextInput`, with why, and accepts excluding Mantine's 56 style props (`bg`, `c`, `m`, `p`, `w`, `fz`, `style`, `className` and the rest), which cuts Tally's catalog instructions for the agent from 45,995 characters to 14,229, and [`test/tally.test.ts`](test/tally.test.ts) holds the config's roles to that confirmation.

Limits:

- React only: a part is a function or class component a JSX tag can name.
- Styles must be a plain CSS file in the package (`library.stylesheets`), which a frame loads as it is. A library whose components import their CSS, or inject it from a CSS-in-JS runtime, does not render in a frame.
- A library that needs a provider or theme root names it as `library.root`; the frame and the code export wrap every page in it.
- What fails closed: a prop whose type cannot be read is `unknown`, left out of the catalog and refused in a spec, and so is an excluded style prop, with a refusal that names it; a required one puts the part in `needs`, so the catalog leaves the part out. A prop inherited from React's DOM attributes is left out, except `id` and `aria-label`. A part whose children must be raw HTML elements needs a word the types do not say (`OVERRIDES` in the script).
- What it reads loosely, and says so: a responsive or open-string union is read as its literals, and any union that takes a string as `string`. Defaults are not read.
- A large library's description is large (Mantine's is 3 MB, its style props on every part), so a config may carry only the parts it inventories (`--only`).
- Style props are recognised by name and by the name of the set that declares them; a library whose style props sit in a set named otherwise needs its names in `excludedProps` by hand. `excludedProps` governs specs; in a TSX prototype only `style` is refused, by `no-inline-styles`.

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
| `isolation` (named built-in): prototype code reaches only its imports and plain language built-ins (below) | `{ "type": "isolation", "id": "no-ambient-globals" }` |
| `flow` (named built-in): `state-coverage`, `step-budget` | `{ "type": "flow", "id": "step-budget", "check": "step-budget" }` |
| `rendered` (named built-ins over snapshots): `target-size`, `headings`, `contrast`, `accessible-names`, `first-view`, `no-sideways-scroll` | `{ "type": "rendered", "id": "target-size", "check": "target-size", "minPx": { "cap": "TARGET_MIN_PX" } }` |

`step-budget` measures every route from a task's start to its success state that never returns to a state it passed, and fails the longest one over the task's max steps, not only the shortest. Rendered rules read `RenderedSnapshot`s ([`src/rendered/types.ts`](src/rendered/types.ts)): per scenario and view, the page's content width and the width it lays out in (`viewportWidth`, less a vertical scrollbar drawn beside the page), and the elements with role, accessible name, rect, heading level, whether a control is turned off (`disabled`, which WCAG 1.4.3 exempts from contrast), and painted colours (with `overImage` when an image or gradient lies under the text, which makes contrast unverifiable rather than passed). The web app produces them from the live page in each frame. Without snapshots they report `not-run` and the report is `incomplete`; with them, a scenario and view with no snapshot is unverifiable. A rendered finding about one element carries `element`, its index in that snapshot's `elements`, so the app can point at it on the page.

### A rule in words

`describeRule(rule, config)` ([`src/engine/words.ts`](src/engine/words.ts)) says a rule in plain words, generated from its data, never written per rule. It names what a rule selects with the same selector describer that writes the engine's findings, so the words a reviewer reads before adoption match the messages the rule gives after it, and it names a cap with its value in the config. Two of its outputs, for a rule a proposal adds and for a built-in:

```text
{ "type": "count", "id": "one-toast-per-page", "scope": "page", "select": { "component": "Toast.Root" }, "max": 1 }
  Each page holds at most 1 Toast.Root.
{ "type": "slot", "id": "primary-slot", "slot": "$primary", "holds": { "role": "primary-action" }, "min": 1, "max": 1, "only": { "role": "primary-action" } }
  The primary slot of each action page holds exactly 1 primary action at its top level, and holds nothing at its top level but primary actions.
```

A rule's `description`, when it has one, is its author's; the generated words are the rule's own.

### Built-in rules

[`BUILT_IN_RULES`](src/builtins.ts) carries agent-design-loop's checks over. Each is data; the ones whose type is a named check rather than a selector rule are marked.

| Rule | Type | From agent-design-loop |
| --- | --- | --- |
| `components-from-inventory`, `imports-from-library`, `page-types-from-inventory`, `layouts-from-inventory`, `flow-states-from-inventory` | membership (named subjects) | `lint:product-ui`, `check:inventories` |
| `no-raw-controls`, `no-inline-styles` | count, source | `lint:product-ui` |
| `page-structure` | page-structure (named) | the page shells |
| `no-ambient-globals` | isolation (named) | new: a prototype runs in the frame that measures it |
| `primary-slot`, `body-from-layouts` | slot | `lint:slots`, page bodies from content layouts |
| `one-primary-per-page`, `primary-is-rank-1`, `rank-1-shown`, `disclosed-sections` | count | `check:priority` |
| `rank-2-secondary` | requires | `check:priority` |
| `primary-outside-disclosure`, `disclosure-depth` | containment | `check:priority`, `check:disclosure` |
| `disclosures-per-page` | count | `check:disclosure` |
| `no-page-inside-a-page`, `no-primary-on-collection-or-content`, `visible-questions` | count | `check:one-thing` |
| `counted-parts-reached` | reachable | the "not reached from any page" failures |
| `state-coverage`, `step-budget` | flow (named) | `check:state-coverage`, `check:step-budget` |
| `target-size`, `accessible-names`, `heading-structure`, `text-contrast`, `rank-1-in-first-view`, `no-sideways-scroll` | rendered (named) | `check:target-size`, `check:accessible-names`, `check:rendered-page` |

### What prototype code may reach

A prototype runs in the same frame as the code that measures it and posts its snapshot, so code that could reach the frame's window, its document, its channel to the app, or the built-ins the measuring code calls could change what its own frame reports. Now that a model writes prototype code, `no-ambient-globals` closes that from the source side. The extractor scans every file, rendered or not, with its own scope analysis (imports, declarations, parameters, `var` hoisting, catch and loop bindings; type-only code is skipped) into `model.ambient`, and the rule fails on each use:

| The source has | Finding |
| --- | --- |
| a free name that is not on the allowlist of plain ECMAScript built-ins (`Math`, `JSON`, `Number`, `String`, `Boolean`, `Array`, `Object`, `Map`, `Set`, `WeakMap`, `WeakSet`, `Symbol`, `BigInt`, `Date`, `Intl`, `RegExp`, `Promise`, the `Error` types, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, the URI functions, `console`, `undefined`, `NaN`, `Infinity`, `arguments`): `window`, `document`, `globalThis`, `self`, `parent`, `top`, `postMessage`, `addEventListener`, `eval`, `Function`, `setTimeout` and every other timer, `fetch`, or any name it does not know | violation: uses `window`, which is the frame's window or document |
| `Object` or `JSON` other than as `Object.assign`, `freeze`, `fromEntries`, `hasOwn`, `is`, `isFrozen`, `keys`, `JSON.parse` or `stringify` (`Object.values` or `entries` would enumerate an event's values, a path to its window), `JSON.stringify` with a replacer, `Object.assign` into anything but a new `{}` | violation |
| a property name, read or destructured, that leads from an ordinary value to a constructor or prototype (`constructor`, `prototype`, `__proto__` and every `__` name, `getPrototypeOf`, `defineProperty` and kin, `prepareStackTrace`), from a DOM node or event to the frame's document or window (`ownerDocument`, `defaultView`, `parentNode`, `getRootNode`, `target`, `currentTarget`, `view`, `nativeEvent`, ...), the frame's plumbing (`postMessage`, `addEventListener`, `dispatchEvent`), a global by name (`window`, `document`, `parent`, `top`, `setTimeout`, ...), or markup run as code (`innerHTML`, `insertAdjacentHTML`, `srcdoc`) | violation: reads `.target`, which leads from an event to a DOM node or the frame's window |
| a property read or destructured by a key computed at run time (`rooms[key]`; a string or number literal key is read like a name) | unverifiable: cannot tell what it reaches, which fails the rule |
| an assignment to a property, `delete`, `++` on a property (`numbers.round = ...` through any alias) | violation: built-ins the measuring code calls cannot be changed |
| `useRef`, `createRef`, `useImperativeHandle` (imported or as a member), a `ref` prop, `dangerouslySetInnerHTML`, `srcDoc`, or a `<script>`, `<iframe>`, `<object>`, `<embed>`, `<base>`, `<meta>`, `<link>` element | violation: hands prototype code a DOM node or runs markup as code |
| `import.meta` | violation |

`require` is left to the `imports-from-library` rule, which already reports every call. Prototypes are built from library parts, React and plain data, and the legal Nook prototype uses none of these; nothing legitimate in it needed one. What the rule costs a prototype: event handlers cannot read `event.target` (library parts such as Todae's `Field.Select` hand over values through `onValueChange`), records cannot be looked up by a computed key (keep them in an array and `.find`), and a prop cannot be named `target`, `view` or `parent` when it is destructured.

The rule is a source rule and cannot see what a library part hands to a callback at run time; it refuses the names that lead from such a value to the frame, and the ways to enumerate an object's values without naming them. The web app adds runtime defences of its own (apps/web/README.md, Isolation), so the rule and the frame together keep a frame's snapshot its own. The illegal fixtures `ambient-*` show each kind: a message posted to the app, a timer, a computed key, a path to the Function constructor, a patched `Math`, a ref, and `event.target`.

## The report

`CheckReport` ([`src/engine/report.ts`](src/engine/report.ts)) is `{ status, rules, findings }`. Each `RuleReport` is `{ rule, type, status, description?, note?, findings }` with status `pass`, `fail` or `not-run`. A `Finding` is `{ rule, kind, message, file?, line?, column?, page?, scenario?, state?, view?, element?, via?, targets? }`; the field names follow agent-design-loop's `Finding`, and `via` is set on a finding inside a spec layout instance (above). Rules are ordered with `extract` first and then by id, and findings by rule, file, line, column, page, scenario, view, element, via, targets, kind and message, using code-unit order, never the runtime's locale.

`targets` lists every element a finding is about, so each can be pointed at wherever it renders: each `FindingTarget` is `{ file, line, column, via?, page?, key? }`, where it is written, the page it is on and, in a spec prototype, its key in the expanded page (the page model's `ElementNode.key`), which carries the layout instance's scope: `details/access` is element `access` of the instance keyed `details`, and a Page's slot is `<page root>/slots/<name>`. A TSX element is found by where it is written. Every element-level finding of the `count`, `slot`, `containment`, `requires`, `prop-values`, `reachable`, `page-structure` and component `membership` rules carries them: a finding about several elements lists them all in the order its message names them (two primary actions, or a slot filled twice); a local component or a layout instance stands for the outermost elements it renders; an element a rule read from the source as written (`scope: "source"`, `reachable`, `components-from-inventory`) is looked up by `origin` on every page that renders it, and keeps no `page` when none does. A finding about a whole page (a slot left empty, too few of something), a flow, an import, code that reaches the frame (`no-ambient-globals`), an extraction problem or an element the extractor cannot name has none; a rendered finding points at its snapshot element with `element`. The web app outlines targets in its frames (apps/web/README.md, Element tags).

## Proposals

A proposal ([`src/proposals/types.ts`](src/proposals/types.ts)) carries an id, title, reason, notes on the states it shows, `inventory` operations, `rules` to add and remove, and `examples`: prototypes that must pass, and prototypes that must fail, each naming the rule (and optionally a message fragment) that must flag it.

```text
propose -> open -> approve -> approved -> adopt -> adopted
             \---------------- decline -----------> declined
```

No step is skipped, and `adopted` and `declined` are final. Every function takes the time and who as arguments and returns `{ ok: true, value }` or `{ ok: false, error: Refusal }`.

Two things happen to an open proposal that are not status changes, and are kept in its optional `events`, oldest first:

- `revise(config, id, draft, stamp)` replaces an open proposal's content with a new draft of the same id. Its status stays open and its status `history` is kept; the content it replaces is kept as a `revised` event with the stamp's time, who and note, so every version stays readable. A revision that says exactly what the proposal said is refused (`unchanged`), and only an open proposal can be revised: once approved, what was approved is what is adopted.
- `sendBack(config, id, stamp)` records that a reviewer sent an open proposal back, as a `sent-back` event. The note is required (`missing-note`).

Measured examples: a rendered rule needs snapshots, so a proposal that adds one is proven only on measured examples. `withExampleSnapshots(config, id, measured)` stores snapshots with each example of an open or approved proposal, by example name. It refuses a partial measurement (`incomplete-measurement`): every example, exactly one snapshot per scenario of the example and view of the config, each valid. `adopt` then runs the rendered rules on them, and the adopted proposal keeps them, so `rerunExamples` later gives the same result with no renderer. The web app measures every example in frames before it adopts.

`tryExamples(config, id)` judges every example of an open or approved proposal on its own, as `adopt` would, without stopping at the first that does not behave: per example, whether it behaves, core's words for what happened (`adopt`'s refusal word for word when it does not), and core's whole report. `adopt` runs the same code. `newlyFailingOf(before, after, existing)` is `adopt`'s impact on the caller's prototypes for any two configs, such as the config with a proposal applied when its examples do not yet behave. An adopted proposal keeps its `classification`, since the config it was judged against is gone once adopted.

A request for a new rule type: when what a project needs cannot be said in the rule vocabulary, a proposal carries `needsRuleType` ([`src/proposals/types.ts`](src/proposals/types.ts)): `checks` (what the rule should check), `whyNot` (why no rule type can say it), and `pass` and `fail`, at least one each, examples in words (`name`, `description`, an optional `snippet`). It is a field of the proposal rather than a record of its own so that it has the proposal's lifecycle, history, send-back, revision, list and review page, and the agent's one `draft_proposal` tool, with nothing new to store or import. Such a proposal is only a request: `propose` and `revise` refuse one that also carries an inventory change, a rule or an example prototype (`invalid-proposal`), and `approve`, `tryExamples`, `dryRunAdoption` and `adopt` refuse it with `needs-rule-type`, `adopt` before it reads the status, so no state of one is adoptable. The schema refuses a stored or imported request whose history says approved or adopted. It can be sent back, revised (a revision that drops `needsRuleType` makes it an ordinary proposal again, held to adoption's rules) and declined. `ruleTypeIssue(proposal)` ([`src/proposals/request.ts`](src/proposals/request.ts)) writes it as the issue a person files: a title, and a Markdown body with what to check, why the vocabulary cannot, the examples, and where it came from. A new rule type is a code change to core; once it exists, a proposal that uses it is adopted like any other.

`adopt(config, id, stamp, existing?)` applies the operations, re-validates the config, and refuses unless:

- there is at least one passing and one failing example, and every rule the proposal adds is named by a failing example;
- every passing example passes every rule of the new config, and runs every new rule;
- every failing example fails its named rule, with its message, and no other rule;
- every example of an earlier adopted proposal still behaves as it did: its passing examples pass every rule, and its failing examples are still flagged by their rule. The one exception is a failing example whose rule this proposal removes: the example has nothing left to prove, so it is retired, not broken.

A refusal names the example and what happened instead, such as `failing example "only-one" is not flagged as it must be: "one-toast-per-page" passed it`, or, for an earlier proposal's example, `adopting "no-toasts" breaks passing example "one-toast" of adopted proposal "toast": ...` with `proposal` and `example` set on the refusal. Replacing a rule with another of the same id is not a removal: the earlier examples are held to the new rule. On success it returns the new config with the proposal adopted, a deterministic `classification` (`adds`, `tightens`, or `loosens-or-removes`, with each change's reason), the caller's `existing` prototypes that newly fail, and the earlier examples it retires. `dryRunAdoption(config, id, stamp, existing?)` tells what adopting an open or approved proposal would do without changing anything: it approves the proposal on a copy and runs `adopt`, so its result, refusal reasons included, is `adopt`'s. The web app runs it when the agent drafts a proposal and hands the refusal back to the agent. `rerunExamples(config)` re-runs every adopted proposal's examples against the config as it is now, and marks a failing example `retiredBy` the adopted proposal that removed its rule.

## Variants and picks

A variant ([`src/variants/`](src/variants/)) is another whole page for a spec prototype's page, kept beside the prototype and apart from its files, so it changes nothing until the person picks: `{ id, page, note, spec, like? }`, where `id` is a short letter ("b", shown as "Variant B"), `note` one line on what is different, `spec` the page's whole spec file, and `like` the variant it was asked to resemble. `VariantState` holds a prototype's variants and the picks applied from them; `parseVariantState` validates a stored one (strict objects, unique ids).

- `checkVariant(prototype, config, page, spec)` says whether a spec can be a variant of a page: the prototype is a spec prototype, the page is in its manifest, and the spec, put in the page's place, brings no issue of its own against the catalog and the layouts' parameters (`specIssues`; an issue the prototype already had is not the variant's). It returns the spec as core formats it, or every problem in core's words. A variant that reads but breaks a rule is a variant: `checkPrototype` on `variantPrototype(prototype, variant)` shows it failing.
- `recombine(prototype, config, page, sources, picks)` builds one page from several, slot by slot: `sources` names whole page specs (`current` and the variants' ids), and `picks` names, for every slot of the page's type, the source it comes from. Each slot takes the elements its source lists there and everything under them. What the sources share is kept apart the way layout instances are, by naming the source: an element key two sources bring is `<key>-<source>` in each, a literal element id (`id`, `htmlFor` and the ARIA id references) two sources use is `<id>-<source>` in each, so a label still names its field, and a top-level state key the sources give different values is `<key>-<source>` in each source that reads it, every `$state`, `$bindState`, `statePath` and `${/path}` following. When every slot comes from one source the result is that source whole. The result is the same text whatever order the sources, the picks or the keys inside each file come in, and it is a prototype like any other, checked by `checkPrototype`.

An example, from [`test/variants.test.ts`](test/variants.test.ts) on the Nook booking page:

```text
sources  current: the page as it is
         b: asks "For how long?", and its title has id "heading"
         c: the room is Harbor, its facts have id "heading", and its Book room button is keyed "question"
picks    title b, facts c, body b, alternate current, action c

body     ["question-b", "details"]   B's question instance; C also brings a "question"
action   ["question-c"]
ids      heading-b on the title, heading-c on the facts
state    room-b (Lantern) and room-c (Harbor); C's facts read ${/room-c/seats}
```

`pickScope(before, after, prototype, page)` says what a pick on one page answers for, given core's report on the prototype as it is and on the prototype with the page replaced. It sorts every finding of `after`: `page` (about the picked page: the finding names the page, one of its scenarios, its file, or a layout its file draws), `introduced` (elsewhere, and not in `before` word for word, so the change brought or changed it, as a flow or step-budget finding would be), and `existing` (elsewhere, and in `before` exactly as it is). `stopped` lists rules that ran in `before` and did not run in `after`. `clear` is true when `page`, `introduced` and `stopped` are all empty: a failure another page already had never blocks. It is pure, compares findings as a multiset, and keeps core's order.

A pick is the person's alone: core has no function that applies one, and a pick is recorded (`PickRecord`: the time, the page, which source supplied each slot, each variant's note, and the page's file before and after) by the app that applied it, so it can be undone.

## Code export

`specToTsx(prototype, config)` ([`src/export/tsx.ts`](src/export/tsx.ts)) writes a spec prototype as the TSX a person would write, one file per page and per layout at the spec file's path with `.tsx`, and the same manifest. It writes what core read of the specs, so an element the catalog refused is not in it:

| Spec | TSX |
| --- | --- |
| a page's `state` | a module constant for what nothing changes, `useState` for what a bound prop or an action writes |
| `/scenario/state`, `/scenario/id` | the page's `state` and `scenario` props (`PageProps`) |
| a layout and its parameters | a component whose props are its parameters: a binding is a value and an `on<Name>Change` callback, a slot is a `ReactNode`, a default is a destructuring default; what a layout reads of its page's state is a prop too |
| `visible` | `cond && <El />` |
| `$cond` | `cond ? a : b` |
| `repeat` | `list.map((item) => <El key={item.key} />)` |
| `$template` | text and expressions, `{room.seats} seats, {room.floor}` |
| `$scopedId` | `useId()`, with the item's key inside a keyed repeat |
| `{ "$param": name }` in a condition, `${$param:name}` in a template | the parameter's prop: `detail === "seats" && <El />`, `{verb} {room.name}` |
| setState, pushState, removeState | the state's setter in an `onClick` |
| an element nothing lists | kept as JSX nothing renders, so the export checks as the spec does |

`exportReactProject({ config, prototype, name, at, checks? })` ([`src/export/project.ts`](src/export/project.ts)) puts it in a runnable Vite project: the prototype under `src/prototype/` with its `manifest.json`, `src/page-kit.tsx` (`Slot`, `PageProps` and the page shell, which `vite.config.ts` and `tsconfig.json` alias as `@design-harness/page`), `src/scenarios.ts`, `src/main.tsx` (the entry, with a scenario switcher and `?scenario=<id>`), `index.html`, `tsconfig.json`, a `package.json` pinning the config's exact library and React versions and `EXPORT_TOOLING` (Vite, TypeScript and React's types at the versions this repository builds with), and a README saying where it came from. A TSX prototype goes in with its files as they are. Pages and layouts import only the library, React and the page kit.

The export is checkable: [`test/export-equivalence.test.ts`](test/export-equivalence.test.ts) reads it back as a TSX prototype with the same manifest and compares core's reports. Every rule's id and status, and its findings' kinds and count, match the spec's, for the legal Nook spec, every illegal spec fixture, a page with actions, conditions, templates and repeats, and a layout that reads its parameters in conditions and templates. Messages are not compared: they name the file and line, which are JSON in the spec and TSX in the export. It cannot hold for the `extract` rule where the catalog refused part of a spec (`param-missing`, `param-wrong-type`, `param-wrong-type-in-condition`, `param-wrong-type-in-template`, `instance-of-unknown-layout` and the refused fixtures): what was refused is left out of the export, so the TSX has nothing to refuse; every other rule still agrees there. Rendered rules are compared without snapshots (both `not-run`); the web app's end-to-end test builds the exported Nook project with Vite and renders it in Chromium.

## Size

`npm run bundle:core` bundles the library for the browser platform, which refuses Node built-ins, and prints its size. At this commit it is about 532 KiB minified and 150 KiB gzipped, of which `@babel/parser` is about 310 KiB minified; the proposal review milestone added 9 KiB minified and 2.5 KiB gzipped (rule words, revisions, measured examples), the json-render trial 27.5 KiB and 9.3 KiB (the spec format), layouts with parameters 20.7 KiB and 6.0 KiB (parameters, expansion, the layout summary and preview), variants with code export 43.1 KiB and 14.9 KiB (variant checks, recombination, the TSX writer and the project around it), parameters in conditions and templates about 7 KiB and 2 KiB, and library onboarding 10.8 KiB and 3.7 KiB (the role drafter and its confirmation, unknown props, the library's root part). The parser is the one runtime dependency: it parses TSX with positions in the browser, synchronously, with no WebAssembly to load.
