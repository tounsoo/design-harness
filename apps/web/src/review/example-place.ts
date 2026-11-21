import type { Prototype } from "@design-harness/core";

/** Where an example screen is drawn: a scenario of the example, and the page it opens. */
export type ExamplePlace = { readonly scenario: string; readonly page: string };

/**
 * The scenario that shows what an example is about, when no finding points
 * at one: an example that is not caught has nothing flagged, and without
 * this both screens of a pair would open on the first scenario, whatever the
 * example changed. An example differs from the project's prototypes in the
 * files it was written for, so the place is a scenario on a page whose file
 * no prototype of the project has as it is, the one showing a state the
 * proposal names when there is one. With no such page, it is a scenario
 * showing a state the proposal names. Nothing matching gives `undefined`,
 * and the caller falls back to the first scenario.
 */
export function examplePlace(prototype: Pick<Prototype, "files" | "pages" | "scenarios">, baselines: readonly Readonly<Record<string, string>>[], states: readonly string[]): ExamplePlace | undefined {
  const changed = new Set(baselines.length === 0 ? [] : Object.keys(prototype.files).filter((path) => !baselines.some((files) => files[path] === prototype.files[path])));
  const pages = new Set(prototype.pages.filter((page) => changed.has(page.component.file)).map((page) => page.id));
  const onChanged = prototype.scenarios.filter((scenario) => pages.has(scenario.page));
  const named = (scenario: { readonly state: string }) => states.includes(scenario.state);
  const found = onChanged.find(named) ?? onChanged[0] ?? prototype.scenarios.find(named);
  return found ? { scenario: found.id, page: found.page } : undefined;
}
