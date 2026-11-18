import { describe, expect, it } from "vitest";
import { BUILT_IN_RULES } from "../builtins";
import { HEADER, check, flat, homeTree, messages, named, prototype } from "../../test/helpers";
import { extractPrototype } from "./index";

const page = (body: string, extra = "") => ({ "pages/home.tsx": `${HEADER}${extra}\nexport function Home() {\n  return (\n    <>\n${body}\n    </>\n  );\n}\n` });

describe("the extractor resolves", () => {
  it("import aliases, namespace imports and parts held in constants to the library's own names", () => {
    const tree = homeTree({
      "pages/home.tsx": `import { Button as B } from "@tounsoo/todae";
import * as UI from "@tounsoo/todae";
const Strong = UI.Button.Root;
const { Root: Plain } = B;
export function Home() { return <><B.Root>One</B.Root><UI.Button.Root>Two</UI.Button.Root><Strong>Three</Strong><Plain>Four</Plain></>; }`,
    });
    expect(named(tree, "Button.Root").map((node) => node.text)).toEqual(["One", "Two", "Three", "Four"]);
  });

  it("default exports, renamed re-exports, export * and export * as, across files", () => {
    const tree = homeTree({
      "pages/home.tsx": `import Card from "../parts/card";
import { Go, Parts } from "../parts";
import * as All from "../parts";
export function Home() { return <><Card /><Go /><Parts.Card /><All.Stop /></>; }`,
      "parts/card.tsx": `import { Text } from "@tounsoo/todae";\nfunction Card() { return <Text.Root as="p">Card</Text.Root>; }\nexport { Card as default };`,
      "parts/go.tsx": `import { Button } from "@tounsoo/todae";\nexport const GoButton = () => <Button.Root variant="primary">Go</Button.Root>;\nexport default function Stop() { return <Button.Root variant="secondary">Stop</Button.Root>; }`,
      "parts/stop.ts": `export { default as Stop } from "./go";`,
      "parts/index.ts": `export { GoButton as Go } from "./go";\nexport * from "./stop";\nexport * as Parts from "./parts";`,
      "parts/parts.ts": `export { default as Card } from "./card";`,
    });
    expect(named(tree, "Text.Root").map((node) => node.text)).toEqual(["Card", "Card"]);
    expect(named(tree, "Button.Root").map((node) => [node.text, node.props.variant])).toEqual([
      ["Go", { kind: "literal", value: "primary" }],
      ["Stop", { kind: "literal", value: "secondary" }],
    ]);
  });

  it("props passed to local components: destructured, defaulted, read from props, spread on, and children", () => {
    const tree = homeTree(
      page(
        `      <Action label="Book room" />
      <Action label="Hold room" variant="secondary" />
      <Wrap tone="quiet"><Text.Root as="p">Inside</Text.Root></Wrap>
      <Forward variant="secondary">Forwarded</Forward>`,
        `const Action = ({ label, variant = "primary" }) => <Button.Root variant={variant}>{label}</Button.Root>;
function Wrap(props) { return <Disclosure.Root data-tone={props.tone}>{props.children}</Disclosure.Root>; }
function Forward({ children, ...rest }) { return <Button.Root {...rest}>{children}</Button.Root>; }`,
      ),
    );
    const buttons = named(tree, "Button.Root").map((node) => [node.text, node.props.variant, node.openProps]);
    expect(buttons).toEqual([
      ["Book room", { kind: "literal", value: "primary" }, undefined],
      ["Hold room", { kind: "literal", value: "secondary" }, undefined],
      ["Forwarded", { kind: "literal", value: "secondary" }, undefined],
    ]);
    const disclosure = named(tree, "Disclosure.Root")[0];
    expect(disclosure?.props["data-tone"]).toEqual({ kind: "literal", value: "quiet" });
    expect(disclosure?.children.map((node) => node.name)).toEqual(["Text.Root"]);
  });

  it("JSX hoisted into constants, helper functions, memo and forwardRef, and early returns", () => {
    const tree = homeTree(
      page(
        `      {book}
      {renderHold("Hold room")}
      <Memo />
      <Ref />
      <Either />`,
        `import { forwardRef, memo } from "react";
const book = <Button.Root variant="primary">Book room</Button.Root>;
function renderHold(label) { return <Button.Root variant="secondary">{label}</Button.Root>; }
const Memo = memo(function Inner() { return <Text.Root as="p">memo</Text.Root>; });
const Ref = forwardRef((props, ref) => <Text.Root as="p">ref</Text.Root>);
function Either({ busy }) { if (busy) return <Text.Root as="p">busy</Text.Root>; return <Text.Root as="p">idle</Text.Root>; }`,
      ),
    );
    expect(named(tree, "Button.Root").map((node) => node.text)).toEqual(["Book room", "Hold room"]);
    const texts = named(tree, "Text.Root");
    expect(texts.map((node) => [node.text, node.conditional])).toEqual([
      ["memo", false],
      ["ref", false],
      ["busy", true],
      ["idle", true],
    ]);
  });

  it("maps over a list written in the source exactly, and over any other list as repeated", () => {
    const tree = homeTree(
      page(
        `      {rooms.map((room) => <Text.Root as="h2" key={room}>{room}</Text.Root>)}
      {fetched.map((room) => <Button.Root variant="secondary">Open</Button.Root>)}`,
        `const rooms = ["Lantern", "Harbor"];\nconst fetched = useRooms();`,
      ),
    );
    expect(named(tree, "Text.Root").map((node) => [node.text, node.repeated])).toEqual([
      ["Lantern", false],
      ["Harbor", false],
    ]);
    expect(named(tree, "Button.Root").map((node) => node.repeated)).toEqual([true]);
  });

  it("conditions and ternaries render every branch, marked conditional, and a ternary of literals as a choice", () => {
    const tree = homeTree(page(`      {open && <Text.Root as="p">Open</Text.Root>}\n      <Button.Root variant={urgent ? "primary" : "secondary"}>Pay</Button.Root>`, `const open = useOpen();\nconst urgent = useUrgent();`));
    expect(named(tree, "Text.Root")[0]?.conditional).toBe(true);
    expect(named(tree, "Button.Root")[0]?.props.variant).toEqual({ kind: "choice", values: ["primary", "secondary"] });
  });

  it("JSX passed in a library part's props, and a render prop the part calls, as children of that part", () => {
    const tree = homeTree(page(`      <Field.Root label={<Text.Root as="span">Name</Text.Root>} renderHint={() => <Text.Root as="span">Hint</Text.Root>} onChange={() => <Text.Root as="span">Never</Text.Root>} />`));
    const field = named(tree, "Field.Root")[0];
    expect(field?.children.map((node) => [node.text, node.repeated])).toEqual([
      ["Name", false],
      ["Hint", true],
    ]);
  });

  it("marks the manifest's pages and layouts on the components that are them", () => {
    const tree = homeTree(
      { "pages/home.tsx": `import { Details } from "../layouts/details";\nexport function Home() { return <Details />; }`, "layouts/details.tsx": `export const Details = () => null;` },
      { layouts: [{ id: "details", component: { file: "layouts/details.tsx", export: "Details" } }] },
    );
    expect(tree.page).toBe("home");
    expect(named(tree, "Details")[0]?.layout).toBe("details");
  });
});

