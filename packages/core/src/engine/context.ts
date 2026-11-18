import type { PageType, ProjectConfig } from "../config/types";
import type { ElementNode, PageModel, PrototypeModel, SourceLocation } from "../extract/model";
import type { Prototype } from "../prototype/types";
import type { RenderedSnapshot } from "../rendered/types";
import type { Bound, PageFilter, TextMatch } from "../rules/types";
import type { Finding } from "./report";

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

export function where(at: SourceLocation): string {
  return `${at.file}:${at.line}:${at.column}`;
}

export function locate(at: SourceLocation): Pick<Finding, "file" | "line" | "column"> {
  return { file: at.file, line: at.line, column: at.column };
}

/** How a message names an element: `Button.Root "Book room"`, or `<button>`. */
export function named(node: ElementNode): string {
  const name = node.kind === "intrinsic" ? `<${node.name}>` : node.kind === "unresolved" ? `<${node.name}>` : node.name;
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
