import type * as t from "@babel/types";
import type { Literal } from "../rules/types";
import type { ElementNode } from "./model";
import type { ModuleInfo } from "./modules";

/** One part of what JSX renders, in order: an element, literal text, or text only known at runtime. */
export type Piece = { readonly kind: "node"; readonly node: ElementNode } | { readonly kind: "text"; readonly text: string } | { readonly kind: "dynamic" };

export type FunctionNode = t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression | t.ObjectMethod;

/**
 * What an expression evaluates to, as far as the source shows without running
 * it. Anything the extractor cannot reduce is `unknown`, with the reason, and
 * the rules that depend on it say so instead of passing it.
 */
export type Value =
  | { readonly k: "lit"; readonly v: Literal | undefined }
  /** One of false, null, 0 or "": renders nothing, but as a prop it is not a known literal. */
  | { readonly k: "falsy"; readonly why: string }
  /** One of several values, picked at runtime. */
  | { readonly k: "choice"; readonly of: readonly Value[] }
  | { readonly k: "render"; readonly pieces: readonly Piece[] }
  | { readonly k: "fn"; readonly node: FunctionNode; readonly env: Env; readonly name: string }
  /** A library export, by path: `[]` is the namespace, `["Button", "Root"]` a part. */
  | { readonly k: "lib"; readonly path: readonly string[] }
  /** The page kit: `""` is its namespace. */
  | { readonly k: "kit"; readonly name: string }
  /** React: null is the namespace. */
  | { readonly k: "react"; readonly name: string | null }
  | { readonly k: "ns"; readonly module: ModuleInfo }
  /** An object; `open` says why it may hold entries not listed. */
  | { readonly k: "obj"; readonly entries: ReadonlyMap<string, Value>; readonly open: string | null }
  | { readonly k: "arr"; readonly items: readonly Value[] }
  /**
   * Not known statically. `opaque` marks a value that could be anything,
   * elements included, such as the result of calling a function the
   * extractor cannot see; as a child it becomes an unresolved element.
   */
  | { readonly k: "unknown"; readonly why: string; readonly opaque?: true };

export const UNDEFINED: Value = { k: "lit", v: undefined };

export function unknown(why: string, opaque = false): Value {
  return opaque ? { k: "unknown", why, opaque: true } : { k: "unknown", why };
}

type Binding = { value?: Value; init?: () => Value; busy?: boolean };

/** A lexical scope: names bound in one module, function or block, with the scope around it. */
export class Env {
  private readonly vars = new Map<string, Binding>();

  constructor(
    readonly module: ModuleInfo,
    readonly parent: Env | null,
  ) {}

  set(name: string, value: Value): void {
    this.vars.set(name, { value });
  }

  /** Binds a name evaluated on first use, so declaration order and unused declarations cost nothing. */
  lazy(name: string, init: () => Value): void {
    this.vars.set(name, { init });
  }

  private find(name: string): Binding | undefined {
    return this.vars.get(name) ?? this.parent?.find(name);
  }

  lookup(name: string): Value {
    const binding = this.find(name);
    if (binding) {
      if (binding.value) return binding.value;
      if (binding.busy) return unknown(`"${name}" is defined in terms of itself`);
      binding.busy = true;
      const value = binding.init ? binding.init() : unknown(`"${name}" has no value`);
      binding.busy = false;
      binding.value = value;
      return value;
    }
    return name === "undefined" ? UNDEFINED : unknown(`"${name}" is not defined in the prototype`, true);
  }
}

export function truthiness(value: Value): boolean | null {
  if (value.k === "lit") return Boolean(value.v);
  if (value.k === "falsy") return false;
  if (value.k === "render" || value.k === "fn" || value.k === "obj" || value.k === "arr" || value.k === "lib" || value.k === "kit" || value.k === "ns") return true;
  return null;
}

/** Choices flattened, with duplicate literals dropped, so `a ? "x" : "x"` is just "x". */
export function choice(options: readonly Value[]): Value {
  const flat: Value[] = [];
  for (const option of options) {
    for (const item of option.k === "choice" ? option.of : [option]) {
      if (item.k === "lit" && flat.some((seen) => seen.k === "lit" && seen.v === item.v)) continue;
      flat.push(item);
    }
  }
  return flat.length === 1 && flat[0] ? flat[0] : { k: "choice", of: flat };
}

export function member(value: Value, name: string): Value {
  switch (value.k) {
    case "lib":
      if (value.path.length === 0 && name === "default") return unknown("the library's default export is not a component the rules know");
      return { k: "lib", path: [...value.path, name] };
    case "kit":
      return value.name === "" ? { k: "kit", name } : unknown(`the page kit's ${value.name} has no part "${name}"`);
    case "react":
      return value.name === null ? { k: "react", name } : unknown(`React's ${value.name}.${name}`);
    case "obj":
      return value.entries.get(name) ?? (value.open ? unknown(value.open) : UNDEFINED);
    case "arr": {
      const index = Number(name);
      if (Number.isInteger(index) && index >= 0) return value.items[index] ?? UNDEFINED;
      return unknown(`the array's "${name}"`);
    }
    case "lit":
      return value.v === undefined || value.v === null ? unknown(`reads "${name}" of ${String(value.v)}`) : unknown(`a property of a ${typeof value.v}`);
    case "choice":
      return choice(value.of.map((option) => member(option, name)));
    case "unknown":
      return value;
    default:
      return unknown(`"${name}" of a ${value.k === "ns" ? "module namespace with no such export" : "value the extractor does not follow"}`);
  }
}
