import type { StylePropsRule } from "../../rules/types";
import { excludedBy } from "../../spec/catalog";
import { everyNode, locate, named, pointAt, where, type CheckContext } from "../context";
import { article } from "../describe";
import type { Finding } from "../report";
import type { Outcome } from "./outcome";

/**
 * No element written in the source sets a style prop: `style`, on any
 * element, or a prop the project excludes (`library.excludedProps`), on a
 * library part or an HTML element. Whatever value the prop takes, it styles
 * the part around the library's own variants and tokens. A prop a spread may
 * set, where the extractor cannot see through the spread, and any prop of an
 * element it cannot resolve, cannot be cleared: both are unverifiable.
 * A prototype's own components and the page kit take the names they like,
 * `style` apart: what they pass on is read where a part receives it.
 */
export function evaluateStyleProps(rule: StylePropsRule, ctx: CheckContext): Outcome {
  const excluded = ctx.config.library.excludedProps;
  const findings: Finding[] = [];
  for (const { node } of everyNode(ctx.model.source)) {
    const base = { rule: rule.id, ...locate(node.at), ...pointAt(ctx, [node]) };
    const at = `${named(node)} at ${where(node.at)}`;
    if (node.kind === "unresolved") {
      findings.push({ ...base, kind: "unverifiable", message: `Cannot tell whether <${node.name}> at ${where(node.at)} sets a style prop: ${node.reason ?? "it cannot be resolved"}.` });
      continue;
    }
    const part = node.kind === "library" || node.kind === "intrinsic";
    const owner = article(node.kind === "intrinsic" ? `<${node.name}>` : node.name);
    for (const name of Object.keys(node.props)) {
      const pattern = part ? excludedBy(excluded, name) : null;
      if (pattern === null && name !== "style") continue;
      const why = pattern === null ? "a style prop" : `a style prop the project excludes ("${pattern}" in library.excludedProps)`;
      findings.push({ ...base, kind: "violation", message: `${at} sets "${name}", ${why}: ${owner}'s styling must come from the library's own variants and tokens, not from props that style it directly.` });
    }
    if (node.openProps !== undefined) findings.push({ ...base, kind: "unverifiable", message: `Cannot tell whether ${at} sets a style prop: ${node.openProps}.` });
  }
  return { findings };
}
