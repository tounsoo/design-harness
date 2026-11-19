import { EXTRACT_RULE } from "../engine/report";
import type { Bound, RoleName, RuleSpec, Selector, TextMatch } from "../rules/types";
import type { Issue } from "../validate";
import type { ProjectConfig } from "./types";

/**
 * The checks a config's shape cannot make: ids that must be unique, and every
 * name a rule or input refers to must exist. A rule that names a missing cap
 * or a role the library does not map would check nothing, so it is an error
 * here rather than a silent pass later.
 */
export function configReferenceIssues(config: ProjectConfig): Issue[] {
  const issues: Issue[] = [];
  const { inventories, inputs } = config;
  const duplicates = (path: string, values: readonly (string | number)[], what: string) => {
    const seen = new Set<string | number>();
    values.forEach((value, index) => {
      if (seen.has(value)) issues.push({ path: `${path}[${index}]`, message: `${what} ${JSON.stringify(value)} appears twice` });
      seen.add(value);
    });
  };
  duplicates("$.inventories.components", inventories.components, "component");
  duplicates("$.inventories.layouts", inventories.layouts, "layout");
  duplicates("$.inventories.pageTypes", inventories.pageTypes.map((type) => type.id), "page type");
  duplicates("$.inventories.flowStates", inventories.flowStates, "flow state");
  duplicates("$.inputs.tasks", inputs.tasks.map((task) => task.id), "task");
  duplicates("$.inputs.ranking", inputs.ranking.map((item) => item.rank), "rank");
  duplicates("$.inputs.ranking", inputs.ranking.map((item) => item.action), "action");
  duplicates("$.inputs.disclosedSections", inputs.disclosedSections, "section");
  duplicates("$.views", config.views.map((view) => view.name), "view");
  duplicates("$.rules", config.rules.map((rule) => rule.id), "rule id");
  duplicates("$.proposals", config.proposals.map((proposal) => proposal.id), "proposal id");

  inventories.pageTypes.forEach((type, index) => {
    const path = `$.inventories.pageTypes[${index}]`;
    duplicates(`${path}.slots`, type.slots, "slot");
    for (const slot of type.chrome) if (!type.slots.includes(slot)) issues.push({ path: `${path}.chrome`, message: `names slot "${slot}", which page type "${type.id}" does not have` });
    if (type.kind === "action" && !type.slots.includes(type.primarySlot)) issues.push({ path: `${path}.primarySlot`, message: `is "${type.primarySlot}", which page type "${type.id}" does not have` });
    if (type.kind === "action" && type.chrome.includes(type.primarySlot)) issues.push({ path: `${path}.primarySlot`, message: `"${type.primarySlot}" is also listed as chrome` });
    const body = type.slots.filter((slot) => !type.chrome.includes(slot) && !(type.kind === "action" && slot === type.primarySlot));
    if (body.length === 0) issues.push({ path, message: `page type "${type.id}" has no body slot: every slot is chrome or primary` });
  });
  inputs.tasks.forEach((task, index) => {
    if (!inventories.flowStates.includes(task.successState)) issues.push({ path: `$.inputs.tasks[${index}].successState`, message: `is "${task.successState}", which is not an inventoried flow state` });
  });

  const root = config.library.root;
  if (root) {
    const part = config.library.parts?.[root.component];
    if (config.library.parts && !part) issues.push({ path: "$.library.root.component", message: `is "${root.component}", which ${config.library.package} ${config.library.version} has no part of` });
    if (root.schemeProp !== undefined && root.props && root.schemeProp in root.props) issues.push({ path: "$.library.root.schemeProp", message: `"${root.schemeProp}" is also given in root.props; the view's scheme sets it` });
    const scheme = root.schemeProp === undefined ? undefined : part?.props[root.schemeProp];
    if (scheme && !(scheme.type === "string" || (scheme.type === "enum" && scheme.values.includes("light") && scheme.values.includes("dark")))) {
      issues.push({ path: "$.library.root.schemeProp", message: `"${root.schemeProp}" of ${root.component} does not take "light" and "dark"` });
    }
  }
  config.rules.forEach((rule, index) => issues.push(...ruleReferenceIssues(rule, config, `$.rules[${index}]`)));
  if (config.views.length === 0) {
    config.rules.forEach((rule, index) => {
      if (rule.type === "rendered") issues.push({ path: `$.rules[${index}]`, message: `rendered rule "${rule.id}" is in force, but the config names no views, so no snapshot would ever be measured` });
    });
  }
  return issues;
}

