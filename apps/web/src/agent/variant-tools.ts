import { checkPrototype, checkVariant, formatSpec, nextVariantIds, parseJson, variantLabel, variantPrototype, type JsonValue, type ProjectConfig, type Prototype, type Variant } from "@design-harness/core";
import type { JsonSchema } from "./schema";
import type { AgentHost, ToolOutcome } from "./tools";

/**
 * The agent's variant tools, for a spec prototype. The agent offers whole
 * pages beside the current one; the person compares them on the board and
 * picks, slot by slot. The agent never picks: these tools only add, revise
 * and list variants, the host they write through takes only the list of
 * variants (never a pick, never the prototype's files), and no input has a
 * field that could carry a pick, which the schemas' closed objects refuse.
 */

export const MIN_VARIANTS = 2;
export const MAX_VARIANTS = 4;

const NOTE: JsonSchema = { type: "string", minLength: 1, maxLength: 200, description: "One line on what is different about this variant." };
const SPEC: JsonSchema = { type: "object", description: 'The whole page spec: { "root", "elements", "state" }, as write_spec takes it, built only from the catalog and the prototype\'s layouts.' };
const ID: JsonSchema = { type: "string", pattern: "^[a-z]{1,3}$", description: 'A variant\'s id, such as "b", as list_variants shows it.' };

export const VARIANT_TOOL_SCHEMAS = {
  propose_variants: {
    type: "object",
    properties: {
      page: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", description: "The manifest page they are variants of." },
      variants: { type: "array", minItems: MIN_VARIANTS, maxItems: MAX_VARIANTS, items: { type: "object", properties: { note: NOTE, spec: SPEC }, required: ["note", "spec"], additionalProperties: false } },
      like: { ...ID, description: "When the person asked for more like one variant: its id." },
    },
    required: ["page", "variants"],
    additionalProperties: false,
  },
  revise_variant: {
    type: "object",
    properties: { id: ID, spec: SPEC, note: NOTE },
    required: ["id", "spec"],
    additionalProperties: false,
  },
  list_variants: { type: "object", properties: {}, additionalProperties: false },
} as const satisfies Record<string, JsonSchema>;

export const VARIANT_TOOL_DESCRIPTIONS: Readonly<Record<keyof typeof VARIANT_TOOL_SCHEMAS, string>> = {
  propose_variants:
    "Offer 2 to 4 variants of one page, for the person to compare side by side and pick from, slot by slot. Each is a complete page spec, as write_spec takes it, built only from the catalog and the prototype's existing layouts, with one line on what is different about it. Core checks each against the catalog first: if any has an issue, none is kept, and the issues come back. A variant may still break a rule: the board shows it failing in core's words, and the person cannot pick it until it passes (fix it with revise_variant). Variants are kept beside the prototype and do not change it. Only the person picks; no tool applies a pick.",
  revise_variant:
    "Replace one variant's spec, such as one the person asked you to fix, keeping its id. Core checks it against the catalog first; one with any issue is not kept. It does not change the prototype, and it never applies a pick.",
  list_variants: "List the variants kept for this prototype: each one's id, page, note, the variant it was asked to be like, and core's checks of it without frames. Picks the person applied are listed with which variant supplied each slot.",
};

const refused = (title: string, content: string): ToolOutcome => ({ content, isError: true, changed: false, title });

/** Core's report on a variant without frames, in a line: rendered rules need the board's frames, which measure it. */
export function variantVerdict(config: ProjectConfig, prototype: Prototype, variant: Variant): string {
  const report = checkPrototype({ config, prototype: variantPrototype(prototype, variant) });
  const failing = report.rules.filter((rule) => rule.status === "fail");
  if (failing.length === 0) return "passes every rule core checks without frames; the board measures the rendered ones";
  return `fails ${failing.map((rule) => `${rule.rule} (${rule.findings.slice(0, 2).map((finding) => finding.message).join("; ")})`).join(", ")}`;
}

function specText(spec: unknown): string {
  return JSON.stringify(spec as JsonValue);
}

