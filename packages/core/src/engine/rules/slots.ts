import type { PageType } from "../../config/types";
import type { ElementNode } from "../../prototype/model";
import type { PageStructureRule, ReachableRule, SlotRule } from "../../rules/types";
import { bound, boundLabel, everyNode, locate, named, pagesFor, pointAt, where, type CheckContext } from "../context";
import { article, describe } from "../describe";
import type { Finding } from "../report";
import { matches } from "../select";
import type { Outcome } from "./outcome";

/** The slot names a slot rule means on one page type. */
export function slotNames(slot: string, type: PageType): string[] {
  if (slot === "$primary") return type.kind === "action" ? [type.primarySlot] : [];
  if (slot === "$chrome") return [...type.chrome];
  if (slot === "$body") return type.slots.filter((name) => !type.chrome.includes(name) && !(type.kind === "action" && name === type.primarySlot));
  return type.slots.includes(slot) ? [slot] : [];
}

function slotName(node: ElementNode): string | null {
  const prop = node.props.name;
  return prop?.kind === "literal" && typeof prop.value === "string" ? prop.value : null;
}

/** Slot elements of a page, not counting slots of another page rendered inside it. */
function slotsOf(root: ElementNode): { node: ElementNode; ancestors: ElementNode[] }[] {
  const out: { node: ElementNode; ancestors: ElementNode[] }[] = [];
  const walk = (node: ElementNode, ancestors: ElementNode[]) => {
    for (const child of node.children) {
      if (child.kind === "component" && child.page !== undefined) continue;
      if (child.kind === "kit" && child.name === "Slot") out.push({ node: child, ancestors });
      walk(child, [...ancestors, child]);
    }
  };
  walk(root, [root]);
  return out;
}

/** The elements a slot holds at its top level: a layout instance there is one element, the layout, not what it draws. */
function topLevel(slot: ElementNode, ancestors: readonly ElementNode[]): { node: ElementNode; ancestors: ElementNode[]; repeated: boolean }[] {
  const above = [...ancestors, slot];
  const repeated = slot.repeated || ancestors.some((node) => node.repeated);
  return slot.children.map((child) => ({ node: child, ancestors: above, repeated: repeated || child.repeated }));
}

/** What a named slot holds: how many top-level elements match `holds`, and whether every one matches `only`. */
export function evaluateSlot(rule: SlotRule, ctx: CheckContext): Outcome {
  const findings: Finding[] = [];
  const env = { ctx };
  for (const { page, type } of pagesFor(rule.pages, ctx)) {
    const names = slotNames(rule.slot, type);
    if (names.length === 0) continue;
    const filled = slotsOf(page.root).filter(({ node }) => names.includes(slotName(node) ?? ""));
    const items = filled.flatMap(({ node, ancestors }) => topLevel(node, ancestors).map((item) => ({ ...item, slot: slotName(node) ?? "" })));
    const label = `slot "${names.join('", "')}" of page "${page.id}"`;
    const holds = rule.holds;
    if (holds) {
      const what = describe(holds, ctx, { plural: true });
      const judged = items.map((item) => ({ ...item, result: matches(item.node, item.ancestors, holds, env) }));
      const definite = judged.filter((item) => item.result.v === true);
      const maybe = judged.filter((item) => item.result.v === null);
      const max = rule.max === undefined ? undefined : bound(rule.max, ctx);
      const min = rule.min === undefined ? undefined : bound(rule.min, ctx);
      const repeated = definite.find((item) => item.repeated);
      if (rule.max !== undefined && max !== undefined && (definite.length > max || repeated)) {
        const at = (repeated ?? definite[max] ?? definite[0])?.node.at;
        const listed = definite.map(({ node }) => `${named(node)} at ${where(node.at)}`).join(", ");
        findings.push({
          rule: rule.id,
          page: page.id,
          ...(at ? locate(at) : {}),
          ...pointAt(ctx, repeated ? [repeated.node] : definite.map((item) => item.node), page.id),
          ...(repeated ? {} : { evidence: { kind: "count-vs-cap" as const, count: definite.length, cap: max, bound: "max" as const, unit: what } }),
          kind: "violation",
          message: repeated
            ? `The ${label} renders ${what} once per item of a list, so it may hold more than ${boundLabel(rule.max, ctx)}.`
            : `The ${label} accepts at most ${boundLabel(rule.max, ctx)} ${what}, found ${definite.length}: ${listed}.`,
        });
      } else if (rule.min !== undefined && min !== undefined && definite.length + maybe.length < min) {
        const which = names.length === 1 ? `slot "${names[0]}"` : `slots "${names.join('", "')}"`;
        findings.push({
          rule: rule.id,
          page: page.id,
          ...locate(page.root.at),
          evidence: { kind: "count-vs-cap", count: definite.length, cap: min, bound: "min", unit: what },
          kind: "violation",
          message: filled.length === 0 ? `Page "${page.id}" does not fill its ${which}, which must hold at least ${boundLabel(rule.min, ctx)} ${what}.` : `The ${label} must hold at least ${boundLabel(rule.min, ctx)} ${what}, found ${definite.length}.`,
        });
      } else if ((max !== undefined && definite.length + maybe.length > max) || (min !== undefined && definite.length < min)) {
        for (const item of maybe) {
          findings.push({ rule: rule.id, page: page.id, ...locate(item.node.at), ...pointAt(ctx, [item.node], page.id), kind: "unverifiable", message: `Cannot tell whether ${named(item.node)} at ${where(item.node.at)} in the ${label} is one of the ${what}: ${item.result.why ?? "it cannot be read statically"}.` });
        }
      }
    }
    if (rule.only) {
      const allowed = describe(rule.only, ctx);
      for (const item of items) {
        const result = matches(item.node, item.ancestors, rule.only, env);
        if (result.v === true) continue;
        findings.push({
          rule: rule.id,
          page: page.id,
          ...locate(item.node.at),
          ...pointAt(ctx, [item.node], page.id),
          kind: result.v === false ? "violation" : "unverifiable",
          message:
            result.v === false
              ? `The ${label} holds ${named(item.node)} at ${where(item.node.at)}, which is not ${article(allowed)}.`
              : `Cannot tell whether ${named(item.node)} at ${where(item.node.at)} in the ${label} is ${article(allowed)}: ${result.why ?? "it cannot be read statically"}.`,
        });
      }
    }
  }
  return { findings };
}