/** The references one rule makes, checked against a config: used for the rules in force and for rules a proposal adds. */
export function ruleReferenceIssues(rule: RuleSpec, config: ProjectConfig, path: string): Issue[] {
  const issues: Issue[] = [];
  if (rule.id === EXTRACT_RULE) issues.push({ path: `${path}.id`, message: `"${EXTRACT_RULE}" is reserved for what the extractor could not read` });
  const checkBound = (value: Bound | undefined, at: string) => {
    if (value !== undefined && typeof value !== "number" && !(value.cap in config.inputs.caps)) {
      issues.push({ path: at, message: `names cap "${value.cap}", which is not in inputs.caps (${Object.keys(config.inputs.caps).sort().join(", ") || "none"})` });
    }
  };
  const checkText = (text: TextMatch, at: string, eachAllowed: boolean) => {
    if (typeof text === "string") return;
    if ("rank" in text && !config.inputs.ranking.some((item) => item.rank === text.rank)) issues.push({ path: at, message: `names rank ${text.rank}, which inputs.ranking does not have` });
    if ("each" in text && !eachAllowed) issues.push({ path: at, message: `uses { "each": true } outside a count rule with "each"` });
  };
  const usedRoles = new Set<RoleName>();
  let usesEach = false;
  const walk = (selector: Selector, at: string, eachAllowed: boolean) => {
    if (selector.role) usedRoles.add(selector.role);
    if (selector.text !== undefined) {
      checkText(selector.text, `${at}.text`, eachAllowed);
      if (typeof selector.text === "object" && "each" in selector.text) usesEach = true;
    }
    if (typeof selector.layout === "string" && !config.inventories.layouts.includes(selector.layout)) issues.push({ path: `${at}.layout`, message: `names layout "${selector.layout}", which is not inventoried` });
    for (const key of ["inside", "notInside", "not"] as const) {
      const nested = selector[key];
      if (nested) walk(nested, `${at}.${key}`, eachAllowed);
    }
    selector.anyOf?.forEach((option, index) => walk(option, `${at}.anyOf[${index}]`, eachAllowed));
  };
  const checkPages = (pages: { readonly types?: readonly string[] } | undefined) => {
    for (const type of pages?.types ?? []) {
      if (!config.inventories.pageTypes.some((item) => item.id === type)) issues.push({ path: `${path}.pages.types`, message: `names page type "${type}", which is not inventoried` });
    }
  };

  switch (rule.type) {
    case "count":
      walk(rule.select, `${path}.select`, rule.each !== undefined);
      checkBound(rule.min, `${path}.min`);
      checkBound(rule.max, `${path}.max`);
      checkPages(rule.pages);
      if (rule.each !== undefined && !usesEach) issues.push({ path: `${path}.each`, message: `repeats over ${rule.each}, but the selector never uses { "each": true }, so every repeat counts the same thing` });
      if (rule.scope === "source" && rule.pages !== undefined) issues.push({ path: `${path}.pages`, message: "limits pages, but a source-scope count reads every file, not pages" });
      break;
    case "containment":
      walk(rule.select, `${path}.select`, false);
      if (rule.must === "nest-at-most") checkBound(rule.depth, `${path}.depth`);
      else walk(rule.of, `${path}.of`, false);
      checkPages(rule.pages);
      break;
    case "prop-values":
      walk(rule.select, `${path}.select`, false);
      break;
    case "requires":
      walk(rule.select, `${path}.select`, false);
      walk(rule.must, `${path}.must`, false);
      checkPages(rule.pages);
      break;
    case "slot": {
      if (!rule.slot.startsWith("$") && !config.inventories.pageTypes.some((type) => type.slots.includes(rule.slot))) {
        issues.push({ path: `${path}.slot`, message: `names slot "${rule.slot}", which no page type has` });
      } else if (rule.slot.startsWith("$") && !["$primary", "$body", "$chrome"].includes(rule.slot)) {
        issues.push({ path: `${path}.slot`, message: `is "${rule.slot}"; the special slots are "$primary", "$body" and "$chrome"` });
      }
      if (rule.holds) walk(rule.holds, `${path}.holds`, false);
      if (rule.only) walk(rule.only, `${path}.only`, false);
      checkBound(rule.min, `${path}.min`);
      checkBound(rule.max, `${path}.max`);
      checkPages(rule.pages);
      break;
    }
    case "reachable":
      walk(rule.select, `${path}.select`, false);
      break;
    case "rendered":
      if (rule.check === "target-size") checkBound(rule.minPx, `${path}.minPx`);
      if (rule.check === "first-view") checkText(rule.action, `${path}.action`, false);
      break;
    default:
  }

  for (const role of [...usedRoles].sort()) {
    const mapping = config.library.roles[role];
    if (mapping.components.length === 0) {
      issues.push({ path, message: `selects role "${role}", which the library maps to no component, so the rule could never fire` });
      continue;
    }
    for (const component of mapping.components) {
      const root = component.split(".")[0] ?? component;
      if (!config.inventories.components.includes(root)) {
        issues.push({ path, message: `selects role "${role}", which the library maps to ${component}, but ${root} is not an inventoried component, so the rule could never fire` });
      }
    }
  }
  return issues;
}
