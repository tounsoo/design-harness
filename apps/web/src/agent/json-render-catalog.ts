import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";
import type { PropSchema, SpecCatalog } from "@design-harness/core";

/**
 * Core's catalog as a json-render catalog, for its prompt. Loaded only when
 * a spec prototype's agent first needs it: json-render's core pulls in zod,
 * about 450 kB minified, which the rest of the app does not need.
 *
 * Each catalog prop becomes the zod type json-render's prompt describes;
 * slots are json-render's (`default` for children, a Page's named slots).
 * Core stays the judge: json-render's own `catalog.validate` checks only
 * that a type is in the catalog when there is more than one component (its
 * props schema is a record of unknowns then), so it is not used here.
 */

function zodOf(prop: PropSchema): z.ZodType {
  const base = prop.type === "enum" ? z.enum(prop.values as [string, ...string[]]) : prop.type === "options" ? z.array(z.object({ value: z.string(), label: z.string() })) : prop.type === "number" ? z.number() : prop.type === "boolean" ? z.boolean() : z.string();
  return prop.required ? base : base.optional();
}

export function jsonRenderCatalog(catalog: SpecCatalog) {
  const components = Object.fromEntries(
    Object.entries(catalog.components).map(([name, component]) => [
      name,
      { props: z.object(Object.fromEntries(Object.entries(component.props).map(([prop, schema]) => [prop, zodOf(schema)]))), slots: [...component.slots], description: component.description },
    ]),
  );
  return defineCatalog(schema, { components, actions: {} });
}

/** The rules a spec here follows that json-render's default prompt does not say, or says otherwise. */
export const SPEC_RULES: readonly string[] = [
  "In this app you never write JSONL patches in your reply. Every patch line goes in the patches field of the patch_spec tool, for one spec file at a time; write_spec writes a whole file. Ignore the instruction above to output only JSONL.",
  'Each page is one spec file whose root element is a Page. The Page holds the page in its "slots", one entry per slot of its page type; its "children" stay empty. Never put a Page anywhere else.',
  'Each layout is one spec file of its own. Draw it on a page with { "type": "Layout", "props": { "id": "<layout id>" }, "children": [] }, in a body slot: a page\'s body holds only layouts.',
  "Only a page spec has state; a layout reads the state of the page it is drawn on. The harness sets /scenario in the state for each scenario: /scenario/state is its flow state and /scenario/id its id. Show what depends on the flow state with visible, such as { \"$state\": \"/scenario/state\", \"eq\": \"booked\" }. Never write /scenario.",
  "A part's own text goes in its text prop. Field.Select takes its options as data in its options prop.",
  "Use only the expressions $state, $item, $index, $bindState, $template and $cond. Do not use watch, $computed, $bindItem or validateForm; bind only setState, pushState and removeState, only to press on an action. The checks refuse anything else.",
  "The checks, not you, decide whether a spec is valid. Keep every element's key stable when you change it, so findings keep pointing at the same line.",
];

/** json-render's prompt for the catalog, with the rules above. */
export function catalogPrompt(catalog: SpecCatalog): string {
  return jsonRenderCatalog(catalog).prompt({ customRules: [...SPEC_RULES], editModes: ["patch"] });
}
