/**
 * A prototype, as plain JSON: its source files and a manifest saying what the
 * files are. The flow is data, not reducer code, so the step budget is a
 * graph search over it rather than a run of the prototype.
 */

/** A component exported from one of the prototype's files: a named export, or `default`. */
export type ComponentRef = { readonly file: string; readonly export: string };

/** A page: a component that renders one page of the given page type. */
export type PageEntry = { readonly id: string; readonly pageType: string; readonly component: ComponentRef };

/** A layout: a component that composes a page's body, registered by its inventory id. */
export type LayoutEntry = { readonly id: string; readonly component: ComponentRef };

/** A named case a page renders: one flow state, on one page. */
export type Scenario = { readonly id: string; readonly state: string; readonly page: string };

export type Transition = { readonly from: string; readonly event: string; readonly to: string };

/** The transitions a person can take while doing one task, from where the task starts. */
export type TaskFlow = { readonly task: string; readonly start: string; readonly transitions: readonly Transition[] };

export type Flow = { readonly states: readonly string[]; readonly tasks: readonly TaskFlow[] };

export type Prototype = {
  /**
   * `tsx` (the default when absent): each page is a component in a TSX file.
   * `spec`: each page and layout is a json-render spec in a JSON file, and
   * no prototype code runs (packages/core/src/spec/).
   */
  readonly format?: "tsx" | "spec";
  /** Path → source: TSX for a `tsx` prototype, a JSON spec for a `spec` one. Paths are relative to the prototype root, with forward slashes and no leading `./`. */
  readonly files: Readonly<Record<string, string>>;
  readonly pages: readonly PageEntry[];
  readonly layouts: readonly LayoutEntry[];
  readonly scenarios: readonly Scenario[];
  readonly flow: Flow;
};
