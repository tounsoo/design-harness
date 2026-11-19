import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { ROLE_NAMES, dryRunAdoption, formatIssues, parsePrototype, propose, revise, type CheckReport, type JsonValue, type Variant, type VariantState, type FailingExample, type PassingExample, type ProjectConfig, type Proposal, type Prototype, type ProposalDraft } from "@design-harness/core";
import { MAX_REPLY_LENGTH, addressPin, openPins, type PinState } from "../pins/model";
import { validateInput, type JsonSchema } from "./schema";
import { SPEC_TOOL_DESCRIPTIONS, SPEC_TOOL_SCHEMAS, insertLayout, listLayouts, patchSpec, setLayoutParams, writeSpec } from "./spec-tools";
import { VARIANT_TOOL_DESCRIPTIONS, VARIANT_TOOL_SCHEMAS, listVariants, proposeVariants, reviseVariant } from "./variant-tools";

/**
 * The agent's tools. They run in the app, against the app's state: the
 * project config, the current prototype and the check session. A change goes
 * through core's validation where one exists and becomes a new revision at
 * once; the checks come back only for a revision every frame has measured.
 * No tool decides pass or fail: run_checks returns core's report, and a
 * proposal's verdict is core's adoption dry run. The agent can draft a
 * proposal and revise an open one, but never approve, decline or adopt one:
 * no tool takes a status, and no input field can carry one.
 */

/** The manifest file the agent sees beside the source files. */
export const MANIFEST = "manifest.json";

/** What a frame said instead of a snapshot, for the report the agent reads. */
export type FrameProblem = { readonly frame: string; readonly stage: string; readonly message: string };

export type Measured = { readonly revision: number; readonly report: CheckReport; readonly frames: readonly FrameProblem[] };

/** What the tools need from the app. */
export interface AgentHost {
  config(): ProjectConfig;
  /** The open prototype. Never called while `tsx` says the open one is TSX: there is no spec to give. */
  prototype(): Prototype;
  /** True while the open prototype is a stored TSX one, which takes no turn and no tool; absent where every prototype is a spec. */
  tsx?(): boolean;
  /** Makes `next` the prototype at once, as a new revision, and returns that revision. */
  apply(next: Prototype): { readonly revision: number };
  saveConfig(next: ProjectConfig): Promise<void>;
  /** Core's report for the current source, once every frame has measured that revision. */
  measured(signal: AbortSignal): Promise<Measured>;
  /** Core's report for the current source if every frame has measured it already, without waiting; null otherwise. */
  checked?(): CheckReport | null;
  /** The time, as ISO 8601, for a proposal's history. */
  now(): string;
  /** The open prototype's variants and the picks the person applied. */
  variants(): VariantState;
  /** Keeps a new list of variants. It takes only variants: a pick is the person's, and nothing here applies one or changes the prototype. */
  saveVariants(variants: readonly Variant[]): void;
  /** The notes the person pinned on the open prototype's frames (`pins/model.ts`); absent where the app keeps none. */
  pins?(): PinState;
  /**
   * Keeps the pins after the agent marked one addressed, or after the person undid the turn that did (`AgentController.undo`).
   * Nothing else of the agent's reaches them: `address_note` is the one tool that calls it.
   */
  savePins?(next: PinState): void;
}

type Tool = { readonly definition: BetaTool; readonly schema: JsonSchema };

const SLUG = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
const NOTHING: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
const MANIFEST_SCHEMA: JsonSchema = {
  type: "object",
  description: "The manifest: pages, layouts, scenarios and flow, as list_files shows them.",
  properties: {
    pages: { type: "array", items: { type: "object" }, description: 'Each { "id", "pageType", "component": { "file", "export" } }.' },
    layouts: { type: "array", items: { type: "object" }, description: 'Each { "id", "component": { "file", "export" } }.' },
    scenarios: { type: "array", items: { type: "object" }, description: 'Each { "id", "state", "page" }: one row of frames, the page rendered in that flow state.' },
    flow: { type: "object", description: '{ "states": [...], "tasks": [{ "task", "start", "transitions": [{ "from", "event", "to" }] }] }.' },
    format: { type: "string", enum: ["spec"], description: 'Optional: "spec", as list_files shows it. A prototype stays a spec either way.' },
  },
  additionalProperties: false,
};
const EXAMPLE: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string", pattern: SLUG },
    files: { type: "object", additionalProperties: { type: "string" }, description: "Files that replace or add to the current prototype's, by path." },
    remove_files: { type: "array", items: { type: "string" } },
    manifest: MANIFEST_SCHEMA,
  },
  required: ["name"],
  additionalProperties: false,
};

