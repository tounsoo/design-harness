import type { ElementNode, PropValue } from "../extract/model";
import type { Literal, RoleName, Selector } from "../rules/types";
import { textOf, type CheckContext } from "./context";

/**
 * A three-valued answer: true, false, or null when the source does not say,
 * with the reason. Selectors combine with Kleene logic, so an unknown part
 * only makes the whole unknown when it could change the answer.
 */
export type Tri = { readonly v: boolean | null; readonly why?: string };

const TRUE: Tri = { v: true };
const FALSE: Tri = { v: false };
const unknown = (why: string): Tri => ({ v: null, why });

function and(parts: readonly (() => Tri)[]): Tri {
  let pending: Tri | null = null;
  for (const part of parts) {
    const result = part();
    if (result.v === false) return FALSE;
    if (result.v === null && !pending) pending = result;
  }
  return pending ?? TRUE;
}

function or(parts: readonly (() => Tri)[]): Tri {
  let pending: Tri | null = null;
  for (const part of parts) {
    const result = part();
    if (result.v === true) return TRUE;
    if (result.v === null && !pending) pending = result;
  }
  return pending ?? FALSE;
}

function not(result: Tri): Tri {
  return result.v === null ? result : result.v ? FALSE : TRUE;
}

/** What a node's prop is: a value, a set of possible values, absent, or unknown. */
export type PropState = { readonly kind: "values"; readonly values: readonly Literal[] } | { readonly kind: "missing" } | { readonly kind: "unknown"; readonly why: string };

export function propState(node: ElementNode, name: string): PropState {
  const prop: PropValue | undefined = node.props[name];
  if (!prop) return node.openProps ? { kind: "unknown", why: node.openProps } : { kind: "missing" };
  switch (prop.kind) {
    case "literal":
      return { kind: "values", values: [prop.value] };
    case "choice":
      return { kind: "values", values: prop.values };
    case "elements":
      return { kind: "unknown", why: `its ${name} holds elements` };
    case "dynamic":
      return { kind: "unknown", why: `its ${name} is ${prop.reason}` };
  }
}

/** Whether a prop is among `allowed`, reading every possible value: all in is true, none in is false, some in is unknown. */
function propIn(node: ElementNode, name: string, allowed: readonly Literal[], whenMissing: boolean): Tri {
  const state = propState(node, name);
  if (state.kind === "missing") return whenMissing ? TRUE : FALSE;
  if (state.kind === "unknown") return unknown(state.why);
  const hits = state.values.filter((value) => allowed.includes(value)).length;
  if (hits === state.values.length) return TRUE;
  if (hits === 0) return FALSE;
  return unknown(`its ${name} is one of ${state.values.map((value) => JSON.stringify(value)).join(" or ")}, chosen at runtime`);
}

function unresolved(node: ElementNode): Tri {
  return unknown(node.reason ?? `${node.name} could not be resolved`);
}

function hasRole(node: ElementNode, role: RoleName, ctx: CheckContext): Tri {
  if (node.kind === "unresolved") return unresolved(node);
  if (node.kind !== "library") return FALSE;
  const mapping = ctx.config.library.roles[role];
  if (!mapping.components.includes(node.name)) return FALSE;
  return mapping.prop ? propIn(node, mapping.prop.name, mapping.prop.values, mapping.prop.whenMissing) : TRUE;
}

export type MatchEnv = { readonly ctx: CheckContext; readonly each?: string };

/** Whether a node, with the nodes above it, matches a selector. */
export function matches(node: ElementNode, ancestors: readonly ElementNode[], selector: Selector, env: MatchEnv): Tri {
  const { ctx } = env;
  const checks: (() => Tri)[] = [];
  const { component, role, props, hasProp, text, page, layout, inside, notInside, anyOf } = selector;
  if (component !== undefined) {
    const names = typeof component === "string" ? [component] : component;
    checks.push(() => (node.kind === "unresolved" ? unresolved(node) : (node.kind === "library" || node.kind === "intrinsic") && names.includes(node.name) ? TRUE : FALSE));
  }
  if (role !== undefined) checks.push(() => hasRole(node, role, ctx));
  if (props !== undefined) {
    for (const [name, value] of Object.entries(props).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      checks.push(() => (node.kind === "unresolved" ? unresolved(node) : propIn(node, name, [value], false)));
    }
  }
  if (hasProp !== undefined) {
    checks.push(() => {
      if (node.kind === "unresolved") return unresolved(node);
      if (hasProp in node.props) return TRUE;
      return node.openProps ? unknown(node.openProps) : FALSE;
    });
  }
  if (text !== undefined) {
    checks.push(() => {
      const wanted = textOf(text, ctx, env.each);
      if (node.textDynamic) return node.text === wanted ? TRUE : unknown(`its text${node.text ? ` "${node.text}"` : ""} is partly computed at runtime`);
      return node.text === wanted ? TRUE : FALSE;
    });
  }
  if (page !== undefined) checks.push(() => (node.kind === "unresolved" ? unresolved(node) : node.kind === "component" && node.page !== undefined ? TRUE : FALSE));
  if (layout !== undefined) {
    checks.push(() => {
      if (node.kind === "unresolved") return unresolved(node);
      if (node.kind !== "component" || node.layout === undefined) return FALSE;
      return layout === true || node.layout === layout ? TRUE : FALSE;
    });
  }
  if (inside !== undefined) checks.push(() => insideOf(ancestors, inside, env));
  if (notInside !== undefined) checks.push(() => not(insideOf(ancestors, notInside, env)));
  if (selector.not !== undefined) {
    const negated = selector.not;
    checks.push(() => not(matches(node, ancestors, negated, env)));
  }
  if (anyOf !== undefined) checks.push(() => or(anyOf.map((option) => () => matches(node, ancestors, option, env))));
  return and(checks);
}

/** Whether any ancestor matches. Each ancestor is matched against its own ancestors. */
export function insideOf(ancestors: readonly ElementNode[], selector: Selector, env: MatchEnv): Tri {
  return or(ancestors.map((ancestor, index) => () => matches(ancestor, ancestors.slice(0, index), selector, env)));
}

/** The nearest ancestor that definitely matches, for a message. */
export function nearestMatching(ancestors: readonly ElementNode[], selector: Selector, env: MatchEnv): ElementNode | null {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index] as ElementNode;
    if (matches(ancestor, ancestors.slice(0, index), selector, env).v === true) return ancestor;
  }
  return null;
}
