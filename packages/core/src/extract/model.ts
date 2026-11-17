import type { Literal } from "../rules/types";

/** Where something is in the prototype's source. Line and column count from 1. */
export type SourceLocation = { readonly file: string; readonly line: number; readonly column: number };

/**
 * A prop as the extractor sees it.
 * `literal`: written as one value.
 * `choice`: one of several literals, picked at runtime (`urgent ? "primary" : "secondary"`).
 * `elements`: JSX passed as a prop; those elements are also the node's children.
 * `dynamic`: anything the extractor cannot reduce to literals, with the reason.
 */
export type PropValue =
  | { readonly kind: "literal"; readonly value: Literal }
  | { readonly kind: "choice"; readonly values: readonly Literal[] }
  | { readonly kind: "elements" }
  | { readonly kind: "dynamic"; readonly reason: string };

/**
 * `library`: a part of the project's component library, named as the library
 * exports it (`Button.Root`), whatever alias or namespace the source used.
 * `intrinsic`: an HTML element (`button`).
 * `kit`: the harness's page kit (`Slot`).
 * `component`: one of the prototype's own components, expanded: its children
 * are what it renders.
 * `unresolved`: an element the extractor cannot name statically; `reason` says why.
 */
export type ElementKind = "library" | "intrinsic" | "kit" | "component" | "unresolved";

export type ElementNode = {
  readonly kind: ElementKind;
  readonly name: string;
  /** Where the JSX was written. */
  readonly at: SourceLocation;
  /** The JSX expression this node came from, `file:offset`; every instance of one JSX expression shares it. */
  readonly origin: string;
  readonly props: Readonly<Record<string, PropValue>>;
  /** Set when a spread the extractor cannot see through may set props not listed in `props`. */
  readonly openProps?: string;
  /** The node's whole text, whitespace collapsed. */
  readonly text: string;
  /** True when part of the text is computed at runtime, so `text` is incomplete. */
  readonly textDynamic: boolean;
  /** Rendered only under a condition (`&&`, `?:`, an early return). Rules still count it: they read code, not runtime state. */
  readonly conditional: boolean;
  /** Rendered once per item of a list whose length the extractor cannot see, so it may appear any number of times. */
  readonly repeated: boolean;
  /** On a component node: the manifest page this component is. */
  readonly page?: string;
  /** On a component node: the manifest layout this component is. */
  readonly layout?: string;
  /** On an unresolved node: why it could not be named. */
  readonly reason?: string;
  readonly children: readonly ElementNode[];
};

export type PageModel = {
  readonly id: string;
  readonly pageType: string;
  /** The page component's node; its children are what the page renders. */
  readonly root: ElementNode;
};

/** Something the extractor could not do, which leaves the prototype unchecked in part. */
export type ExtractionProblem = { readonly message: string; readonly at?: SourceLocation };

/** A module specifier a file loads, for the imports membership rule. */
export type ModuleLoad = {
  readonly at: SourceLocation;
  /** The specifier, or null when it is computed. */
  readonly specifier: string | null;
  readonly how: "import" | "export-from" | "dynamic-import" | "require";
  /** True when `require` itself is stored or passed, so every later call goes through another name. */
  readonly held?: true;
  /** Names imported from it, as the module exports them: `default`, `*`, or a name. */
  readonly names: readonly string[];
};

/**
 * Something prototype code reaches beyond its imports and plain language
 * built-ins, found by reading the source: a global, a property name that
 * leads to the frame's window, document or a constructor, a property read by
 * a computed key, a write to a property, a DOM handle, or `import.meta`.
 * `reason` says why it is refused.
 */
export type AmbientUse = {
  readonly kind: "global" | "member" | "computed" | "write" | "dom" | "meta";
  readonly name: string;
  readonly reason: string;
  readonly at: SourceLocation;
};

export type PrototypeModel = {
  /** Every manifest page that resolved, by id. */
  readonly pages: readonly PageModel[];
  /** Every JSX element written in the prototype's files, as written: nesting is the source's, and local components are not expanded. */
  readonly source: readonly ElementNode[];
  readonly loads: readonly ModuleLoad[];
  /** Every use of something beyond the prototype's imports, in every file. */
  readonly ambient: readonly AmbientUse[];
  readonly problems: readonly ExtractionProblem[];
};