describe("the extractor fails closed", () => {
  it("on a prop it cannot reduce to literals", () => {
    const tree = homeTree(page(`      <Button.Root variant={tone}>Pay</Button.Root>`, `const tone = pickTone();`));
    expect(named(tree, "Button.Root")[0]?.props.variant).toEqual({ kind: "dynamic", reason: "computed from `tone`" });
  });

  it("on a spread it cannot see through: earlier props may be overridden and any prop may be set", () => {
    const tree = homeTree(page(`      <Button.Root variant="secondary" {...extra}>Pay</Button.Root>`, `const extra = getProps();`));
    const button = named(tree, "Button.Root")[0];
    expect(button?.openProps).toContain("may set any prop");
    expect(button?.props.variant?.kind).toBe("dynamic");
  });

  it("on a tag it cannot name, a function it cannot see, a class, a lazy component and recursion", () => {
    const tree = homeTree(
      page(
        `      <props.as />
      {renderSomething()}
      <Old />
      <Lazy />
      <Tree />`,
        `import { lazy } from "react";
const props = useProps();
class Old { render() { return null; } }
const Lazy = lazy(() => import("./other"));
function Tree() { return <Tree />; }`,
      ),
    );
    const unresolved = flat(tree).filter((node) => node.kind === "unresolved").map((node) => node.reason);
    expect(unresolved).toEqual([
      expect.stringContaining("useProps()"),
      expect.stringContaining("calls a function the extractor cannot see"),
      expect.stringContaining("class component"),
      expect.stringContaining("React.lazy"),
      expect.stringContaining("renders itself"),
    ]);
  });

  it("on text computed at runtime", () => {
    const tree = homeTree(page(`      <Button.Root variant="primary">{label}</Button.Root>`, `const label = t("book");`));
    expect(named(tree, "Button.Root")[0]).toMatchObject({ textDynamic: true });
  });

  it("on a file that does not parse, a missing file or export, and createElement", () => {
    const model = extractPrototype(
      prototype(
        {
          "pages/home.tsx": `import { createElement } from "react";\nexport const Home = () => createElement("div");`,
          "pages/broken.tsx": `export const Broken = () => <div>;`,
        },
        {
          pages: [
            { id: "home", pageType: "booking", component: { file: "pages/home.tsx", export: "Home" } },
            { id: "gone", pageType: "booking", component: { file: "pages/gone.tsx", export: "Gone" } },
            { id: "nameless", pageType: "booking", component: { file: "pages/home.tsx", export: "Nope" } },
          ],
        },
      ),
      "@tounsoo/todae",
    );
    expect(model.problems.map((problem) => problem.message)).toEqual([
      expect.stringContaining("pages/broken.tsx does not parse"),
      expect.stringContaining("pages/gone.tsx, which is not a file in the prototype"),
      expect.stringContaining(`export "Nope" of pages/home.tsx, which has no such export`),
      expect.stringContaining("createElement builds an element without JSX"),
    ]);
    const home = model.pages.find((item) => item.id === "home");
    expect(home && flat(home.root).some((node) => node.kind === "unresolved")).toBe(true);
  });

  it("records every module a file loads, static or not", () => {
    const model = extractPrototype(
      prototype({
        "pages/home.tsx": `import { Button } from "@tounsoo/todae";
import type { Room } from "./types";
export { Text } from "@tounsoo/todae";
const load = require;
export const Home = () => { import("./lazy"); require("left-pad"); return null; };`,
      }),
      "@tounsoo/todae",
    );
    expect(model.loads.map((load) => [load.how, load.specifier, load.held ?? false])).toEqual([
      ["import", "@tounsoo/todae", false],
      ["export-from", "@tounsoo/todae", false],
      ["require", null, true],
      ["dynamic-import", "./lazy", false],
      ["require", "left-pad", false],
    ]);
  });
});