export function proposeVariants(host: AgentHost, input: { page: string; variants: { note: string; spec: unknown }[]; like?: string }): ToolOutcome {
  const prototype = host.prototype();
  const config = host.config();
  const state = host.variants();
  if (input.like !== undefined && !state.variants.some((variant) => variant.id === input.like)) return refused("propose_variants: no such variant", `There is no variant "${input.like}" to be like. list_variants shows them.`);
  const page = prototype.pages.find((item) => item.id === input.page);
  const text = page ? prototype.files[page.component.file] : undefined;
  const parsed = text === undefined ? null : parseJson(text);
  // The page as core formats it, so a variant that only reformats it is the page as it is.
  const current = parsed?.ok ? formatSpec(parsed.value) : text;
  const problems: string[] = [];
  const texts: string[] = [];
  input.variants.forEach((variant, index) => {
    const checked = checkVariant(prototype, config, input.page, specText(variant.spec));
    if (!checked.ok) problems.push(`Variant ${index + 1} ("${variant.note}"):\n${checked.error.join("\n")}`);
    else if (checked.value === current) problems.push(`Variant ${index + 1} ("${variant.note}") is the page as it is now; a variant differs from it.`);
    else if (texts.includes(checked.value)) problems.push(`Variant ${index + 1} ("${variant.note}") is the same spec as variant ${texts.indexOf(checked.value) + 1}.`);
    texts.push(checked.ok ? checked.value : "");
  });
  if (problems.length > 0) return refused("propose_variants: none kept", `None of the variants was kept, since core refused part of them:\n${problems.join("\n")}`);
  // An id a pick names is never given again, so a pick's record keeps naming the variant it took.
  const ids = nextVariantIds([...state.variants.map((variant) => variant.id), ...state.picks.flatMap((pick) => Object.values(pick.slots))], input.variants.length);
  const added: Variant[] = input.variants.map((variant, index) => ({ id: ids[index] as string, page: input.page, note: variant.note, spec: texts[index] as string, ...(input.like !== undefined ? { like: input.like } : {}) }));
  host.saveVariants([...state.variants, ...added]);
  const lines = added.map((variant) => `- ${variantLabel(variant.id)} (id "${variant.id}"): ${variant.note}. Core ${variantVerdict(config, prototype, variant)}.`);
  return {
    content: `Kept ${added.length} variants of page "${input.page}" beside the prototype, which is unchanged:\n${lines.join("\n")}\nThe board shows them side by side, measured in frames. The person picks, slot by slot; fix a failing variant with revise_variant.`,
    isError: false,
    changed: false,
    title: `Offered ${added.length} variants of ${input.page}`,
    variants: { page: input.page, ids: added.map((variant) => variant.id) },
  };
}

export function reviseVariant(host: AgentHost, input: { id: string; spec: unknown; note?: string }): ToolOutcome {
  const prototype = host.prototype();
  const config = host.config();
  const state = host.variants();
  const existing = state.variants.find((variant) => variant.id === input.id);
  if (!existing) return refused(`revise_variant: no variant ${input.id}`, `There is no variant "${input.id}". list_variants shows them.`);
  const checked = checkVariant(prototype, config, existing.page, specText(input.spec));
  if (!checked.ok) return refused(`revise_variant: ${input.id} not changed`, `Core refused the spec, so variant "${input.id}" is unchanged:\n${checked.error.join("\n")}`);
  if (checked.value === existing.spec && (input.note === undefined || input.note === existing.note)) return { content: `Variant "${input.id}" already has exactly this spec; nothing changed.`, isError: false, changed: false, title: `Revised ${variantLabel(input.id)} (unchanged)` };
  const revised: Variant = { ...existing, spec: checked.value, ...(input.note !== undefined ? { note: input.note } : {}) };
  host.saveVariants(state.variants.map((variant) => (variant.id === input.id ? revised : variant)));
  return {
    content: `Revised ${variantLabel(input.id)} of page "${existing.page}". Core ${variantVerdict(config, prototype, revised)}. The prototype is unchanged; the person picks.`,
    isError: false,
    changed: false,
    title: `Revised ${variantLabel(input.id)}`,
    variants: { page: existing.page, ids: [input.id] },
  };
}

export function listVariants(host: AgentHost): ToolOutcome {
  const prototype = host.prototype();
  const config = host.config();
  const { variants, picks } = host.variants();
  const content = JSON.stringify(
    {
      variants: variants.map((variant) => ({ id: variant.id, page: variant.page, note: variant.note, ...(variant.like ? { like: variant.like } : {}), checks: variantVerdict(config, prototype, variant) })),
      picks: picks.map((pick) => ({ at: pick.at, page: pick.page, slots: pick.slots, ...(pick.undone ? { undone: true } : {}) })),
    },
    null,
    1,
  );
  return { content, isError: false, changed: false, title: `Listed ${variants.length} ${variants.length === 1 ? "variant" : "variants"}` };
}
