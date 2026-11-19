import { describe, expect, it } from "vitest";
import { nook } from "../examples/nook/project";
import { tally } from "../examples/tally/project";
import type { ProjectConfig } from "../src/config/types";
import { partSpecimen, unplacedRoles } from "../src/library/specimen";
import { parseProjectConfig } from "../src/parse";
import { readSpecs } from "../src/spec/read";

/**
 * A component's specimen, on the two libraries the repository describes:
 * every inventoried component of Nook (Todae) and Tally (Mantine) draws as
 * a spec its own config reads without an issue, the roles and the ranked
 * actions land on the parts that carry them, and a part a spec cannot
 * compose has no specimen and says why.
 */
type Element = { readonly type: string; readonly props: Record<string, unknown>; readonly children: readonly string[] };
function elements(config: ProjectConfig, component: string): Element[] {
  const specimen = partSpecimen(config, component);
  if (!specimen.ok) throw new Error(specimen.why);
  return Object.values((JSON.parse(specimen.prototype.files["pages/preview.json"] as string) as { elements: Record<string, Element> }).elements);
}

describe.each([
  ["Nook on Todae", nook],
  ["Tally on Mantine", tally],
] as const)("%s", (_, config) => {
  it("draws every inventoried component as a spec its own config reads without an issue", () => {
    for (const component of config.inventories.components) {
      for (const scheme of ["light", "dark"] as const) {
        const specimen = partSpecimen(config, component, scheme);
        if (!specimen.ok) throw new Error(`${component}: ${specimen.why}`);
        expect(parseProjectConfig(JSON.parse(JSON.stringify(specimen.config))).ok, component).toBe(true);
        expect(readSpecs(specimen.prototype, specimen.config).issues, component).toEqual([]);
        expect(specimen.config.views.map((view) => view.scheme)).toEqual([scheme]);
        expect(specimen.config.rules).toEqual([]);
        expect(specimen.config.library.package).toBe(config.library.package);
        expect(specimen.config.library.version).toBe(config.library.version);
        expect(specimen.samples.length).toBeGreaterThan(0);
        expect(specimen.parts).toBeGreaterThan(0);
      }
    }
  });

  it("is the same specimen for the same config, whatever order its keys come in", () => {
    const shuffled = JSON.parse(JSON.stringify(config, (_key, value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value))) as ProjectConfig;
    for (const component of config.inventories.components) expect(partSpecimen(shuffled, component)).toEqual(partSpecimen(config, component));
  });

  it("places every mapped role on a sample of its component", () => {
    const placed = new Set(config.inventories.components.flatMap((component) => {
      const specimen = partSpecimen(config, component);
      return specimen.ok ? specimen.samples.flatMap((sample) => sample.roles.map((item) => item.role)) : [];
    }));
    expect([...placed].sort()).toEqual(["action", "disclosure", "disclosure-summary", "primary-action", "question", "secondary-action"]);
    expect(unplacedRoles(config)).toEqual([]);
  });
});

describe("Todae's Button, in Nook", () => {
  const specimen = partSpecimen(nook, "Button");
  it("draws one button per variant, the values a role selects by first, with the ranked actions written on their level", () => {
    if (!specimen.ok) throw new Error(specimen.why);
    expect(specimen.samples).toEqual([
      { label: "Book room", part: "Button.Root", rank: 1, roles: [{ role: "action", how: "Button.Root" }, { role: "primary-action", how: "variant primary, or none" }] },
      { label: "Hold room", part: "Button.Root", rank: 2, roles: [{ role: "action", how: "Button.Root" }, { role: "secondary-action", how: "variant secondary" }] },
      { label: "ghost", part: "Button.Root", roles: [{ role: "action", how: "Button.Root" }] },
    ]);
    expect(elements(nook, "Button").filter((element) => element.type === "Button.Root").map((element) => element.props)).toEqual([
      { variant: "primary", text: "Book room" },
      { variant: "secondary", text: "Hold room" },
      { variant: "ghost", text: "ghost" },
    ]);
    expect(specimen.parts).toBe(3);
  });
});

