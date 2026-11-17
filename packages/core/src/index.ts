/**
 * @design-harness/core: deterministic design checks. Everything here is a
 * pure function of plain JSON, with no clock, randomness, network or file
 * system, so it runs unchanged in a browser and in Node.
 */
export type { Cap, ComponentLibrary, Inventories, PageType, ProjectConfig, RankedAction, RoleMapping, RuleInputs, Task, View } from "./config/types";
export { CONFIG_SCHEMA_VERSION } from "./config/types";
export type { ComponentRef, Flow, LayoutEntry, PageEntry, Prototype, Scenario, TaskFlow, Transition } from "./prototype/types";
export type { Rect, RenderedElement, RenderedSnapshot, Rgba, TextPaint } from "./rendered/types";
export type {
  Bound,
  ContainmentRule,
  CountRule,
  CountScope,
  FlowRule,
  Literal,
  MembershipRule,
  MembershipSubject,
  PageFilter,
  PageKind,
  PageStructureRule,
  PropValuesRule,
  ReachableRule,
  RenderedRule,
  RequiresRule,
  RoleName,
  RuleSpec,
  RuleType,
  Selector,
  SlotRule,
  TextMatch,
} from "./rules/types";
export { PAGE_KINDS, ROLE_NAMES } from "./rules/types";
export type { FailingExample, InventoryOp, PassingExample, Proposal, ProposalStatus, StateNote, StatusChange } from "./proposals/types";
export { PROPOSAL_STATUSES } from "./proposals/types";

export type { Issue, Result } from "./validate";
export { formatIssues, parseProjectConfig, parsePrototype, parseSnapshots } from "./parse";

export type { ElementKind, ElementNode, ExtractionProblem, ModuleLoad, PageModel, PropValue, PrototypeModel, SourceLocation } from "./extract/model";
export { PAGE_KIT, extractPrototype } from "./extract";
export { isScript, resolvePath } from "./extract/modules";

export type { CheckReport, CheckStatus, Finding, RuleReport, RuleStatus } from "./engine/report";
export { EXTRACT_RULE } from "./engine/report";
export type { CheckInput } from "./engine/check";
export { checkPrototype } from "./engine/check";

export { BUILT_IN_RULES } from "./builtins";

export type { ChangeClass, Classification, ClassifiedChange } from "./proposals/classify";
export { classifyProposal } from "./proposals/classify";
export { applyProposal } from "./proposals/apply";
export type { Adoption, ExampleRun, ExistingPrototype, NewlyFailing, ProposalDraft, Refusal, RefusalCode, Stamp } from "./proposals/lifecycle";
export { adopt, approve, decline, propose, rerunExamples } from "./proposals/lifecycle";