const WORD_EXAMPLE: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string", pattern: SLUG },
    description: { type: "string", minLength: 1, maxLength: 1000, description: "What the prototype is like, so a person can build it." },
    snippet: { type: "string", maxLength: 4000, description: "Optional: the part of a page or spec that shows it." },
  },
  required: ["name", "description"],
  additionalProperties: false,
};

/** What a proposal says, as draft_proposal and revise_proposal take it. There is no status field: a status is the user's to set. */
const PROPOSAL_FIELDS: Readonly<Record<string, JsonSchema>> = {
  title: { type: "string", minLength: 1, maxLength: 200 },
  reason: { type: "string", minLength: 1, maxLength: 2000 },
  states: { type: "array", items: { type: "object", properties: { state: { type: "string" }, note: { type: "string" } }, required: ["state", "note"], additionalProperties: false }, description: "Notes on each state the change shows: ordinary states and edge cases." },
  inventory: { type: "array", items: { type: "object" }, description: 'Inventory operations such as { "op": "add-component", "name": "Toast" }, { "op": "add-layout", "id": "..." }, { "op": "add-page-type", "pageType": {...} }, { "op": "add-flow-state", "state": "..." }, { "op": "set-cap", "name": "...", "value": 2 }.' },
  rules: {
    type: "object",
    properties: {
      add: { type: "array", items: { type: "object" }, description: "Rules in the rule vocabulary, as read_project shows them. To change a rule in force, give the changed rule here under its own id and put that id in remove too: core then reads it as one change, and classifies a move of its numeric limits (min, max, depth, minPx) as stricter or looser." },
      remove: { type: "array", items: { type: "string" }, description: "Ids of rules in force to take out of force. Alone, it removes the rule; with the same id in add, it changes it." },
    },
    additionalProperties: false,
  },
  examples: {
    type: "object",
    properties: {
      pass: { type: "array", items: EXAMPLE, minItems: 1 },
      fail: {
        type: "array",
        minItems: 1,
        items: {
          ...EXAMPLE,
          properties: { ...EXAMPLE.properties, flagged_by: { type: "object", properties: { rule: { type: "string" }, message: { type: "string" } }, required: ["rule"], additionalProperties: false } },
          required: ["name", "flagged_by"],
        },
      },
    },
    required: ["pass", "fail"],
    additionalProperties: false,
  },
  needs_rule_type: {
    type: "object",
    description:
      "Only when no rule type in the vocabulary can express the rule: a request for a new rule type, which is a code change to core that the user files. Give it instead of rules, inventory and examples. Core never approves or adopts it.",
    properties: {
      checks: { type: "string", minLength: 1, maxLength: 2000, description: "What the rule should check, exactly." },
      why_not: { type: "string", minLength: 1, maxLength: 2000, description: "Why no rule type in the vocabulary (read_project's rules show them) can say it: name the types you considered and what each cannot express." },
      pass: { type: "array", minItems: 1, items: WORD_EXAMPLE, description: "Prototypes the rule must pass, in words." },
      fail: { type: "array", minItems: 1, items: WORD_EXAMPLE, description: "Prototypes the rule must fail, in words." },
    },
    required: ["checks", "why_not", "pass", "fail"],
    additionalProperties: false,
  },
};

const tool = (name: string, description: string, schema: JsonSchema): Tool => ({
  // Streamed requests with client tools stream each tool's input as it is generated; every input is validated here before it runs.
  definition: { name, description, input_schema: schema as BetaTool["input_schema"], eager_input_streaming: true },
  schema,
});

/**
 * The agent's tools, in a fixed order so the cached prefix never changes:
 * reading, the manifest, the checks and proposals; write_spec and
 * patch_spec, which edit a spec as data and are checked against the catalog
 * before they apply; the layout tools, list_layouts, insert_layout and
 * set_layout_params; the variant tools; and address_note. There is no tool
 * that writes code: the agent writes specs only.
 */
