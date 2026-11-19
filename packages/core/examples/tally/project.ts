import mantine from "./mantine-parts.json";
import { BUILT_IN_RULES } from "../../src/builtins";
import type { PartDescription, ProjectConfig } from "../../src/config/types";
import type { RuleSpec } from "../../src/rules/types";

/**
 * Tally, an expense report app, as a design-harness project on Mantine
 * (@mantine/core 9.7.4): the second worked example, on a library that is not
 * Todae. Its library parts are the ones it inventories, written by
 * `describe-library.mjs @mantine/core 9.7.4 --only ...` (Mantine's whole
 * description, `libraries/mantine-core-9.7.4.json`, is 3 MB), and its roles
 * are core's draft confirmed in `roles.json`, one correction recorded there,
 * with the draft's excluded style props.
 * Every page renders inside MantineProvider, which takes the view's scheme.
 * Plain data, so `JSON.stringify(tally)` is the config a web app would store.
 */
const mantineOnly: readonly RuleSpec[] = [
  {
    type: "prop-values",
    id: "title-order",
    select: { component: "Title" },
    prop: "order",
    allowed: [1, 2, 3],
    required: true,
    description: "A Title says its heading level, 1 to 3: Mantine draws a Title with no order as an h1.",
  },
];

export const tally: ProjectConfig = {
  schemaVersion: 1,
  id: "tally",
  name: "Tally",
  library: {
    package: "@mantine/core",
    version: "9.7.4",
    react: "19.3.1",
    stylesheets: ["styles.css"],
    root: { component: "MantineProvider", schemeProp: "forceColorScheme" },
    // Mantine's style props (bg, c, m, p, w, fz, style, className and the rest), as the describer found them and roles.json accepts: styling comes from Mantine's variants and tokens.
    excludedProps: mantine.styleProps.names,
    roles: {
      action: { components: ["Button"] },
      "primary-action": { components: ["Button"], prop: { name: "variant", values: ["filled"], whenMissing: true } },
      "secondary-action": { components: ["Button"], prop: { name: "variant", values: ["outline"], whenMissing: false } },
      disclosure: { components: ["Accordion.Item"] },
      "disclosure-summary": { components: ["Accordion.Control"] },
      question: { components: ["NumberInput", "TextInput"] },
    },
    parts: mantine.parts as Readonly<Record<string, PartDescription>>,
  },
  inventories: {
    components: ["Accordion", "Button", "Card", "NumberInput", "Stack", "Text", "TextInput", "Title"],
    layouts: ["amount-question", "expense-cards", "receipt-rules"],
    pageTypes: [
      { id: "expense", kind: "action", slots: ["title", "facts", "body", "alternate", "action"], chrome: ["title", "facts", "alternate"], primarySlot: "action" },
      { id: "expenses", kind: "collection", slots: ["title", "intro", "body"], chrome: ["title", "intro"] },
    ],
    flowStates: ["expenses", "expense-open", "submitted", "saved"],
  },
  inputs: {
    tasks: [
      { id: "submit-expense", description: "Open an expense and submit it for approval", successState: "submitted", maxSteps: 3 },
      { id: "save-draft", description: "Open an expense and save it to finish later", successState: "saved", maxSteps: 2 },
    ],
    ranking: [
      { action: "Submit expense", rank: 1, level: "primary" },
      { action: "Save draft", rank: 2, level: "secondary" },
    ],
    disclosedSections: ["Receipt rules"],
    caps: {
      MAX_DISCLOSURE_DEPTH: { value: 1, stricter: "lower", description: "The receipt rules are the one disclosure; nothing nests under them." },
      MAX_DISCLOSURES_PER_PAGE: { value: 1, stricter: "lower" },
      MAX_VISIBLE_QUESTIONS: { value: 1, stricter: "lower", description: "One question per page outside a disclosure: the amount." },
      TARGET_MIN_PX: { value: 24, stricter: "higher", description: "WCAG 2.5.8 Target Size (Minimum)." },
    },
  },
  views: [
    { name: "desktop", width: 1280, height: 900, scheme: "light" },
    { name: "phone", width: 390, height: 844, scheme: "dark" },
  ],
  rules: [...BUILT_IN_RULES, ...mantineOnly],
  proposals: [],
};
