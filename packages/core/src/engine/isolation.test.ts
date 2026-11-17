import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nook } from "../../examples/nook/project";
import { EXAMPLES, loadPrototype } from "../../test/fixtures";
import { HEADER, check, messages } from "../../test/helpers";
import type { RuleSpec } from "../rules/types";
import { checkPrototype } from "./check";

const rule: RuleSpec = { type: "isolation", id: "isolation" };
const legal = loadPrototype(join(EXAMPLES, "legal", "booking"));

/** The isolation rule's messages for a home page with `extra` above it and `body` inside it. */
function scan(extra: string, body = `<Text.Root as="p">Hi</Text.Root>`): string[] {
  return messages(check([rule], { "pages/home.tsx": `${HEADER}${extra}\nexport function Home() {\n  return <Slot name="body">${body}</Slot>;\n}\n` }));
}

describe("the isolation rule", () => {
  it("passes the legal Nook prototype: its imports, React and plain built-ins only", () => {
    const report = checkPrototype({ config: nook, prototype: legal });
    expect(report.rules.find((item) => item.rule === "no-ambient-globals")).toMatchObject({ status: "pass", findings: [] });
  });

  it("reads a destructured key as a property read, so a prop named parent or target is refused like event.target", () => {
    expect(scan(`export const pick = ({ parent }: { parent: string }) => parent;`)).toEqual([expect.stringContaining("pages/home.tsx:3:24 reads .parent")]);
  });

  it("allows bound names that shadow globals, plain built-ins, and type-only references", () => {
    expect(
      scan(`type Props = { readonly window: Window; readonly document: Document };
const document = { title: "Rooms" };
function label(window: number, { side }: { side: string }) { return \`\${window} \${side}\`; }
const total = Math.max(1, Number("2")) + JSON.parse("3") + Object.keys({ a: 1 }).length;
const copy = Object.assign({}, { a: 1 });
const when = new Date(0).toISOString() + String(new Map([[1, 2]]).size) + [1, 2].map(String).join();
for (const item of [1, 2]) console.log(item, typeof item);
try { JSON.parse("{"); } catch (error) { console.log(error); }
export const used = [document.title, label(1, { side: "a" }), total, copy, when] as unknown as Props;`),
    ).toEqual([]);
  });

  it("refuses the frame's globals, timers, code from strings and any name it does not know", () => {
    const found = scan(`const a = window.parent;
const b = globalThis;
const c = self;
const d = top;
setTimeout(() => 0, 10);
const e = eval("1");
const f = new Function("return 1");
const g = typeof document;
const h = postMessage;
const i = somethingUnknown;`);
    expect(found.map((message) => message.replace(/ at .*$/, ""))).toEqual([
      "violation: pages/home.tsx:3:11 uses window, which is the frame's window or document. Prototype code uses only its imports and plain language built-ins.",
      "violation: pages/home.tsx:3:18 reads .parent, which is the frame's window or document. Prototype code may not reach the frame it is measured in.",
      "violation: pages/home.tsx:4:11 uses globalThis, which is the frame's window or document. Prototype code uses only its imports and plain language built-ins.",
      "violation: pages/home.tsx:5:11 uses self, which is the frame's window or document. Prototype code uses only its imports and plain language built-ins.",
      "violation: pages/home.tsx:6:11 uses top, which is the frame's window or document. Prototype code uses only its imports and plain language built-ins.",
      "violation: pages/home.tsx:7:1 uses setTimeout, which is a browser global. Prototype code uses only its imports and plain language built-ins.",
      "violation: pages/home.tsx:8:11 uses eval, which is a browser global. Prototype code uses only its imports and plain language built-ins.",
      "violation: pages/home.tsx:9:15 uses Function, which is a browser global. Prototype code uses only its imports and plain language built-ins.",
      "violation: pages/home.tsx:10:18 uses document, which is the frame's window or document. Prototype code uses only its imports and plain language built-ins.",
      "violation: pages/home.tsx:11:11 uses postMessage, which is the frame's message plumbing. Prototype code uses only its imports and plain language built-ins.",
      "violation: pages/home.tsx:12:11 uses somethingUnknown, which is not a plain language built-in. Prototype code uses only its imports and plain language built-ins.",
    ]);
  });

  it("refuses paths from a value to a constructor, and from an event or a node to the window", () => {
    const found = scan(
      `const run = (() => 0).constructor;
const proto = [].__proto__;
const pick = (event: { target: unknown }) => event.target;
const { view } = { view: 1 };`,
      `<Button.Root onClick={(event) => event.nativeEvent} variant="secondary">Hold room</Button.Root>`,
    );
    expect(found.map((message) => message.split(",")[0])).toEqual([
      "violation: pages/home.tsx:3:23 reads .constructor",
      "violation: pages/home.tsx:4:18 reads .__proto__",
      "violation: pages/home.tsx:5:52 reads .target",
      "violation: pages/home.tsx:6:9 reads .view",
      "violation: pages/home.tsx:8:67 reads .nativeEvent",
    ]);
  });

  it("cannot clear a property read by a computed key, so the rule fails with an unverifiable finding", () => {
    const found = scan(`const rooms = [{ name: "Lantern" }];\nconst key = "con" + "structor";\nconst sneaky = rooms[key];\nconst { [key]: also } = rooms;\nconst fine = rooms[0]?.name + rooms["length"];`);
    expect(found).toEqual([
      "unverifiable: Cannot tell what pages/home.tsx:5:22 reaches: it reads a property whose key is computed at run time. Read properties by name, or keep the records in an array and use .find.",
      "unverifiable: Cannot tell what pages/home.tsx:6:10 reaches: it destructures a property whose key is computed at run time. Read properties by name, or keep the records in an array and use .find.",
    ]);
  });

  it("refuses writes to properties, which is how a built-in the measuring code calls would be changed", () => {
    const found = scan(`const m = Math;\nm.round = () => 0;\nObject.assign(Math, { max: () => 0 });\ndelete m.min;\nconst list = { size: 1 };\nlist.size += 1;`);
    expect(found.map((message) => message.split(".")[0])).toEqual([
      "violation: pages/home",
      "violation: pages/home",
      "violation: pages/home",
      "violation: pages/home",
    ]);
    expect(found.map((message) => message.slice(0, message.indexOf(" Prototype")))).toEqual([
      "violation: pages/home.tsx:4:1 assigns to a property.",
      "violation: pages/home.tsx:5:1 writes into an object other than a new literal; pass {} first.",
      "violation: pages/home.tsx:6:1 deletes a property.",
      "violation: pages/home.tsx:8:1 assigns to a property.",
    ]);
  });

  it("lets Object and JSON be called only through members that cannot enumerate an event's values", () => {
    const found = scan(`const O = Object;\nconst values = Object.values({ a: 1 });\nconst text = JSON.stringify({ a: 1 }, (key, value) => value);\nconst plain = JSON.stringify({ a: 1 }, null, 2);`);
    expect(found.map((message) => message.slice(0, message.indexOf(", since") === -1 ? message.indexOf(". Prototype") : message.indexOf(", since")))).toEqual([
      "violation: pages/home.tsx:3:11 uses Object, which may only be called as Object.assign, Object.freeze, Object.fromEntries, Object.hasOwn, Object.is, Object.isFrozen, Object.keys",
      "violation: pages/home.tsx:4:16 uses Object, which may only be called as Object.assign, Object.freeze, Object.fromEntries, Object.hasOwn, Object.is, Object.isFrozen, Object.keys",
      "violation: pages/home.tsx:5:14 uses JSON.stringify, which calls a replacer with every value it serialises; pass null as the second argument",
    ]);
  });

  it("refuses DOM handles and elements that run code: ref, useRef, dangerouslySetInnerHTML, <iframe>, <script>, and import.meta", () => {
    const found = messages(
      check([rule], {
        "pages/home.tsx": `import { useRef } from "react";\nimport * as React from "react";\n${HEADER}const url = import.meta.url;\nexport function Home() {\n  const box = React.createRef();\n  return <Slot name="body"><Text.Root as="p" ref={useRef(null)}>Hi</Text.Root><div dangerouslySetInnerHTML={{ __html: "" }} /><iframe /><script /></Slot>;\n}\n`,
      }),
    );
    expect(found.map((message) => message.slice(0, message.indexOf(", which")))).toEqual([
      "violation: pages/home.tsx:1:10 uses useRef",
      "violation: pages/home.tsx:5:13 uses import.meta",
      "violation: pages/home.tsx:7:21 reads .createRef",
      "violation: pages/home.tsx:8:46 uses ref",
      "violation: pages/home.tsx:8:84 uses dangerouslySetInnerHTML",
      "violation: pages/home.tsx:8:128 uses <iframe>",
      "violation: pages/home.tsx:8:138 uses <script>",
    ]);
  });

  it("checks every file, rendered or not, and leaves require to the imports rule", () => {
    const report = check([rule], { "pages/home.tsx": `${HEADER}export function Home() { return <Slot name="body" />; }\n`, "data/unused.ts": `export const leak = () => window;\nexport const load = () => require("x");\n` });
    expect(messages(report)).toEqual([expect.stringMatching(/^violation: data\/unused\.ts:1:27 uses window/)]);
  });

  it("gives the same findings whatever order the files come in", () => {
    const files = { "a.ts": "export const a = window;", "b.ts": "export const b = document;", "pages/home.tsx": `${HEADER}export function Home() { return <Slot name="body" />; }\n` };
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    expect(check([rule], reversed)).toEqual(check([rule], files));
  });
});
