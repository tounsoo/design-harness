/**
 * @design-harness/core: deterministic design checks. Everything here is a
 * pure function of plain JSON, with no clock, randomness, network or file
 * system, so it runs unchanged in a browser and in Node.
 */
export type { Cap, ComponentLibrary, Inventories, PageType, PartDescription, ProjectConfig, PropSchema, RankedAction, RoleMapping, RuleInputs, Task, View } from "./config/types";
export { CONFIG_SCHEMA_VERSION } from "./config/types";
export type { ComponentRef, Flow, LayoutEntry, PageEntry, Prototype, Scenario, TaskFlow, Transition } from "./prototype/types";
export type { Rect, RenderedElement, RenderedSnapshot, Rgba, TextPaint } from "./rendered/types";
export type {
  Bound,
  ContainmentRule,
  CountRule,
  CountScope,
  FlowRule,
  IsolationRule,
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
export type { FailingExample, InventoryOp, PassingExample, Proposal, ProposalContent, ProposalEvent, ProposalStatus, StateNote, StatusChange } from "./proposals/types";
export { PROPOSAL_STATUSES } from "./proposals/types";

export type { Issue, Result } from "./validate";
export { formatIssues, parseProjectConfig, parsePrototype, parseSnapshots } from "./parse";

export type { AmbientUse, ElementKind, ElementNode, ExtractionProblem, LayoutUse, ModuleLoad, PageModel, PropValue, PrototypeModel, SourceLocation } from "./extract/model";
export { PAGE_KIT, extractPrototype } from "./extract";
export { isScript, resolvePath } from "./extract/modules";

export type { CheckReport, CheckStatus, Finding, RuleReport, RuleStatus } from "./engine/report";
export { EXTRACT_RULE } from "./engine/report";
export type { CheckInput } from "./engine/check";
export { checkPrototype } from "./engine/check";

export { BUILT_IN_RULES } from "./builtins";
export { describeRule } from "./engine/words";

export type { ChangeClass, Classification, ClassifiedChange } from "./proposals/classify";
export { classifyProposal } from "./proposals/classify";
export { applyProposal } from "./proposals/apply";
export type { Adoption, ExampleResult, ExampleRun, ExistingPrototype, NewlyFailing, ProposalDraft, Refusal, RefusalCode, Stamp } from "./proposals/lifecycle";
export { adopt, approve, contentOf, decline, dryRunAdoption, newlyFailingOf, propose, rerunExamples, revise, sendBack, tryExamples, withExampleSnapshots } from "./proposals/lifecycle";

export type { CatalogComponent, SpecCatalog } from "./spec/catalog";
export { LAYOUT_TYPE, PAGE_TYPE, SCENARIO_STATE, SPEC_ACTIONS, TEXT_PROP, specCatalog } from "./spec/catalog";
export type { JsonValue, ParsedJson, Position } from "./spec/json";
export { parseJson } from "./spec/json";
export type { SpecIssue } from "./spec/read";
export { readSpecs } from "./spec/read";
export { specIssues, specModel } from "./spec/model";
export type { ExpandedElement, ExpandedPage } from "./spec/expand";
export { expandPage } from "./spec/expand";
export type { FlatSpec } from "./spec/resolve";
export { resolvePageSpec } from "./spec/resolve";
export type { LayoutParam, LayoutParams, ListItem, ParamType, ScalarType } from "./spec/params";
export { PARAM_STATE, PARAM_TYPES, describeParam } from "./spec/params";
export type { LayoutSummary, ParamSummary } from "./spec/layouts";
export { PREVIEW_FILE, PREVIEW_PAGE, layoutPreview, specLayouts } from "./spec/layouts";

export { formatSpec } from "./spec/format";

export type { PickRecord, Variant, VariantState } from "./variants/types";
export { CURRENT, NO_VARIANTS } from "./variants/types";
export { checkVariant, nextVariantIds, parseVariantState, variantLabel, variantPrototype, withPageSpec } from "./variants/variants";
export type { Recombination, Rename } from "./variants/recombine";
export { recombine } from "./variants/recombine";
