import todae from "../../libraries/todae-0.10.1.json";
import { BUILT_IN_RULES } from "../../src/builtins";
import type { PartDescription, ProjectConfig } from "../../src/config/types";
import type { RuleSpec } from "../../src/rules/types";

/**
 * Nook, a room booking app, as a design-harness project on Todae: the
 * built-in rules, plus one rule only a Todae project needs. Plain data, so
 * `JSON.stringify(nook)` is the config a web app would store.
 */
const todaeOnly: readonly RuleSpec[] = [
  {
    type: "prop-values",
    id: "text-as-heading-or-paragraph",
    select: { component: "Text.Root" },
    prop: "as",
    allowed: ["h1", "h2", "h3", "p", "span"],
    required: true,
    description: "Text.Root says what it is: a heading level, a paragraph or a span.",
  },
];

export const nook: ProjectConfig = {
  schemaVersion: 1,
  id: "nook",
  name: "Nook",
  library: {
    package: "@tounsoo/todae",
    version: "0.10.1",
    react: "19.3.1",
    stylesheets: ["dist/todae.css"],
    schemeAttribute: "data-appearance",
    // Todae's style props, as core's role draft proposes them: a part is styled by its variants and Todae's tokens.
    excludedProps: ["className", "style"],
    roles: {
      action: { components: ["Button.Root"] },
      "primary-action": { components: ["Button.Root"], prop: { name: "variant", values: ["primary"], whenMissing: true } },
      "secondary-action": { components: ["Button.Root"], prop: { name: "variant", values: ["secondary"], whenMissing: false } },
      disclosure: { components: ["Disclosure.Root"] },
      "disclosure-summary": { components: ["Disclosure.Summary"] },
      question: { components: ["Field.Root"] },
    },
    // Every part of Todae 0.10.1, generated from its declarations, for spec prototypes.
    parts: todae.parts as Readonly<Record<string, PartDescription>>,
  },
  inventories: {
    components: ["Alert", "Button", "Card", "Disclosure", "EmptyState", "Field", "Label", "Stack", "Text"],
    layouts: ["room-cards", "room-details", "select-question"],
    pageTypes: [
      { id: "booking", kind: "action", slots: ["title", "facts", "body", "alternate", "action"], chrome: ["title", "facts", "alternate"], primarySlot: "action" },
      { id: "rooms", kind: "collection", slots: ["title", "intro", "body"], chrome: ["title", "intro"] },
    ],
    flowStates: ["rooms", "room-open", "booked", "held"],
  },
  inputs: {
    tasks: [
      { id: "book-room", description: "Pick a free room and book it", successState: "booked", maxSteps: 3 },
      { id: "hold-room", description: "Pick a free room and hold it while you decide", successState: "held", maxSteps: 2 },
    ],
    ranking: [
      { action: "Book room", rank: 1, level: "primary" },
      { action: "Hold room", rank: 2, level: "secondary" },
    ],
    disclosedSections: ["Room details"],
    caps: {
      MAX_DISCLOSURE_DEPTH: { value: 1, stricter: "lower", description: "Room details are the one disclosure; nothing nests under them." },
      MAX_DISCLOSURES_PER_PAGE: { value: 1, stricter: "lower" },
      MAX_VISIBLE_QUESTIONS: { value: 1, stricter: "lower", description: "One question per page outside a disclosure: how long to book for." },
      TARGET_MIN_PX: { value: 24, stricter: "higher", description: "WCAG 2.5.8 Target Size (Minimum)." },
    },
  },
  views: [
    { name: "desktop", width: 1280, height: 900, scheme: "light" },
    { name: "phone", width: 390, height: 844, scheme: "light" },
  ],
  rules: [...BUILT_IN_RULES, ...todaeOnly],
  proposals: [],
};
