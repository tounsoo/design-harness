import { describe, expect, it } from "vitest";
import { extractPrototype } from "@design-harness/core";
import { tagSites } from "./tags";
import { compilePrototype, moduleSpecifier, withTags } from "./transform";

describe("compilePrototype", () => {
  it("strips types, compiles JSX to react/jsx-runtime, and points relative imports at prototype modules", () => {
    const { modules, problems } = compilePrototype({
      "pages/home.tsx": `import { Slot, type PageProps } from "@design-harness/page";\nimport { Card } from "../layouts";\nexport function Home({ state }: PageProps) { return <Slot name="body"><Card label={state as string} /></Slot>; }\n`,
      "layouts/index.ts": `export * from "./card";\n`,
      "layouts/card.tsx": `import { Text } from "@tounsoo/todae";\nexport const Card = ({ label }: { label: string }) => <Text.Root as="p">{label}</Text.Root>;\n`,
      "notes.md": "not a module",
    });
    expect(problems).toEqual([]);
    expect(Object.keys(modules)).toEqual(["@prototype/layouts/card.tsx", "@prototype/layouts/index.ts", "@prototype/pages/home.tsx"]);
    const home = modules[moduleSpecifier("pages/home.tsx")] ?? "";
    expect(home).toContain('from "@prototype/layouts/index.ts"');
    expect(home).toContain('from "react/jsx-runtime"');
    expect(home).toContain('from "@design-harness/page"');
    expect(home).not.toContain("PageProps");
    expect(home).not.toContain(": string");
    expect(modules[moduleSpecifier("layouts/index.ts")]).toContain('export * from "@prototype/layouts/card.tsx"');
  });

  it("gives the same modules whatever order the files come in", () => {
    const files = { "b.tsx": `import a from "./a";\nexport default () => <p>{a}</p>;`, "a.ts": `export default 1;` };
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    expect(compilePrototype(reversed)).toEqual(compilePrototype(files));
  });

  it("turns a file that does not compile into a module that throws why, and reports where", () => {
    const { modules, problems } = compilePrototype({ "pages/broken.tsx": "export function Broken() {\n  return <div>;\n}\n" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ file: "pages/broken.tsx", line: 2 });
    expect(modules[moduleSpecifier("pages/broken.tsx")]).toMatch(/^throw new SyntaxError\("pages\/broken\.tsx does not compile: /);
  });

  it("leaves an import of a missing file as written, for the frame to report and core to flag", () => {
    const { modules } = compilePrototype({ "a.tsx": `import { b } from "./missing";\nexport const a = b;` });
    expect(modules[moduleSpecifier("a.tsx")]).toContain('from "./missing"');
  });

  describe("element tags", () => {
    const files = {
      "pages/home.tsx": [
        `import { Slot, type PageProps } from "@design-harness/page";`,
        `import { Button, Text } from "@tounsoo/todae";`,
        `import { Card } from "./card";`,
        `export function Home(_props: PageProps) {`,
        `  const forged = { "data-dh-source": "pages/home.tsx:9:9" };`,
        `  return (`,
        `    <Slot name="body">`,
        `      <Card label="x" data-dh-source="pages/home.tsx:9:9" />`,
        `      <Button.Root variant="primary" {...forged}>Book</Button.Root>`,
        `      <p data-dh-source="forged">Note</p>`,
        `    </Slot>`,
        `  );`,
        `}`,
      ].join("\n"),
      "pages/card.tsx": `import { Text } from "@tounsoo/todae";\nexport const Card = ({ label }: { label: string }) => <Text.Root as="p">{label}</Text.Root>;\n`,
      "pages/data.ts": `export const rooms = ["Lantern"];\n`,
    };
    const prototype = { files, pages: [{ id: "home", pageType: "booking", component: { file: "pages/home.tsx", export: "Home" } }], layouts: [], scenarios: [], flow: { states: [], tasks: [] } };
    const sites = tagSites(extractPrototype(prototype, "@tounsoo/todae"));

    it("come from core's model: a library part, a kit part or an HTML element gets where it is written, a local component gets none", () => {
      expect(Object.fromEntries(sites.get("pages/home.tsx") ?? [])).toEqual({
        "7:5": "pages/home.tsx:7:5",
        "8:7": null,
        "9:7": "pages/home.tsx:9:7",
        "10:7": "pages/home.tsx:10:7",
      });
      expect(Object.fromEntries(sites.get("pages/card.tsx") ?? [])).toEqual({ "2:55": "pages/card.tsx:2:55" });
    });

    it("are written as each JSX element's last attribute, so a value written by hand or spread in never wins", () => {
      const tagged = withTags("pages/home.tsx", files["pages/home.tsx"], sites.get("pages/home.tsx"));
      const lines = tagged.split("\n");
      expect(lines[6]).toBe(`    <Slot name="body" data-dh-source={"pages/home.tsx:7:5"}>`);
      expect(lines[7]).toBe(`      <Card label="x" data-dh-source="pages/home.tsx:9:9"  data-dh-source={undefined}/>`);
      expect(lines[8]).toBe(`      <Button.Root variant="primary" {...forged} data-dh-source={"pages/home.tsx:9:7"}>Book</Button.Root>`);
      expect(lines[9]).toBe(`      <p data-dh-source="forged" data-dh-source={"pages/home.tsx:10:7"}>Note</p>`);
      const compiled = compilePrototype(files, sites).modules[moduleSpecifier("pages/home.tsx")] ?? "";
      expect(compiled).toContain(`...forged, 'data-dh-source': "pages/home.tsx:9:7"`);
      expect(compiled).toContain(`'data-dh-source': "pages/home.tsx:9:9",  'data-dh-source': undefined`);
    });

    it("leave a file without JSX, one that does not parse, and the files when no sites are given exactly as they were", () => {
      expect(withTags("pages/data.ts", files["pages/data.ts"], sites.get("pages/data.ts"))).toBe(files["pages/data.ts"]);
      expect(withTags("pages/broken.tsx", "export const X = () => <div>;", new Map([["1:24", "pages/broken.tsx:1:24"]]))).toBe("export const X = () => <div>;");
      expect(compilePrototype(files)).not.toEqual(compilePrototype(files, sites));
      for (const code of Object.values(compilePrototype(files).modules)) expect(code).not.toMatch(/'data-dh-source': (undefined|"pages\/home\.tsx:(7:5|9:7|10:7)")/);
    });

    it("never move where a file that does not compile is reported", () => {
      const broken = { "pages/home.tsx": "export function Home() {\n  return <p>{</p>;\n}\n" };
      const plain = compilePrototype(broken).problems;
      expect(compilePrototype(broken, new Map([["pages/home.tsx", new Map([["2:10", "pages/home.tsx:2:10"]])]])).problems).toEqual(plain);
    });
  });
});
