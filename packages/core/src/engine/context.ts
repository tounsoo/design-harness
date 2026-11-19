import type { PageType, ProjectConfig } from "../config/types";
import type { ElementNode, PageModel, PrototypeModel, SourceLocation } from "../prototype/model";
import type { Prototype } from "../prototype/types";
import type { RenderedSnapshot } from "../rendered/types";
import type { Bound, PageFilter, TextMatch } from "../rules/types";
import type { Finding, FindingTarget } from "./report";

/** Everything a rule reads: the config, the prototype, its extracted model and any rendered snapshots. */
export type CheckContext = {
  readonly config: ProjectConfig;
  readonly prototype: Prototype;
  readonly model: PrototypeModel;
  readonly snapshots: readonly RenderedSnapshot[] | undefined;
  readonly pageTypes: ReadonlyMap<string, PageType>;
};

/** The part of a check's context that only reads the config: enough to describe a rule or a selector in words. */
export type ConfigContext = Pick<CheckContext, "config">;

export function bound(value: Bound, ctx: ConfigContext): number {
  if (typeof value === "number") return value;
  // Config validation guarantees the cap exists; a missing one checks as 0, the strictest reading.
  return ctx.config.inputs.caps[value.cap]?.value ?? 0;
}

export function boundLabel(value: Bound, ctx: ConfigContext): string {
  return typeof value === "number" ? String(value) : `${bound(value, ctx)} (${value.cap})`;
}

export function textOf(match: TextMatch, ctx: ConfigContext, each: string | undefined): string {
  if (typeof match === "string") return match;
  if ("rank" in match) return ctx.config.inputs.ranking.find((item) => item.rank === match.rank)?.action ?? "";
  return each ?? "";
}

/** The pages a rule's filter keeps, in id order. A page whose type is not inventoried is left to the page-types membership rule. */
export function pagesFor(filter: PageFilter | undefined, ctx: CheckContext): { page: PageModel; type: PageType }[] {
  const out: { page: PageModel; type: PageType }[] = [];
  for (const page of ctx.model.pages) {
    const type = ctx.pageTypes.get(page.pageType);
    if (!type) continue;
    if (filter?.kinds && !filter.kinds.includes(type.kind)) continue;
    if (filter?.types && !filter.types.includes(type.id)) continue;
    out.push({ page, type });
  }
  return out;
}

/** `file:line:column`, and for an element a spec layout draws, where the layout is used. */
export function where(at: SourceLocation): string {
  return `${at.file}:${at.line}:${at.column}${viaText(at.via)}`;
}

/** ` (in layout "x" used at pages/p.json:9:5)`, nearest use first; empty without one. */
export function viaText(via: SourceLocation["via"]): string {
  if (!via || via.length === 0) return "";
  const steps = via.map((use) => (use.slot !== undefined ? `in slot "${use.slot}" of layout "${use.layout}" at ${use.file}:${use.line}:${use.column}` : `in layout "${use.layout}" used at ${use.file}:${use.line}:${use.column}`));
  return ` (${steps.join(", ")})`;
}

export function locate(at: SourceLocation): Pick<Finding, "file" | "line" | "column" | "via"> {
  return { file: at.file, line: at.line, column: at.column, ...(at.via && at.via.length > 0 ? { via: at.via } : {}) };
}

/** Elements of a page model by origin, with the page each is on: where an element read from the source renders. */
const RENDERED = new WeakMap<PrototypeModel, ReadonlyMap<string, readonly { readonly node: ElementNode; readonly page: string }[]>>();

function renderedByOrigin(model: PrototypeModel): ReadonlyMap<string, readonly { readonly node: ElementNode; readonly page: string }[]> {
  const known = RENDERED.get(model);
  if (known) return known;
  const index = new Map<string, { node: ElementNode; page: string }[]>();
  for (const page of model.pages) {
    for (const { node } of descendants(page.root)) index.set(node.origin, [...(index.get(node.origin) ?? []), { node, page: page.id }]);
  }
  RENDERED.set(model, index);
  return index;
}

/** The elements a frame can find for one node: itself, or for a page or a layout instance, the outermost elements it draws. */
function drawn(node: ElementNode): ElementNode[] {
  if (node.kind === "library" || node.kind === "kit") return [node];
  // An element core cannot expand has no tag in a frame; its finding points at the file alone.
  if (node.kind === "unresolved") return [];
  return node.children.flatMap(drawn);
}

function targetOf(node: ElementNode, page: string | undefined): FindingTarget {
  const { file, line, column, via } = node.at;
  return { file, line, column, ...(via && via.length > 0 ? { via } : {}), ...(page !== undefined ? { page } : {}), ...(node.key !== undefined ? { key: node.key } : {}) };
}

/**
 * Where a finding's elements render, for `Finding.targets`: one target per
 * element a frame can find, in the order given. `page` is the page the nodes
 * were read on; without it the nodes are the source as written, and each is
 * looked up on every page that renders it (by `origin`), or kept with no page
 * when none does. A local component or a layout instance stands for the
 * outermost elements it renders. Empty for a node that renders nothing a
 * frame can find, so the finding carries no `targets`.
 */
export function pointAt(ctx: Pick<CheckContext, "model">, nodes: readonly ElementNode[], page?: string): Pick<Finding, "targets"> {
  const out: FindingTarget[] = [];
  const seen = new Set<string>();
  const add = (target: FindingTarget) => {
    const id = JSON.stringify(target);
    if (seen.has(id)) return;
    seen.add(id);
    out.push(target);
  };
  for (const node of nodes) {
    if (page !== undefined) {
      for (const one of drawn(node)) add(targetOf(one, page));
      continue;
    }
    const rendered = renderedByOrigin(ctx.model).get(node.origin) ?? [];
    if (rendered.length === 0) for (const one of drawn(node)) add(targetOf(one, undefined));
    for (const item of rendered) for (const one of drawn(item.node)) add(targetOf(one, item.page));
  }
  return out.length > 0 ? { targets: out } : {};
}

/** How a message names an element: `Button.Root "Book room"`, or `<room-details>` for one core cannot expand. */
export function named(node: ElementNode): string {
  const name = node.kind === "unresolved" ? `<${node.name}>` : node.name;
  // Text is shown for an element whose text is its own, not gathered from children with text of their own.
  const own = node.children.every((child) => child.text === "");
  const text = own && node.text && !node.textDynamic && node.text.length <= 40 ? ` "${node.text}"` : "";
  return `${name}${text}`;
}

/** A node and the nodes above it in one tree, nearest last. */
export type Placed = { readonly node: ElementNode; readonly ancestors: readonly ElementNode[] };

/** Every node under `root`, not `root` itself, with its ancestors, `root` included. */
export function descendants(root: ElementNode): Placed[] {
  const out: Placed[] = [];
  const walk = (node: ElementNode, ancestors: readonly ElementNode[]) => {
    for (const child of node.children) {
      out.push({ node: child, ancestors });
      walk(child, [...ancestors, child]);
    }
  };
  walk(root, [root]);
  return out;
}

/** Every node in a forest with its ancestors. */
export function everyNode(forest: readonly ElementNode[]): Placed[] {
  const out: Placed[] = [];
  const walk = (node: ElementNode, ancestors: readonly ElementNode[]) => {
    out.push({ node, ancestors });
    for (const child of node.children) walk(child, [...ancestors, node]);
  };
  for (const node of forest) walk(node, []);
  return out;
}

/** True when the node, or a node above it, renders once per item of a list of unknown length. */
export function isRepeated(placed: Placed): boolean {
  return placed.node.repeated || placed.ancestors.some((ancestor) => ancestor.repeated);
}
