import { describe, expect, it } from "vitest";
import { rootFiber, tagged, type Fiber } from "./tags";

/** A fiber, as React keeps it: a work tag, a DOM node for a host element, props, and its first child and next sibling. */
type Node = { readonly tag: number; readonly name?: string; readonly props?: Record<string, unknown>; readonly children?: readonly Node[] };

const HOST = 5;
const TEXT = 6;
const FUNCTION = 0;
const PORTAL = 4;

function fiber(node: Node): Fiber {
  const children = (node.children ?? []).map(fiber);
  children.forEach((child, index) => Object.assign(child, { sibling: children[index + 1] ?? null }));
  return { tag: node.tag, stateNode: node.tag === HOST ? node.name : null, memoizedProps: node.props ?? {}, child: children[0] ?? null, sibling: null };
}

const part = (tag: string | undefined, children: readonly Node[], props: Record<string, unknown> = {}): Node => ({ tag: FUNCTION, props: { ...props, ...(tag ? { "data-dh-source": tag } : {}) }, children });
const host = (name: string, children: readonly Node[] = [], props: Record<string, unknown> = {}): Node => ({ tag: HOST, name, props, children });

describe("finding what each element tag drew in React's tree", () => {
  it("gives a part's tag its outermost DOM element, and ignores the same tag passed on below it", () => {
    const tree = fiber(part(undefined, [part("page:1:1", [host("div", [part("button:2:3", [host("button", [{ tag: TEXT }], { "data-dh-source": "button:2:3" })])])])]));
    expect(Object.fromEntries(tagged<string>(tree))).toEqual({ "page:1:1": ["div"], "button:2:3": ["button"] });
  });

  it("gives a part that renders several elements all of them, one that renders only other parts their outermost elements, and one that renders nothing none", () => {
    const tree = fiber(
      host("main", [
        part("fragment", [host("dt"), host("dd")]),
        part("provider", [part("inner", [host("section")])]),
        part("nothing", []),
        part("portal", [{ tag: PORTAL, children: [host("dialog", [host("p")])] }]),
      ]),
    );
    expect(Object.fromEntries(tagged<string>(tree))).toEqual({ fragment: ["dt", "dd"], provider: ["section"], inner: ["section"], portal: ["dialog"] });
  });

  it("collects every item a repeated element draws, under the same tag", () => {
    const tree = fiber(part("stack", [host("div", [part("item", [host("p1")]), part("item", [host("p2")]), part("item", [host("p3")])])]));
    expect(tagged<string>(tree).get("item")).toEqual(["p1", "p2", "p3"]);
  });

  it("reads a tag only from a string prop: no other prop, no empty string, and no DOM attribute", () => {
    const tree = fiber(part(undefined, [part(undefined, [host("a")], { "data-dh-source": 7 }), part(undefined, [host("b")], { "data-dh-source": "" }), host("c", [], { "data-other": "x" })]));
    expect(tagged<string>(tree).size).toBe(0);
  });

  it("finds the current root fiber of what React rendered into a container, not the first one it kept there", () => {
    const first = { tag: 3, stateNode: null as unknown, memoizedProps: null, child: null, sibling: null };
    const current = fiber(part("page:1:1", [host("div")]));
    first.stateNode = { current };
    expect(rootFiber({ "__reactContainer$abc": first })).toBe(current);
    const alone = fiber(host("div"));
    expect(rootFiber({ "__reactContainer$abc": alone })).toBe(alone);
    expect(rootFiber({ other: alone })).toBeNull();
  });
});