const TOOLS: readonly Tool[] = [
  tool(
    "read_project",
    "Read the project: the component library and which parts are which roles, the inventories (components, layouts, page types and their slots, flow states), the rule inputs (tasks, ranking, disclosed sections, caps), the views, every rule in force as JSON, and every proposal with its status. Call it before building anything, and again after drafting a proposal.",
    NOTHING,
  ),
  tool("list_files", "List the prototype's files with their line counts, and show its manifest (pages, layouts, scenarios, flow). Call it to see what exists before reading or writing.", NOTHING),
  tool(
    "read_file",
    "Read one file of the prototype, or manifest.json for the manifest. Call it before editing a file you have not read in this conversation.",
    { type: "object", properties: { path: { type: "string", maxLength: 160, description: 'A file from list_files, or "manifest.json".' } }, required: ["path"], additionalProperties: false },
  ),
  tool("list_layouts", SPEC_TOOL_DESCRIPTIONS.list_layouts, SPEC_TOOL_SCHEMAS.list_layouts),
  tool("write_spec", SPEC_TOOL_DESCRIPTIONS.write_spec, SPEC_TOOL_SCHEMAS.write_spec),
  tool("patch_spec", SPEC_TOOL_DESCRIPTIONS.patch_spec, SPEC_TOOL_SCHEMAS.patch_spec),
  tool("insert_layout", SPEC_TOOL_DESCRIPTIONS.insert_layout, SPEC_TOOL_SCHEMAS.insert_layout),
  tool("set_layout_params", SPEC_TOOL_DESCRIPTIONS.set_layout_params, SPEC_TOOL_SCHEMAS.set_layout_params),
  tool("delete_file", "Delete a spec file from the prototype. The change is a new revision at once.", { type: "object", properties: { path: SPEC_TOOL_SCHEMAS.patch_spec.properties.path }, required: ["path"], additionalProperties: false }),
  tool(
    "set_manifest",
    "Replace the prototype's manifest: its pages, layouts, scenarios and flow. Core validates it first; a manifest it refuses is not applied, and the reasons come back. The change is a new revision at once.",
    { ...MANIFEST_SCHEMA, required: ["pages", "layouts", "scenarios", "flow"] },
  ),
  tool(
    "run_checks",
    "Run the project's checks on the current prototype. Waits until every frame has rendered and been measured, then returns core's report: the status, each failing rule with its findings, and any frame that did not render. The app also sends you this report after every round in which you changed files.",
    NOTHING,
  ),
  tool(
    "draft_proposal",
    "Draft a proposal when the request needs something the inventories lack or a rule in force forbids: a component, layout, page type, flow state or task, a changed cap or ranking, a new rule, or a rule in force removed (rules.remove) or changed (its id in rules.remove and the changed rule under that id in rules.add). Use it instead of working around a check. It is saved as open, and core's adoption dry run tells you whether it would be adopted or why not. To change a proposal you drafted, use revise_proposal, which keeps its history; draft_proposal refuses an id that exists. Only the user can approve, decline or adopt it. Each example starts from the current prototype: files replace or add files, remove_files removes some, manifest replaces the manifest. Give examples, or, only when no rule type in the vocabulary can express the rule, needs_rule_type in place of rules, inventory and examples: a request for a code change that can never be adopted.",
    { type: "object", properties: { id: { type: "string", pattern: SLUG }, ...PROPOSAL_FIELDS }, required: ["id", "title", "reason"], additionalProperties: false },
  ),
  tool(
    "revise_proposal",
    "Revise an open proposal, such as one the user sent back to you with a note. Give its id, a note saying what you changed and why (kept in the proposal's history beside the version it replaces), and only the fields you change: each one you give replaces that field whole, and the rest stay as they are. examples, when given, replaces both lists, each example starting from the current prototype. Core's adoption dry run runs again on the revision. Only an open proposal can be revised, and its status stays open: only the user can approve, decline or adopt it.",
    { type: "object", properties: { id: { type: "string", pattern: SLUG }, note: { type: "string", minLength: 1, maxLength: 2000 }, ...PROPOSAL_FIELDS }, required: ["id", "note"], additionalProperties: false },
  ),
  tool("propose_variants", VARIANT_TOOL_DESCRIPTIONS.propose_variants, VARIANT_TOOL_SCHEMAS.propose_variants),
  tool("revise_variant", VARIANT_TOOL_DESCRIPTIONS.revise_variant, VARIANT_TOOL_SCHEMAS.revise_variant),
  tool("list_variants", VARIANT_TOOL_DESCRIPTIONS.list_variants, VARIANT_TOOL_SCHEMAS.list_variants),
  tool(
    "address_note",
    "Mark one of the person's pinned notes as addressed, after you changed the prototype for it, with a short reply saying what you did (or why you could not). Notes are the person's feedback on a spot of a frame; they arrive with the person's message as \"Your notes from the person\". They are never checks and change no rule's verdict. This is all you can do to a note: you cannot write, edit, close, reopen or remove one. The person closes it, or reopens it for you to try again.",
    {
      type: "object",
      properties: { note: { type: "integer", minimum: 1, description: "The note's number, as the person's notes list it." }, reply: { type: "string", minLength: 1, maxLength: MAX_REPLY_LENGTH, description: "One or two sentences for the person: what you changed for this note." } },
      required: ["note", "reply"],
      additionalProperties: false,
    },
  ),
];

