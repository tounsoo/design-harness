/**
 * A prototype, as plain JSON: its spec files and a manifest saying what the
 * files are. The flow is data, not reducer code, so the step budget is a
 * graph search over it rather than a run of the prototype.
 */

/** A page or layout's file, and the name it is exported by: always `default` for a spec, and a component's export in code export's TSX. */
export type ComponentRef = { readonly file: string; readonly export: string };

/** A page: a file that draws one page of the given page type. */
export type PageEntry = { readonly id: string; readonly pageType: string; readonly component: ComponentRef };

/** A layout: a file that composes a page's body, registered by its inventory id. */
export type LayoutEntry = { readonly id: string; readonly component: ComponentRef };

/** A named case a page renders: one flow state, on one page. */
export type Scenario = { readonly id: string; readonly state: string; readonly page: string };

export type Transition = { readonly from: string; readonly event: string; readonly to: string };

/** The transitions a person can take while doing one task, from where the task starts. */
export type TaskFlow = { readonly task: string; readonly start: string; readonly transitions: readonly Transition[] };

export type Flow = { readonly states: readonly string[]; readonly tasks: readonly TaskFlow[] };

/** What every prototype shares: its files, its manifest, its scenarios and its flow. */
type Manifested<Format extends string> = {
  readonly format: Format;
  /** Path → text. Paths are relative to the prototype root, with forward slashes and no leading `./`. */
  readonly files: Readonly<Record<string, string>>;
  readonly pages: readonly PageEntry[];
  readonly layouts: readonly LayoutEntry[];
  readonly scenarios: readonly Scenario[];
  readonly flow: Flow;
};

/**
 * A prototype core checks: each page and layout a json-render spec in a JSON
 * file, so no prototype code runs (packages/core/src/spec/). It is the only
 * format core reads.
 */
export type Prototype = Manifested<"spec">;

/**
 * A prototype written as TSX: each page and layout a React component in a
 * `.tsx` file. Core no longer reads one: it cannot be checked or rendered.
 * Code export writes one from a spec (`specToTsx`), and `parsePrototype`
 * hands back a stored one, refused, so its files can still be shown and
 * exported as they are.
 */
export type TsxPrototype = Manifested<"tsx">;
