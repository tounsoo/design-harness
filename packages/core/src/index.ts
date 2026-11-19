/**
 * @design-harness/core: deterministic design checks. Everything here is a
 * pure function of plain JSON, with no clock, randomness, network or file
 * system, so it runs unchanged in a browser and in Node.
 */
export type { Cap, ComponentLibrary, ConfirmedExclusion, ConfirmedRole, Confidence, Inventories, LibraryRoot, PageType, PartDescription, ProjectConfig, PropSchema, RankedAction, RoleMapping, RuleInputs, SettablePropSchema, Task, View } from "./config/types";
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
export type { FailingExample, InventoryOp, PassingExample, Proposal, ProposalContent, ProposalEvent, ProposalStatus, RuleTypeExample, RuleTypeRequest, StateNote, StatusChange } from "./proposals/types";
export type { RuleTypeIssue } from "./proposals/request";
export { ruleTypeIssue } from "./proposals/request";
export { PROPOSAL_STATUSES } from "./proposals/types";

export type { Issue, Result } from "./validate";
export { formatIssues, parseLibraryDescription, parseProjectConfig, parsePrototype, parseSnapshots } from "./parse";

export type { AmbientUse, ElementKind, ElementNode, ExtractionProblem, LayoutUse, ModuleLoad, PageModel, PropValue, PrototypeModel, SourceLocation } from "./extract/model";
export { PAGE_KIT, extractPrototype } from "./extract";
export { isScript, resolvePath } from "./extract/modules";

export type { CheckReport, CheckStatus, Finding, FindingTarget, RuleReport, RuleStatus } from "./engine/report";
export { EXTRACT_RULE } from "./engine/report";
export type { BoxWithNeighbourEvidence, ColourPairEvidence, CountVsCapEvidence, CoverageEvidence, Evidence, EvidenceDeclaration, EvidenceKind, RegionLineEvidence, RouteVsBudgetEvidence, SequenceGapEvidence } from "./engine/evidence";
export { EVIDENCE_KINDS, RULE_EVIDENCE, evidenceFor } from "./engine/evidence";
export type { FlowFacts, TaskFacts, ViewFacts } from "./engine/facts";
export { flowFacts, viewFacts } from "./engine/facts";
export type { TargetVerdict } from "./engine/rules/rendered";
export type { CheckInput } from "./engine/check";
export { RULE_TYPES, checkPrototype } from "./engine/check";

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
export type { PickScope } from "./variants/pick-scope";
export { findingIsOfPage, pickScope } from "./variants/pick-scope";

export type { TsxExport } from "./export/tsx";
export { specToTsx } from "./export/tsx";
export type { ProjectExport, ProjectExportInput } from "./export/project";
export { EXPORT_PROTOTYPE_DIR, EXPORT_TOOLING, exportReactProject } from "./export/project";

export type { ConfirmedRoles, ExclusionGuess, LibraryDescription, MissingRole, MissingRoleEffect, RoleConfirmation, RoleDraft, RoleGuess } from "./library/roles";
export { confirmRoles, describeMapping, draftRoles, missingRoleEffects, sameMapping } from "./library/roles";
export type { BuiltProject, ExclusionChoice, LibrarySetup, ProjectAnswers, RoleChoice, RoleOptions, RolePreview, StarterCap, StarterRules, StarterTask, TextParts } from "./library/project";
export { STARTER_CAPS, STARTER_CAP_NOTES, STARTER_LAYOUT, STARTER_PAGE_TYPES, STARTER_STATE, STARTER_VIEWS, buildProject, confirmationFrom, defaultStarterRules, isExcluded, projectId, projectNameIssues, roleComponents, roleOptions, rolePreview, slugOf, starterInventory, starterPrototype, textParts } from "./library/project";
export type { PartSpecimen, SpecimenSample } from "./library/specimen";
export { partSpecimen, unplacedRoles } from "./library/specimen";