/** The tool definitions sent with every request. */
export const TOOL_DEFINITIONS: readonly BetaTool[] = TOOLS.map((item) => item.definition);

/** Why a stored TSX prototype takes no tool and no turn: core no longer reads TSX, so nothing renders, checks or changes it. */
export const TSX_READ_ONLY = "This prototype is TSX. TSX prototypes are no longer edited or checked here: the agent writes specs only. Export its code, or start a spec version of it.";

export type ToolCall = { readonly id: string; readonly name: string; readonly input: unknown };

/** What one tool call did: the text the agent reads, and what the chat shows. */
export type ToolOutcome = {
  readonly content: string;
  readonly isError: boolean;
  /** The prototype changed. */
  readonly changed: boolean;
  /** A measured report, when the call returned one. */
  readonly measured?: Measured;
  readonly title: string;
  readonly proposal?: ProposalCard;
  /** Variants the call kept or revised, for the chat's card that opens the comparison. */
  readonly variants?: { readonly page: string; readonly ids: readonly string[] };
  /** The note the call marked addressed, and where in its history that entry is: what undoing the turn takes back. */
  readonly addressed?: AddressedNote;
};

/** A note a turn marked addressed: its number, and the place of the `addressed` entry in its history. */
export type AddressedNote = { readonly note: number; readonly event: number };

/** What the chat shows for a drafted or revised proposal: a card that links to its review page. */
export type ProposalCard = {
  readonly id: string;
  readonly title: string;
  readonly adoptable: boolean;
  readonly verdict: string;
  readonly action: "drafted" | "revised";
  /** The dry run could not judge a rendered rule without snapshots; the review page measures the examples. */
  readonly needsMeasurement?: true;
  /** It asks for a new rule type: a code change, never adopted. */
  readonly request?: true;
};

const refused = (title: string, content: string): ToolOutcome => ({ content, isError: true, changed: false, title });

/** Validates a call's input against its tool's schema, then runs it. */
export async function runTool(call: ToolCall, host: AgentHost, signal: AbortSignal): Promise<ToolOutcome> {
  if (host.tsx?.()) return refused(`${call.name} not run: TSX is read-only`, `${TSX_READ_ONLY} Nothing ran.`);
  const found = TOOLS.find((item) => item.definition.name === call.name);
  if (!found) return refused(`Unknown tool ${call.name}`, `There is no tool "${call.name}" for this prototype. The tools are ${TOOLS.map((item) => item.definition.name).join(", ")}.`);
  const issues = validateInput(found.schema, call.input);
  if (issues.length > 0) {
    return refused(`${call.name}: input refused`, `The input does not fit ${call.name}'s schema, so nothing ran:\n${issues.slice(0, 20).join("\n")}\nThe input as received: ${JSON.stringify({ INVALID_INPUT: JSON.stringify(call.input) }).slice(0, 2000)}`);
  }
  const input = call.input as Record<string, unknown>;
  switch (call.name) {
    case "read_project":
      return { content: projectText(host.config()), isError: false, changed: false, title: "Read the project" };
    case "list_files":
      return listFiles(host.prototype());
    case "read_file":
      return readFile(host.prototype(), String(input.path));
    case "delete_file":
      return deleteFile(host, String(input.path));
    case "write_spec":
      return writeSpec(host, String(input.path), input.spec as JsonValue);
    case "patch_spec":
      return patchSpec(host, String(input.path), String(input.patches));
    case "list_layouts":
      return listLayouts(host);
    case "insert_layout":
      return insertLayout(host, input as Parameters<typeof insertLayout>[1]);
    case "set_layout_params":
      return setLayoutParams(host, input as Parameters<typeof setLayoutParams>[1]);
    case "set_manifest":
      return setManifest(host, input);
    case "run_checks": {
      const measured = await host.measured(signal);
      return { content: describeMeasured(measured), isError: false, changed: false, measured, title: checksTitle(measured.report) };
    }
    case "draft_proposal":
      return draftProposal(host, input);
    case "revise_proposal":
      return reviseProposal(host, input);
    case "propose_variants":
      return proposeVariants(host, input as Parameters<typeof proposeVariants>[1]);
    case "revise_variant":
      return reviseVariant(host, input as Parameters<typeof reviseVariant>[1]);
    case "list_variants":
      return listVariants(host);
    case "address_note":
      return addressNote(host, Number(input.note), String(input.reply));
    default:
      return refused(`Unknown tool ${call.name}`, `There is no tool "${call.name}".`);
  }
}