describe("the other kinds of part", () => {
  it("draws a disclosure closed, with its summary, and says which part carries each role", () => {
    const todae = partSpecimen(nook, "Disclosure");
    expect(todae.ok && todae.samples).toEqual([{ label: "Section name", part: "Disclosure.Root", roles: [{ role: "disclosure", how: "Disclosure.Root" }, { role: "disclosure-summary", how: "Disclosure.Summary" }] }]);
    expect(elements(nook, "Disclosure").find((element) => element.type === "Disclosure.Root")?.props).toEqual({});
    expect(elements(tally, "Accordion").map((element) => element.type)).toEqual(["Accordion.Panel", "Accordion.Control", "Accordion.Item", "Accordion", "Page"]);
    expect(elements(tally, "Accordion").find((element) => element.type === "Accordion")?.props.defaultValue).toBeUndefined();
  });

  it("draws a question with its label", () => {
    expect(elements(nook, "Field").map((element) => element.type)).toEqual(["Field.TextInput", "Field.Root", "Label.Root", "Page"]);
    expect(elements(tally, "TextInput").find((element) => element.type === "TextInput")?.props.label).toBe("Your answer");
  });

  it("draws a root around its members, each reading its own name", () => {
    expect(elements(nook, "Card").map((element) => [element.type, element.props.text])).toEqual([["Card.Header", "Header"], ["Card.Body", "Body"], ["Card.Footer", "Footer"], ["Card.Root", undefined], ["Page", undefined]]);
    expect(elements(nook, "Alert").map((element) => element.type)).toEqual(["Alert.Title", "Alert.Description", "Alert.Root", "Page"]);
  });

  it("draws a heading and a paragraph for the part that writes text", () => {
    expect(elements(nook, "Text").map((element) => element.props)).toEqual([{ as: "h1", text: "Heading" }, { as: "p", text: "Paragraph" }, {}]);
    expect(elements(tally, "Title").map((element) => element.props)).toEqual([{ order: 1, text: "Heading" }, {}]);
  });

  it("draws a layout part holding three of the library's own small parts, and names them", () => {
    const stack = partSpecimen(nook, "Stack");
    expect(stack.ok && stack.standIn).toBe("Badge.Root");
    expect(elements(nook, "Stack").map((element) => [element.type, element.props.text ?? element.children.length])).toEqual([["Badge.Root", "One"], ["Badge.Root", "Two"], ["Badge.Root", "Three"], ["Stack.Root", 3], ["Page", 0]]);
    // Tally carries only its inventoried components' parts: Mantine's Card stands in, with its border on.
    const mantine = partSpecimen(tally, "Stack");
    expect(mantine.ok && mantine.standIn).toBe("Card");
    expect(elements(tally, "Stack")[0]?.props).toEqual({ withBorder: true, text: "One" });
  });
});

describe("a component that cannot be drawn", () => {
  it("has no specimen, and says why", () => {
    expect(partSpecimen(nook, "Nope")).toEqual({ ok: false, component: "Nope", parts: 0, why: "@tounsoo/todae 0.11.3 has no part named Nope." });
    const { parts: _parts, ...library } = nook.library;
    expect(partSpecimen({ ...nook, library }, "Button")).toEqual({ ok: false, component: "Button", parts: 0, why: "The project carries no description of its library's parts, so none can be drawn." });
    const needy: ProjectConfig = { ...nook, library: { ...nook.library, parts: { "Chart.Root": { props: { data: { type: "unknown", required: true } }, content: "none", needs: ["data"] } } } };
    expect(partSpecimen(needy, "Chart")).toEqual({ ok: false, component: "Chart", parts: 1, why: 'Chart.Root needs "data", which a spec cannot give, so it cannot be drawn alone.' });
  });

  it("names a role no inventoried part carries", () => {
    const config: ProjectConfig = { ...nook, library: { ...nook.library, roles: { ...nook.library.roles, question: { components: [] } } }, inventories: { ...nook.inventories, components: nook.inventories.components.filter((name) => name !== "Disclosure") } };
    expect(unplacedRoles(config)).toEqual([
      { role: "disclosure", why: "Disclosure.Root has this role, and is not in the inventory." },
      { role: "disclosure-summary", why: "Disclosure.Summary has this role, and is not in the inventory." },
      { role: "question", why: "No part has this role." },
    ]);
  });
});
