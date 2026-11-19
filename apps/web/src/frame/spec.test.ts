import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { checkPrototype } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { seedSpec } from "../../test/nook";
import { specPayload } from "../runtime/spec-payload";
import { TAG_PROP, tagOf } from "../runtime/tags";
import { specPage } from "./spec";

/**
 * The spec renderer's tags, drawn with React's server renderer over a fake
 * library whose every part shows the tag it was given: each part gets its
 * key in the expanded page, a Page's slots `<key>/slots/<name>`, and with
 * tags off, nothing.
 */

type Props = Record<string, unknown> & { readonly children?: ReactNode };

/** A library with one fake part for each part the catalog draws, each writing the tag it got as `data-tag`. */
function fakeLibrary(types: readonly string[]): Record<string, Record<string, (props: Props) => ReactNode>> {
  const library: Record<string, Record<string, (props: Props) => ReactNode>> = {};
  for (const type of types) {
    const [component, part] = type.split(".");
    if (!component || !part) continue;
    (library[component] ??= {})[part] = (props: Props) => createElement("div", { "data-type": type, "data-tag": props[TAG_PROP] }, props.children);
  }
  return library;
}

function Slot(props: Props & { readonly name: string }) {
  return createElement("section", { "data-slot": props.name, "data-tag": props[TAG_PROP] }, props.children);
}

function draw(scenario: string, tags: boolean): string[] {
  const prototype = seedSpec();
  const item = prototype.scenarios.find((entry) => entry.id === scenario);
  const payload = item ? specPayload(nook, prototype, item) : null;
  if (!payload) throw new Error(`no payload for ${scenario}`);
  const library = fakeLibrary(Object.keys(payload.parts));
  const page = specPage(library, Slot, payload, ["title", "facts", "body", "alternate", "action"], { tags });
  const html = renderToStaticMarkup(createElement(page));
  return [...html.matchAll(/data-tag="([^"]*)"/g)].map((match) => match[1] ?? "");
}

describe("the spec renderer's element tags", () => {
  it("tags each part with its key in the expanded page, layout instances scoped, and each slot under the page's key", () => {
    const tags = draw("lantern-open", true);
    expect(tags).toEqual(expect.arrayContaining(["page/slots/title", "page/slots/action", "name", "book", "hold", "details/details", "details/summary", "question/question"]));
    // A repeat draws one element per item, each under the element's one key.
    expect(tags.filter((tag) => tag === "details/item")).toHaveLength(2);
    // An element whose condition is false for the scenario is not drawn, so its tag is not there.
    expect(tags).not.toContain("booked-note");
    expect(draw("lantern-booked", true)).toContain("booked-note");
  });

  it("draws the tags core's findings name: every target of every element a booking page renders", () => {
    const prototype = seedSpec();
    const report = checkPrototype({ config: nook, prototype: { ...prototype, files: { ...prototype.files, "pages/booking.json": (prototype.files["pages/booking.json"] ?? "").replace('"variant": "secondary", "text": "Hold room"', '"variant": "primary", "text": "Hold room"') } } });
    const finding = report.findings.find((item) => item.rule === "one-primary-per-page");
    expect(finding?.targets?.map(tagOf)).toEqual(["hold", "book"]);
    const drawn = new Set(draw("lantern-open", true));
    for (const target of finding?.targets ?? []) expect(drawn.has(tagOf(target) ?? "")).toBe(true);
  });

  it("passes no tag with tags off", () => {
    expect(draw("lantern-open", false)).toEqual([]);
  });
});