/**
 * Marks one pinned note addressed, with the agent's reply. The pin's own
 * rules decide (`addressPin`): only an open note, and never its text, its
 * place or another note. The prototype is not touched, so no revision starts.
 */
function addressNote(host: AgentHost, number: number, reply: string): ToolOutcome {
  const pins = host.pins?.();
  if (!pins || !host.savePins) return refused("address_note: no notes here", "This prototype has no pinned notes to address.");
  const addressed = addressPin(pins, number, reply, host.now());
  if (!addressed.ok) return refused(`Note ${number} not marked addressed`, `${addressed.error} Nothing changed. The open notes are: ${openPins(pins).map((pin) => pin.number).join(", ") || "none"}.`);
  host.savePins(addressed.value);
  const left = openPins(addressed.value).map((pin) => pin.number);
  return { content: `Marked note ${number} as addressed, with your reply. The person will close it or reopen it. ${left.length > 0 ? `Still open: ${left.map((item) => `note ${item}`).join(", ")}.` : "No note is open now."}`, isError: false, changed: false, title: `Addressed note ${number}`, addressed: { note: number, event: (addressed.value.pins.find((pin) => pin.number === number)?.history.length ?? 1) - 1 } };
}

function manifestOf(prototype: Prototype): Omit<Prototype, "files"> {
  const { files: _files, ...manifest } = prototype;
  return manifest;
}

function projectText(config: ProjectConfig): string {
  const { library, inventories, inputs, views, rules, proposals } = config;
  return JSON.stringify(
    {
      project: { id: config.id, name: config.name },
      library: { package: library.package, version: library.version, react: library.react, roles: Object.fromEntries(ROLE_NAMES.map((role) => [role, library.roles[role]])) },
      pageKit: "A spec page is a json-render spec whose root is a Page with its page type's slots; it reads the scenario at /scenario.",
      inventories,
      inputs,
      views,
      rules,
      proposals: proposals.map((proposal) => ({
        id: proposal.id,
        title: proposal.title,
        status: proposal.status,
        inventory: proposal.inventory,
        rules: proposal.rules,
        ...(proposal.needsRuleType ? { needsRuleType: proposal.needsRuleType } : {}),
        // What happened to it, notes included, so a send-back's note can be read again; earlier versions stay out.
        history: [...proposal.history.map((entry) => ({ ...entry })), ...(proposal.events ?? []).map(({ kind, at, by, note }) => ({ event: kind, at, by, note }))],
      })),
    },
    null,
    1,
  );
}

function listFiles(prototype: Prototype): ToolOutcome {
  const paths = Object.keys(prototype.files).sort();
  const lines = paths.map((path) => `${path} (${(prototype.files[path] ?? "").split("\n").length} lines)`);
  return {
    content: `${paths.length} files:\n${lines.join("\n")}\n\n${MANIFEST}:\n${JSON.stringify(manifestOf(prototype), null, 1)}`,
    isError: false,
    changed: false,
    title: `Listed ${paths.length} files`,
  };
}

