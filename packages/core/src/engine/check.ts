import type { ProjectConfig } from "../config/types";
import type { PrototypeModel } from "../prototype/model";
import type { Prototype } from "../prototype/types";
import type { RenderedSnapshot } from "../rendered/types";
import type { RuleSpec, RuleType } from "../rules/types";
import { specModel } from "../spec/model";
import { locate, type CheckContext } from "./context";
import { EXTRACT_RULE, buildReport, sortFindings, type CheckReport, type Finding, type RuleReport } from "./report";
import { evaluateContainment, evaluatePropValues, evaluateRequires } from "./rules/containment";
import { evaluateCount } from "./rules/count";
import { evaluateFlow } from "./rules/flow";
import { evaluateMembership } from "./rules/membership";
import type { Outcome } from "./rules/outcome";
import { evaluateRendered } from "./rules/rendered";
import { evaluatePageStructure, evaluateReachable, evaluateSlot } from "./rules/slots";

type Evaluators = { readonly [T in RuleType]: (rule: Extract<RuleSpec, { type: T }>, ctx: CheckContext) => Outcome };

/** One evaluator per rule type; adding a type to the vocabulary fails to compile until it has one. */
const EVALUATORS: Evaluators = {
  membership: evaluateMembership,
  count: evaluateCount,
  containment: evaluateContainment,
  "prop-values": evaluatePropValues,
  requires: evaluateRequires,
  slot: evaluateSlot,
  reachable: evaluateReachable,
  "page-structure": evaluatePageStructure,
  flow: evaluateFlow,
  rendered: evaluateRendered,
};

/** Every rule type in the vocabulary, sorted: one per evaluator, so the list cannot fall behind the types. */
export const RULE_TYPES: readonly RuleType[] = (Object.keys(EVALUATORS) as RuleType[]).sort();

function evaluate(rule: RuleSpec, ctx: CheckContext): Outcome {
  return (EVALUATORS[rule.type] as (rule: RuleSpec, ctx: CheckContext) => Outcome)(rule, ctx);
}

export type CheckInput = {
  readonly config: ProjectConfig;
  readonly prototype: Prototype;
  /** Rendered snapshots, one per scenario and view. Without them, rendered rules report `not-run`. */
  readonly snapshots?: readonly RenderedSnapshot[];
  /** A model already read from this prototype with this config, to skip reading it again. */
  readonly model?: PrototypeModel;
};

/**
 * Checks a prototype against every rule in the config. Pure and
 * deterministic: no clock, randomness, network or file system, and the same
 * input gives the same report in the same order, whatever order the input's
 * files, keys or rules were given in.
 */
export function checkPrototype(input: CheckInput): CheckReport {
  const { config, prototype } = input;
  // The page model is read from the specs; no prototype code exists to run or parse.
  const model = input.model ?? specModel(prototype, config);
  const ctx: CheckContext = {
    config,
    prototype,
    model,
    snapshots: input.snapshots,
    pageTypes: new Map(config.inventories.pageTypes.map((type) => [type.id, type])),
  };
  const extract: Finding[] = model.problems.map((problem) => ({
    rule: EXTRACT_RULE,
    kind: "unverifiable",
    message: problem.message,
    ...(problem.at ? locate(problem.at) : {}),
  }));
  const reports: RuleReport[] = [{ rule: EXTRACT_RULE, type: EXTRACT_RULE, status: extract.length > 0 ? "fail" : "pass", findings: sortFindings(extract) }];
  for (const rule of config.rules) {
    const outcome = evaluate(rule, ctx);
    const description = rule.description !== undefined ? { description: rule.description } : {};
    if ("notRun" in outcome) {
      reports.push({ rule: rule.id, type: rule.type, status: "not-run", note: outcome.notRun, ...description, findings: [] });
      continue;
    }
    const findings = sortFindings(outcome.findings);
    reports.push({ rule: rule.id, type: rule.type, status: findings.length > 0 ? "fail" : "pass", ...description, findings });
  }
  return buildReport(reports);
}
