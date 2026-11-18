import { describe, expect, it } from "vitest";
import { compilePrototype, moduleSpecifier } from "./transform";

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
});