function readFile(prototype: Prototype, path: string): ToolOutcome {
  if (path === MANIFEST) return { content: JSON.stringify(manifestOf(prototype), null, 2), isError: false, changed: false, title: `Read ${MANIFEST}` };
  const text = prototype.files[path];
  if (text === undefined) return refused(`read_file: no ${path}`, `There is no file "${path}". The files are: ${Object.keys(prototype.files).sort().join(", ")}.`);
  return { content: text, isError: false, changed: false, title: `Read ${path}` };
}

/** Applies a new prototype after core's validation, and says what happened. */
function change(host: AgentHost, next: Prototype, title: string, done: string): ToolOutcome {
  const parsed = parsePrototype(next);
  if (!parsed.ok) return refused(`${title}: refused`, `Core refused the change, so it was not applied:\n${formatIssues(parsed.error)}`);
  const { revision } = host.apply(parsed.value);
  return { content: `${done} Revision ${revision} is rendering; the checks for it follow this round.`, isError: false, changed: true, title };
}

function deleteFile(host: AgentHost, path: string): ToolOutcome {
  const current = host.prototype();
  if (current.files[path] === undefined) return refused(`delete_file: no ${path}`, `There is no file "${path}".`);
  const files = { ...current.files };
  delete files[path];
  return change(host, { ...current, files }, `Deleted ${path}`, `Deleted ${path}.`);
}

function setManifest(host: AgentHost, manifest: Record<string, unknown>): ToolOutcome {
  const current = host.prototype();
  // The manifest replaces the pages, layouts, scenarios and flow; the prototype stays a spec, whether or not the input says so.
  return change(host, { ...(manifest as Omit<Prototype, "files">), format: "spec", files: current.files }, "Changed the manifest", "Replaced the manifest.");
}

const counts = (report: CheckReport) => {
  const out = { pass: 0, fail: 0, "not-run": 0 };
  for (const rule of report.rules) out[rule.status] += 1;
  return out;
};

export function checksTitle(report: CheckReport): string {
  const failing = report.rules.filter((rule) => rule.status === "fail").length;
  return report.status === "pass" ? "Checks pass" : report.status === "fail" ? `Checks fail: ${failing} ${failing === 1 ? "rule" : "rules"}` : "Checks incomplete";
}

