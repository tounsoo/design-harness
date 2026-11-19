import { TAG_PROP } from "../runtime/tags";

/**
 * Finds what each element tag (`runtime/tags.ts`) drew, inside a frame. A
 * tag is a prop on a part's React element, so this reads React's own tree,
 * never the DOM's attributes: the outermost fiber that carries a tag owns it,
 * and its DOM elements are the outermost host elements under that fiber,
 * across portals. A part that renders one element gives that element; one
 * that renders several, all of them; one that renders only other parts,
 * their outermost elements; one that renders nothing, none, so the tag is
 * not drawn. A fiber below it with the same tag (a part passing its props on
 * to an inner part or a DOM element) adds nothing.
 *
 * It reads fields React has kept since version 16 (`child`, `sibling`,
 * `tag`, `stateNode`, `memoizedProps`, and the fiber root's `current`) and
 * the container key React 17 and later set (`__reactContainer$`). Pure over
 * that tree: the unit tests give it plain objects.
 */

/** The fields of a React fiber this reads. */
export type Fiber = {
  readonly tag: number;
  readonly stateNode: unknown;
  readonly memoizedProps: unknown;
  readonly child: Fiber | null;
  readonly sibling: Fiber | null;
};

/** React's work tags for host elements: HostComponent, HostHoistable and HostSingleton. Text (6) cannot be outlined. */
const HOST = new Set([5, 26, 27]);

function tagOf(fiber: Fiber): string | null {
  const props = fiber.memoizedProps;
  if (typeof props !== "object" || props === null) return null;
  const value = (props as Record<string, unknown>)[TAG_PROP];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The outermost host elements at or under `fiber`, in tree order. */
function hostsOf<T>(fiber: Fiber): T[] {
  if (HOST.has(fiber.tag)) return fiber.stateNode === null || fiber.stateNode === undefined ? [] : [fiber.stateNode as T];
  const out: T[] = [];
  for (let child = fiber.child; child; child = child.sibling) out.push(...hostsOf<T>(child));
  return out;
}

/** Every tag drawn under `root` (a root fiber), with the DOM elements it owns, in tree order. */
export function tagged<T>(root: Fiber): Map<string, T[]> {
  const out = new Map<string, T[]>();
  const walk = (fiber: Fiber, owner: string | null) => {
    const tag = tagOf(fiber);
    let next = owner;
    if (tag !== null && tag !== owner) {
      const hosts = hostsOf<T>(fiber);
      if (hosts.length > 0) out.set(tag, [...(out.get(tag) ?? []), ...hosts]);
      next = tag;
    }
    for (let child = fiber.child; child; child = child.sibling) walk(child, next);
  };
  walk(root, null);
  return out;
}

/**
 * The current root fiber of what React rendered into a container, or null.
 * The container keeps the root fiber React made first; once React has
 * committed, the tree on screen may be its alternate, which the fiber root
 * (that fiber's `stateNode`) names as `current`.
 */
export function rootFiber(container: object): Fiber | null {
  const key = Object.keys(container).find((name) => name.startsWith("__reactContainer$"));
  const value = key === undefined ? undefined : (container as Record<string, unknown>)[key];
  if (typeof value !== "object" || value === null || !("child" in value)) return null;
  const root = (value as Fiber).stateNode as { current?: unknown } | null;
  const current = typeof root === "object" && root !== null ? root.current : undefined;
  return typeof current === "object" && current !== null && "child" in current ? (current as Fiber) : (value as Fiber);
}

/** What each tag drew in the page under `container`, in the DOM now. */
export function tagsIn(container: Element): Map<string, Element[]> {
  const root = rootFiber(container);
  if (!root) return new Map();
  const out = new Map<string, Element[]>();
  for (const [tag, nodes] of tagged<unknown>(root)) {
    const elements = nodes.filter((node): node is Element => node instanceof Element && node.isConnected);
    if (elements.length > 0) out.set(tag, elements);
  }
  return out;
}
