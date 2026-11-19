import type { MembershipRule } from "../../rules/types";
import { everyNode, locate, named, pointAt, where, type CheckContext } from "../context";
import type { Finding } from "../report";
import type { Outcome } from "./outcome";

/** Only what the project's inventories list: components, page types, layouts and flow states. */
export function evaluateMembership(rule: MembershipRule, ctx: CheckContext): Outcome {
  switch (rule.of) {
    case "components":
      return { findings: components(rule, ctx) };
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

/** Every library part written in the specs is an inventoried component. */
function components(rule: MembershipRule, ctx: CheckContext): Finding[] {
  const allowed = new Set(ctx.config.inventories.components);
  const findings: Finding[] = [];
  const inventory = list([...allowed]);
  for (const { node } of everyNode(ctx.model.source)) {
    if (node.kind === "library") {
      const root = node.name.split(".")[0] ?? node.name;
      if (!allowed.has(root)) findings.push({ rule: rule.id, ...locate(node.at), ...pointAt(ctx, [node]), kind: "violation", message: `${named(node)} at ${where(node.at)} is from ${root}, which is not an inventoried component (${inventory}).` });
    } else if (node.kind === "unresolved") {
      findings.push({ rule: rule.id, ...locate(node.at), kind: "unverifiable", message: `Cannot tell which component <${node.name}> at ${where(node.at)} is: ${node.reason ?? "it cannot be resolved"}.` });
    }
  }
  return findings;
}