/** Core's report as text the agent reads: failing rules and their findings, word for word, with where each is. */
export function describeMeasured({ revision, report, frames }: Measured): string {
  const total = counts(report);
  const lines = [`Checks for revision ${revision}, with every frame measured: ${report.status}. ${total.pass} pass, ${total.fail} fail, ${total["not-run"]} not run.`];
  let shown = 0;
  for (const rule of report.rules.filter((item) => item.status === "fail")) {
    lines.push(`- ${rule.rule} (${rule.type})${rule.description ? `: ${rule.description}` : ""}`);
    for (const finding of rule.findings.slice(0, 6)) {
      if (shown >= 40) break;
      shown += 1;
      const place = [
        finding.file !== undefined ? `${finding.file}${finding.line !== undefined ? `:${finding.line}:${finding.column ?? 1}` : ""}` : null,
        // Inside a spec layout instance: the layout's use, so the agent knows which instance to change.
        ...(finding.via ?? []).map((use) => (use.slot !== undefined ? `in slot "${use.slot}" of layout ${use.layout} at ${use.file}:${use.line}:${use.column}` : `in layout ${use.layout} used at ${use.file}:${use.line}:${use.column}`)),
        finding.scenario !== undefined ? `scenario ${finding.scenario}` : null,
        finding.view !== undefined ? `view ${finding.view}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(`  ${finding.kind}: ${finding.message}${place ? ` [${place}]` : ""}`);
    }
    if (rule.findings.length > 6) lines.push(`  and ${rule.findings.length - 6} more findings of ${rule.rule}`);
  }
  if (frames.length > 0) {
    lines.push("Frames that did not render a snapshot:");
    for (const frame of frames.slice(0, 8)) lines.push(`  ${frame.frame} (${frame.stage}): ${frame.message}`);
  }
  if (report.status === "pass") lines.push("Every rule in force passes.");
  return lines.join("\n");
}

type WordExampleInput = { readonly name: string; readonly description: string; readonly snippet?: string };
type RuleTypeInput = { readonly checks: string; readonly why_not: string; readonly pass: readonly WordExampleInput[]; readonly fail: readonly WordExampleInput[] };

function ruleTypeOf(input: RuleTypeInput): NonNullable<ProposalDraft["needsRuleType"]> {
  const words = (example: WordExampleInput) => ({ name: example.name, description: example.description, ...(example.snippet !== undefined ? { snippet: example.snippet } : {}) });
  return { checks: input.checks, whyNot: input.why_not, pass: input.pass.map(words), fail: input.fail.map(words) };
}

type ExampleInput = { readonly name: string; readonly files?: Record<string, string>; readonly remove_files?: readonly string[]; readonly manifest?: Partial<Omit<Prototype, "files">>; readonly flagged_by?: { readonly rule: string; readonly message?: string } };

function examplePrototype(current: Prototype, example: ExampleInput): Prototype {
  const files = { ...current.files, ...example.files };
  for (const path of example.remove_files ?? []) delete files[path];
  return { ...manifestOf(current), ...example.manifest, files };
}

function examplesOf(current: Prototype, examples: { pass: ExampleInput[]; fail: ExampleInput[] }): ProposalDraft["examples"] {
  return {
    pass: examples.pass.map((example): PassingExample => ({ name: example.name, prototype: examplePrototype(current, example) })),
    fail: examples.fail.map(
      (example): FailingExample => ({
        name: example.name,
        prototype: examplePrototype(current, example),
        flaggedBy: { rule: example.flagged_by?.rule ?? "", ...(example.flagged_by?.message !== undefined ? { message: example.flagged_by.message } : {}) },
      }),
    ),
  };
}

/** The draft the input describes; a field the input leaves out comes from `base`, the proposal being revised. */
function draftFrom(input: Record<string, unknown>, current: Prototype, base?: Proposal): ProposalDraft {
  const rules = input.rules as { add?: unknown[]; remove?: string[] } | undefined;
  const examples = input.examples as { pass: ExampleInput[]; fail: ExampleInput[] } | undefined;
  const request = input.needs_rule_type !== undefined ? ruleTypeOf(input.needs_rule_type as RuleTypeInput) : base?.needsRuleType;
  return {
    id: String(input.id),
    title: input.title !== undefined ? String(input.title) : (base?.title ?? ""),
    reason: input.reason !== undefined ? String(input.reason) : (base?.reason ?? ""),
    states: (input.states ?? base?.states ?? []) as ProposalDraft["states"],
    inventory: (input.inventory ?? base?.inventory ?? []) as ProposalDraft["inventory"],
    rules: rules ? { add: (rules.add ?? []) as ProposalDraft["rules"]["add"], remove: rules.remove ?? [] } : (base?.rules ?? { add: [], remove: [] }),
    examples: examples ? examplesOf(current, examples) : (base?.examples ?? { pass: [], fail: [] }),
    ...(request ? { needsRuleType: request } : {}),
  };
}

/** Core's adoption dry run on a saved proposal, as the agent reads it and as the chat's card shows it. */
function dryRun(host: AgentHost, config: ProjectConfig, id: string, at: string): { adoptable: boolean; needsMeasurement?: true; request?: true; verdict: string } {
  const proposal = config.proposals.find((item) => item.id === id);
  // A request for a new rule type is not judged: core refuses to approve or adopt one, and that is what it is for.
  if (proposal?.needsRuleType) {
    return { adoptable: false, request: true, verdict: "It asks for a new rule type, which is a code change to core: the user can copy it as a request to file, and core will never approve or adopt it as a check." };
  }
  const rendered = (proposal?.rules.add ?? []).filter((rule) => rule.type === "rendered").map((rule) => `"${rule.id}"`);
  // The dry run here reads source only: frames measure the examples on the proposal's review page, before the user can adopt it.
  const measuring = rendered.length > 0 ? ` It adds rendered ${rendered.length === 1 ? "rule" : "rules"} ${rendered.join(", ")}, which need measured snapshots: this dry run has none, so a rendered rule that did not run is expected here. The review page measures every example in frames before the user can adopt it.` : "";
  const tried = dryRunAdoption(config, id, { at, by: "agent (dry run)" }, [{ name: "the current prototype", prototype: host.prototype() }]);
  if (!tried.ok) {
    // A rendered rule that did not run for want of snapshots is a measurement still to come, not a fault in the draft.
    const unmeasured = rendered.length > 0 && /no rendered snapshots were given/.test(tried.error.message);
    return { adoptable: false, ...(unmeasured ? { needsMeasurement: true } : {}), verdict: `Core's adoption dry run refuses it: [${tried.error.code}] ${tried.error.message}.${measuring}` };
  }
  const { classification, newlyFailing } = tried.value;
  const changes = classification.changes.map((item) => `${item.change}: ${item.class} (${item.reason})`).join("; ");
  const failing = newlyFailing.length === 0 ? "No prototype would newly fail." : `Would newly fail: ${newlyFailing.map((item) => `${item.name} (${item.rules.join(", ") || "new findings"})`).join("; ")}.`;
  return { adoptable: true, verdict: `Core's adoption dry run passes: once approved it would be adopted, classified ${classification.class}. ${changes}. ${failing}${measuring}` };
}

async function draftProposal(host: AgentHost, input: Record<string, unknown>): Promise<ToolOutcome> {
  const id = String(input.id);
  const config = host.config();
  const existing = config.proposals.find((proposal) => proposal.id === id);
  if (existing) {
    return refused(
      `Proposal ${id} not drafted`,
      existing.status === "open"
        ? `A proposal "${id}" already exists and is open. Change it with revise_proposal, which keeps its history, or draft a new proposal with a new id.`
        : `Proposal "${id}" is ${existing.status}, so it cannot be drafted again. Choose a new id.`,
    );
  }
  if (input.examples === undefined && input.needs_rule_type === undefined) {
    return refused(`Proposal ${id} not drafted`, "Give examples that pass and fail, which prove the proposal's rules; or, only when no rule type in the vocabulary can express the rule, needs_rule_type instead. Nothing was saved.");
  }
  const draft = draftFrom(input, host.prototype());
  const at = host.now();
  const proposed = propose(config, draft, { at, by: "agent" });
  if (!proposed.ok) return refused(`Proposal ${id} not drafted`, `Core refused the draft, so it was not saved: [${proposed.error.code}] ${proposed.error.message}`);
  await host.saveConfig(proposed.value);
  const { adoptable, needsMeasurement, request, verdict } = dryRun(host, proposed.value, id, at);
  const next = adoptable || needsMeasurement || request ? "" : " Fix it with revise_proposal.";
  return {
    content: request
      ? `Saved request "${id}" for a new rule type as open. ${verdict} The rules in force are unchanged; until core has the rule type, keep the prototype to the rules it has.`
      : `Saved proposal "${id}" as open. ${verdict}${next} Only the user can approve or adopt it; until then it stays open and the rules in force are unchanged.`,
    isError: false,
    changed: false,
    title: request ? `Filed a request for a new rule type, ${id}` : `Drafted proposal ${id}`,
    proposal: { id, title: draft.title, adoptable, verdict, action: "drafted", ...(needsMeasurement ? { needsMeasurement } : {}), ...(request ? { request } : {}) },
  };
}

async function reviseProposal(host: AgentHost, input: Record<string, unknown>): Promise<ToolOutcome> {
  const id = String(input.id);
  const config = host.config();
  const existing = config.proposals.find((proposal) => proposal.id === id);
  if (!existing) return refused(`Proposal ${id} not revised`, `There is no proposal "${id}". draft_proposal drafts a new one.`);
  const draft = draftFrom(input, host.prototype(), existing);
  const at = host.now();
  const revised = revise(config, id, draft, { at, by: "agent", note: String(input.note) });
  if (!revised.ok) {
    const why = revised.error.code === "wrong-status" ? " Only the user changes a proposal's status; draft a new proposal with a new id if more is needed." : "";
    return refused(`Proposal ${id} not revised`, `Core refused the revision, so nothing changed: [${revised.error.code}] ${revised.error.message}.${why}`);
  }
  await host.saveConfig(revised.value);
  const { adoptable, needsMeasurement, request, verdict } = dryRun(host, revised.value, id, at);
  return {
    content: `Revised proposal "${id}"; it is still open, and its history keeps the version before this one. ${verdict} Only the user can approve or adopt it.`,
    isError: false,
    changed: false,
    title: `Revised proposal ${id}`,
    proposal: { id, title: draft.title, adoptable, verdict, action: "revised", ...(needsMeasurement ? { needsMeasurement } : {}), ...(request ? { request } : {}) },
  };
}
