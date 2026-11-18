import { specCatalog, type ProjectConfig } from "@design-harness/core";

/**
 * The instructions a spec prototype's agent gets from the project's
 * catalog: json-render's `catalog.prompt()` for core's catalog. The module
 * that makes it is loaded on first use, and each prompt is kept by the
 * catalog it was made from, so the same project gives the same bytes and the
 * prompt stays a cached prefix until a proposal changes the catalog.
 */
const prompts = new Map<string, Promise<string>>();

export function specCatalogPrompt(config: ProjectConfig): Promise<string> {
  const catalog = specCatalog(config);
  if (!catalog) return Promise.reject(new Error(`the project's library (${config.library.package}) has no part descriptions, so there is no catalog to write specs from`));
  const key = JSON.stringify(catalog);
  let prompt = prompts.get(key);
  if (!prompt) {
    prompt = import("./json-render-catalog").then((module) => module.catalogPrompt(catalog));
    prompts.set(key, prompt);
    prompt.catch(() => prompts.delete(key));
  }
  return prompt;
}