/** Every element in the source that matches `select` is reached from a page, so the per-page rules counted it. */
export function evaluateReachable(rule: ReachableRule, ctx: CheckContext): Outcome {
  const reached = new Set<string>();
  for (const page of ctx.model.pages) {
    for (const { node } of everyNode([page.root])) reached.add(node.origin);
  }
  const findings: Finding[] = [];
  const env = { ctx };
  for (const { node, ancestors } of everyNode(ctx.model.source)) {
    if (reached.has(node.origin)) continue;
    const result = matches(node, ancestors, rule.select, env);
    if (result.v === false) continue;
    const what = describe(rule.select, ctx);
    findings.push({
      rule: rule.id,
      ...locate(node.at),
      ...pointAt(ctx, [node]),
      kind: result.v === true ? "violation" : "unverifiable",
      message:
        result.v === true
          ? `${named(node)} at ${where(node.at)} is ${article(what)} that no page reaches, so the per-page rules cannot count it. Draw it from a page, not from an element nothing lists or an unused file.`
          : `${named(node)} at ${where(node.at)} may be ${article(what)} (${result.why ?? "it cannot be read statically"}), and no page reaches it, so the per-page rules cannot count it.`,
    });
  }
  return { findings };
}

/**
 * Each page fills only its page type's slots and puts nothing outside them.
 * A spec page's slots are the keys of its root's `slots`, so each is filled
 * once, by name, and none sits inside another: what is left to check is a
 * slot the page type lacks and an element outside every slot.
 */
export function evaluatePageStructure(rule: PageStructureRule, ctx: CheckContext): Outcome {
  const findings: Finding[] = [];
  for (const { page, type } of pagesFor(undefined, ctx)) {
    const walk = (node: ElementNode) => {
      for (const child of node.children) {
        const base = { rule: rule.id, page: page.id, ...locate(child.at), ...pointAt(ctx, [child], page.id) };
        if (child.kind === "component" && child.page !== undefined) continue;
        if (child.kind === "kit" && child.name === "Slot") {
          const name = slotName(child);
          if (name !== null && !type.slots.includes(name)) {
            findings.push({ ...base, kind: "violation", message: `Page "${page.id}" fills slot "${name}" at ${where(child.at)}, but page type "${type.id}" has no such slot; its slots are ${type.slots.map((item) => `"${item}"`).join(", ")}.` });
          }
          continue;
        }
        if (child.kind === "component") {
          walk(child);
          continue;
        }
        findings.push({ ...base, kind: child.kind === "unresolved" ? "unverifiable" : "violation", message: `${named(child)} at ${where(child.at)} is outside every slot of page "${page.id}". Put it in one of page type "${type.id}"'s slots: ${type.slots.map((item) => `"${item}"`).join(", ")}.` });
      }
    };
    walk(page.root);
  }
  return { findings };
}
