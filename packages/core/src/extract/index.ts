import type * as t from "@babel/types";
import type { ComponentRef, Prototype } from "../prototype/types";
import { Evaluator } from "./evaluator";
import { scanAmbient } from "./ambient";
import type { AmbientUse, ElementNode, ExtractionProblem, ModuleLoad, PageModel, PrototypeModel } from "./model";
import { isScript, locationOf, parseModule, visit, type ModuleInfo } from "./modules";
import { scanSource } from "./source-scan";
import type { Value } from "./values";

export { PAGE_KIT } from "./evaluator";

/**
 * Builds the page model of a prototype: each manifest page's rendered tree,
 * every JSX element in its source, and every module it loads. Pure: the same
 * prototype gives the same model, whatever order its files were given in.
 */
export function extractPrototype(prototype: Prototype, library: string): PrototypeModel {
  const problems: ExtractionProblem[] = [];
  const paths = Object.keys(prototype.files).sort();
  const files = new Set(paths);
  const modules = new Map<string, ModuleInfo>();
  for (const path of paths) {
    if (!isScript(path)) continue;
    const parsed = parseModule(path, prototype.files[path] ?? "");
    if ("problem" in parsed) problems.push(parsed.problem);
    else modules.set(path, parsed.module);
  }

  const evaluator = new Evaluator({ modules, files, library, problems });

  const resolve = (ref: ComponentRef, what: string): Extract<Value, { k: "fn" }> | null => {
    const module = modules.get(ref.file);
    if (!module) {
      problems.push({ message: files.has(ref.file) ? `${what} names ${ref.file}, which does not parse, so it cannot be checked` : `${what} names ${ref.file}, which is not a file in the prototype` });
      return null;
    }
    const value = evaluator.resolveExport(module, ref.export);
    if (value?.k === "fn") return value;
    problems.push({
      message: value === null ? `${what} names export "${ref.export}" of ${ref.file}, which has no such export` : `${what} names export "${ref.export}" of ${ref.file}, which is not a function component the extractor can read`,
      at: { file: ref.file, line: 1, column: 1 },
    });
    return null;
  };

  const marks = new Map<t.Node, { page?: string; layout?: string }>();
  const pageComponents: { id: string; pageType: string; fn: Extract<Value, { k: "fn" }> }[] = [];
  for (const layout of [...prototype.layouts].sort((a, b) => compare(a.id, b.id))) {
    const fn = resolve(layout.component, `layout "${layout.id}"`);
    if (fn) marks.set(fn.node, { ...marks.get(fn.node), layout: layout.id });
  }
  for (const page of [...prototype.pages].sort((a, b) => compare(a.id, b.id))) {
    const fn = resolve(page.component, `page "${page.id}"`);
    if (!fn) continue;
    marks.set(fn.node, { ...marks.get(fn.node), page: page.id });
    pageComponents.push({ id: page.id, pageType: page.pageType, fn });
  }
  evaluator.setMarks(marks);

  const pages: PageModel[] = pageComponents.map(({ id, pageType, fn }) => {
    const at = locationOf(fn.env.module.path, fn.node);
    return { id, pageType, root: evaluator.renderComponent(fn, fn.name || id, at, `page:${id}`) };
  });

  const source: ElementNode[] = [];
  const loads: ModuleLoad[] = [];
  const ambient: AmbientUse[] = [];
  for (const module of modules.values()) {
    source.push(...scanSource(evaluator, evaluator.moduleEnv(module), module.program));
    loads.push(...module.loads);
    ambient.push(...scanAmbient(module));
    problems.push(...elementFactories(module));
  }

  return { pages, source, loads, ambient, problems };
}

/** `createElement` and `cloneElement` build elements no JSX shows, so nothing a rule reads can be trusted around them. */
function elementFactories(module: ModuleInfo): ExtractionProblem[] {
  const found: ExtractionProblem[] = [];
  visit(module.program, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee;
    const name = callee.type === "Identifier" ? callee.name : callee.type === "MemberExpression" && callee.property.type === "Identifier" ? callee.property.name : null;
    if (name === "createElement" || name === "cloneElement") {
      found.push({ message: `${name} builds an element without JSX, which the extractor cannot read. Write the element as JSX.`, at: locationOf(module.path, node) });
    }
  });
  return found;
}

export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
