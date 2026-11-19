import type { Literal } from "../rules/types";

/**
 * One step between an element of a spec layout and the page that draws it,
 * nearest first. Without `slot`: the element is in layout `layout`, whose
 * instance is at `file:line:column` (on a page, or in another layout). With
 * `slot`: the element was passed into slot `slot` of layout `layout`, and the
 * layout places it at `file:line:column`, the layout's own element.
 */
export type LayoutUse = { readonly layout: string; readonly file: string; readonly line: number; readonly column: number; readonly slot?: string };

/**
 * Where something is in the prototype's source. Line and column count from 1.
 * `via` is set on what a spec layout instance draws: where the layout is
 * used, so a finding points both at the layout's element and at the page's
 * use of it.
 */
export type SourceLocation = { readonly file: string; readonly line: number; readonly column: number; readonly via?: readonly LayoutUse[] };

/**
 * A prop as core reads it from a spec.
 * `literal`: written as one value.
 * `choice`: one of several literals, picked at runtime (a `$cond`, or a scenario's state).
 * `elements`: elements passed as a prop; those elements are also the node's children.
 * `dynamic`: anything core cannot reduce to literals, with the reason.
 */
export type PropValue =
  | { readonly kind: "literal"; readonly value: Literal }
  | { readonly kind: "choice"; readonly values: readonly Literal[] }
  | { readonly kind: "elements" }
  | { readonly kind: "dynamic"; readonly reason: string };

/**
 * `library`: a part of the project's component library, named as the library
 * exports it (`Button.Root`).
 * `kit`: the harness's own elements: a page's `Slot`, and a `Page` as written.
 * `component`: a page, or an instance of one of the prototype's layouts,
 * expanded: its children are what it draws.
 * `unresolved`: an element core cannot expand; `reason` says why (a layout
 * that draws itself).
 */
export type ElementKind = "library" | "kit" | "component" | "unresolved";

export type ElementNode = {
  readonly kind: ElementKind;
  readonly name: string;
  /** Where the element is written. */
  readonly at: SourceLocation;
  /** The element as written this node came from, `file#key`; every instance of one written element shares it. */
  readonly origin: string;
  readonly props: Readonly<Record<string, PropValue>>;
  /** The node's whole text, whitespace collapsed. */
  readonly text: string;
  /** True when part of the text is computed at runtime, so `text` is incomplete. */
  readonly textDynamic: boolean;
  /** Drawn only under a condition (`visible`). Rules still count it: they read the spec, not runtime state. */
  readonly conditional: boolean;
  /** Drawn once per item of a list whose length core cannot see, so it may appear any number of times. */
  readonly repeated: boolean;
  /** On a component node: the manifest page it is. */
  readonly page?: string;
  /** On a component node: the manifest layout it is an instance of. */
  readonly layout?: string;
  /** On an unresolved node: why it could not be named. */
  readonly reason?: string;
  /**
   * On an element of a spec page: its key in the expanded page, which a frame
   * draws it under (`details/summary` inside instance `details`); a page's
   * slot is `<page root>/slots/<name>`. Absent on a spec file's elements as
   * written.
   */
  readonly key?: string;
  readonly children: readonly ElementNode[];
};

export type PageModel = {
  readonly id: string;
  readonly pageType: string;
  /** The page component's node; its children are what the page renders. */
  readonly root: ElementNode;
};

/** Something core could not read, which leaves the prototype unchecked in part: the always-on `extract` rule reports it. */
export type ExtractionProblem = { readonly message: string; readonly at?: SourceLocation };

export type PrototypeModel = {
  /** Every manifest page that resolved, by id. */
  readonly pages: readonly PageModel[];
  /** Every element written in the prototype's spec files, as written: nesting is the file's, and layout instances are not expanded. */
  readonly source: readonly ElementNode[];
  readonly problems: readonly ExtractionProblem[];
};
