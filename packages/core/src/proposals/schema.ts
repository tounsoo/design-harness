import { cap, capName, pageType, rankedAction, roleMapping, task } from "../config/parts";
import { prototypeSchema } from "../prototype/schema";
import { snapshotSchema } from "../rendered/schema";
import { ruleSpec } from "../rules/schema";
import { BOUND_KEYS } from "../rules/bounds";
import { ROLE_NAMES } from "../rules/types";
import { INVALID, arr, int, obj, oneOf, slug, str, tagged, type Check } from "../validate";
import { PROPOSAL_STATUSES, type InventoryOp, type Proposal } from "./types";

const op = <K extends string>(name: K) => ({ op: oneOf([name] as const) });

export const inventoryOp: Check<InventoryOp> = tagged("op", {
  "add-component": obj({ ...op("add-component"), name: str() }),
  "remove-component": obj({ ...op("remove-component"), name: str() }),
  "add-layout": obj({ ...op("add-layout"), id: slug }),
  "remove-layout": obj({ ...op("remove-layout"), id: slug }),
  "add-page-type": obj({ ...op("add-page-type"), pageType: pageType }),
  "remove-page-type": obj({ ...op("remove-page-type"), id: slug }),
  "add-flow-state": obj({ ...op("add-flow-state"), state: slug }),
  "remove-flow-state": obj({ ...op("remove-flow-state"), state: slug }),
  "add-task": obj({ ...op("add-task"), task: task }),
  "remove-task": obj({ ...op("remove-task"), id: slug }),
  "set-max-steps": obj({ ...op("set-max-steps"), task: slug, value: int({ min: 1 }) }),
  "add-cap": obj({ ...op("add-cap"), name: capName, cap: cap }),
  "set-cap": obj({ ...op("set-cap"), name: capName, value: int({ min: 0 }) }),
  "add-disclosed-section": obj({ ...op("add-disclosed-section"), section: str() }),
  "remove-disclosed-section": obj({ ...op("remove-disclosed-section"), section: str() }),
  "set-ranking": obj({ ...op("set-ranking"), ranking: arr(rankedAction) }),
  "set-role": obj({ ...op("set-role"), role: oneOf(ROLE_NAMES), mapping: roleMapping }),
});

const example = { name: slug, prototype: prototypeSchema } as const;
const exampleExtra = { snapshots: arr(snapshotSchema) } as const;

const content = {
  title: str(),
  reason: str(),
  states: arr(obj({ state: str(), note: str() })),
  inventory: arr(inventoryOp),
  rules: obj({ add: arr(ruleSpec), remove: arr(slug) }),
  examples: obj({
    pass: arr(obj(example, exampleExtra)),
    fail: arr(obj({ ...example, flaggedBy: obj({ rule: slug }, { message: str() }) }, exampleExtra)),
  }),
} as const;

const ruleTypeExample = obj({ name: slug, description: str() }, { snippet: str() });

/** A request for a new rule type: what it checks, why the vocabulary cannot say it, and at least one example each way. */
const ruleTypeRequest = obj({
  checks: str(),
  whyNot: str(),
  pass: arr(ruleTypeExample, { min: 1 }),
  fail: arr(ruleTypeExample, { min: 1 }),
});

const contentExtra = { needsRuleType: ruleTypeRequest } as const;

const changeClass = oneOf(["adds", "tightens", "loosens-or-removes"] as const);

const boundChange = obj({ bound: oneOf(BOUND_KEYS), before: str(), after: str(), direction: oneOf(["stricter", "looser", "unknown"] as const) });

const proposalEvent = tagged("kind", {
  revised: obj({ kind: oneOf(["revised"] as const), at: str(), previous: obj(content, contentExtra) }, { by: str(), note: str() }),
  "sent-back": obj({ kind: oneOf(["sent-back"] as const), at: str(), note: str() }, { by: str() }),
});

const proposalShape = obj(
  {
    id: slug,
    ...content,
    status: oneOf(PROPOSAL_STATUSES),
    history: arr(obj({ status: oneOf(PROPOSAL_STATUSES), at: str() }, { by: str(), note: str() }), { min: 1 }),
  },
  {
    ...contentExtra,
    events: arr(proposalEvent),
    classification: obj({ class: changeClass, changes: arr(obj({ change: str(), class: changeClass, reason: str() }, { rule: slug, was: str(), bounds: arr(boundChange) })) }),
  },
);

/**
 * A proposal, and the rules its shape alone can break: its status is the last
 * one in its history, and a request for a new rule type is never approved or
 * adopted, so no stored or imported proposal can carry one into force.
 */
export const proposalSchema: Check<Proposal> = (value, path, issues) => {
  const out = proposalShape(value, path, issues);
  if (out === INVALID) return INVALID;
  const last = out.history[out.history.length - 1];
  if (last && last.status !== out.status) {
    issues.push({ path: `${path}.status`, message: `is "${out.status}", but the last history entry is "${last.status}"` });
    return INVALID;
  }
  if (out.needsRuleType && out.history.some((entry) => entry.status === "approved" || entry.status === "adopted")) {
    issues.push({ path: `${path}.status`, message: "a request for a new rule type is never approved or adopted: a new rule type is a code change to core" });
    return INVALID;
  }
  return out;
};
