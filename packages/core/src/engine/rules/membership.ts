import { PAGE_KIT } from "../../extract";
import { resolvePath } from "../../extract/modules";
import type { MembershipRule } from "../../rules/types";
import { everyNode, locate, named, where, type CheckContext } from "../context";
import type { Finding } from "../report";
import type { Outcome } from "./outcome";

const REACT = new Set(["react", "react/jsx-runtime"]);

/** Only what the project's inventories list: components, imports, page types, layouts and flow states. */
export function evaluateMembership(rule: MembershipRule, ctx: CheckContext): Outcome {
  switch (rule.of) {
    case "components":
      return { findings: components(rule, ctx) };
    case "imports":
      return { findings: imports(rule, ctx) };
    case "page-types":
      return {
        findings: [...ctx.prototype.pages]
          .filter((page) => !ctx.pageTypes.has(page.pageType))
          .map((page) => ({
            rule: rule.id,
            page: page.id,
            ...locate({ file: page.component.file, line: 1, column: 1 }),
            kind: "violation" as const,
            message: `Page "${page.id}" is a "${page.pageType}" page, which is not an inventoried page type (${list(ctx.config.inventories.pageTypes.map((type) => type.id))}).`,
          })),
      };
    case "layouts":
      return {
        findings: [...ctx.prototype.layouts]
          .filter((layout) => !ctx.config.inventories.layouts.includes(layout.id))
          .map((layout) => ({
            rule: rule.id,
            ...locate({ file: layout.component.file, line: 1, column: 1 }),
            kind: "violation" as const,
            message: `Layout "${layout.id}" is not an inventoried layout (${list(ctx.config.inventories.layouts)}).`,
          })),
      };
    case "flow-states":
      return {
        findings: [...new Set(ctx.prototype.flow.states)]
          .filter((state) => !ctx.config.inventories.flowStates.includes(state))
          .map((state) => ({ rule: rule.id, state, kind: "violation" as const, message: `Flow state "${state}" is not an inventoried flow state (${list(ctx.config.inventories.flowStates)}).` })),
      };
  }
}

function list(items: readonly string[]): string {
  return items.length === 0 ? "none" : [...items].sort().map((item) => `"${item}"`).join(", ");
}

/** Every library part written in the source, and every name imported from the library, is an inventoried component. */
function components(rule: MembershipRule, ctx: CheckContext): Finding[] {
  const allowed = new Set(ctx.config.inventories.components);
  const findings: Finding[] = [];
  const inventory = list([...allowed]);
  for (const { node } of everyNode(ctx.model.source)) {
    if (node.kind === "library") {
      const root = node.name.split(".")[0] ?? node.name;
      if (!allowed.has(root)) findings.push({ rule: rule.id, ...locate(node.at), kind: "violation", message: `${named(node)} at ${where(node.at)} is from ${root}, which is not an inventoried component (${inventory}).` });
    } else if (node.kind === "unresolved") {
      findings.push({ rule: rule.id, ...locate(node.at), kind: "unverifiable", message: `Cannot tell which component <${node.name}> at ${where(node.at)} is: ${node.reason ?? "it cannot be resolved"}.` });
    }
  }
  const library = ctx.config.library.package;
  for (const load of ctx.model.loads) {
    if (load.specifier === null || (load.specifier !== library && !load.specifier.startsWith(`${library}/`))) continue;
    for (const name of load.names) {
      if (name === "*" || name === "default" || allowed.has(name)) continue;
      findings.push({ rule: rule.id, ...locate(load.at), kind: "violation", message: `${where(load.at)} imports ${name} from ${library}, which is not an inventoried component (${inventory}).` });
    }
  }
  return findings;
}

/** Every module a file loads is the project's library, React, the page kit, or one of the prototype's own files, by a static import. */
function imports(rule: MembershipRule, ctx: CheckContext): Finding[] {
  const library = ctx.config.library.package;
  const files = new Set(Object.keys(ctx.prototype.files));
  const findings: Finding[] = [];
  for (const load of ctx.model.loads) {
    const base = { rule: rule.id, ...locate(load.at) };
    const at = where(load.at);
    if (load.specifier === null) {
      const how = load.held ? "holds require under another name" : `calls ${load.how === "require" ? "require()" : "import()"} with a computed specifier`;
      findings.push({ ...base, kind: "unverifiable", message: `${at} ${how}, so what it loads cannot be checked. Use a static import of a string.` });
      continue;
    }
    if (load.how === "dynamic-import" || load.how === "require") {
      findings.push({ ...base, kind: "unverifiable", message: `${at} loads "${load.specifier}" with ${load.how === "require" ? "require()" : "import()"} at runtime, so the page model cannot follow it. Use a static import.` });
      continue;
    }
    const specifier = load.specifier;
    if (specifier === library || specifier.startsWith(`${library}/`) || REACT.has(specifier)) continue;
    if (specifier === PAGE_KIT) {
      for (const name of load.names) {
        // PageProps is the type of a page's props, the scenario contract; a type import compiles away.
        if (name !== "Slot" && name !== "PageProps" && name !== "*") findings.push({ ...base, kind: "violation", message: `${at} imports ${name} from ${PAGE_KIT}, which exports only Slot and the PageProps type.` });
      }
      continue;
    }
    if (specifier.startsWith(".")) {
      if (resolvePath(load.at.file, specifier, files) === null) findings.push({ ...base, kind: "violation", message: `${at} imports "${specifier}", which is not a file in the prototype.` });
      continue;
    }
    findings.push({ ...base, kind: "violation", message: `${at} imports "${specifier}", which is not the project's library (${library}), React, the page kit (${PAGE_KIT}) or a file in the prototype.` });
  }
  return findings;
}