describe("a page that reads its scenario", () => {
  // The page kit renders each manifest page as <Page scenario="..." state="..." />.
  const statePage = (body: string) => ({
    "pages/home.tsx": `import { Slot, type PageProps } from "@design-harness/page";\nimport { Button, Text } from "@tounsoo/todae";\nexport function Home({ scenario, state }: PageProps) {\n  return (\n    <>\n${body}\n    </>\n  );\n}\n`,
  });

  it("keeps what each state shows, marked conditional, since the extractor reads code, not one scenario", () => {
    const tree = homeTree(statePage(`      <Slot name="facts">{state === "booked" && <Text.Root as="p">Booked</Text.Root>}<Text.Root as="p">{scenario}</Text.Root></Slot>`));
    const texts = named(tree, "Text.Root").map((node) => [node.text, node.conditional, node.textDynamic]);
    expect(texts).toEqual([
      ["Booked", true, false],
      ["", false, true],
    ]);
  });

  it("counts a primary action shown in only one state against the page, as every other condition is", () => {
    const report = check(BUILT_IN_RULES.filter((rule) => rule.id === "one-primary-per-page"), statePage(`      <Slot name="action">{state === "held" ? <Button.Root>Book room</Button.Root> : <Button.Root>Hold room</Button.Root>}</Slot>`));
    expect(messages(report)).toEqual([expect.stringMatching(/^violation: Page "home" has 2 primary actions, more than 1/)]);
  });

  it("cannot tell a role picked by state, so the rule says so instead of passing", () => {
    const report = check(BUILT_IN_RULES.filter((rule) => rule.id === "one-primary-per-page"), statePage(`      <Slot name="action"><Button.Root variant={state === "held" ? "primary" : "secondary"}>Book room</Button.Root><Button.Root>Hold room</Button.Root></Slot>`));
    expect(report.rules.find((rule) => rule.rule === "one-primary-per-page")?.status).toBe("fail");
    expect(messages(report).join("\n")).toContain("unverifiable");
  });

  it("imports the PageProps type from the page kit without breaking the imports rule", () => {
    const report = check(BUILT_IN_RULES.filter((rule) => rule.id === "imports-from-library"), {
      "pages/home.tsx": `import { Slot, PageProps } from "@design-harness/page";\nimport { Text } from "@tounsoo/todae";\nexport function Home(props: PageProps) { return <Slot name="title"><Text.Root as="h1">{props.state}</Text.Root></Slot>; }`,
    });
    expect(messages(report)).toEqual([]);
  });
});

