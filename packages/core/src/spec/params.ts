import type { PropSchema } from "../config/types";
import { SCENARIO_STATE } from "./catalog";
import { isRecord, type JsonValue } from "./json";

/**
 * A spec layout's parameters: what a page gives each instance of a layout,
 * typed, so one layout can be drawn many times with different data. A
 * layout file declares them under `params`; inside the layout,
 * `{ "$param": "name" }` reads one, as a prop's value, as the list a
 * `repeat` draws (`"repeat": { "param": "name" }`), as an entry of
 * `children` for a slot, or in a condition as its source or the value it
 * compares with; `${$param:name}` reads one inside a `$template`. A page
 * sets them on its instance: scalar and list values as props of the
 * `Layout` element, slot content in its `slots`.
 *
 * This is core's own format, not json-render's: core expands every instance
 * before it builds the page model or the spec a frame draws, so neither the
 * rules nor json-render ever see a parameter.
 */

/** A scalar a parameter or a list item holds. */
export type ScalarType = "text" | "number" | "boolean";
export const SCALAR_TYPES: readonly ScalarType[] = ["text", "number", "boolean"];

/** What a list holds: scalars, `{ value, label }` options (a select's choices), or records of scalar fields. */
export type ListItem = ScalarType | "option" | { readonly record: Readonly<Record<string, ScalarType>> };

type Common = {
  readonly required: boolean;
  readonly description?: string;
  /** A value the Project view draws the layout with, and the agent reads as the value's shape. */
  readonly example?: JsonValue;
};

export type LayoutParam =
  | (Common & { readonly type: ScalarType; readonly default?: JsonValue })
  | (Common & { readonly type: "enum"; readonly values: readonly string[]; readonly default?: JsonValue })
  | (Common & { readonly type: "list"; readonly of: ListItem })
  /** Where a bindable part writes its value: the page gives `{ "$bindState": "/path" }`, so each instance writes its own path. */
  | (Common & { readonly type: "binding" })
  /** Child elements the page passes in, which the layout places where `children` lists `{ "$param": name }`. */
  | (Common & { readonly type: "slot" });

export type ParamType = LayoutParam["type"];
export const PARAM_TYPES: readonly ParamType[] = ["text", "number", "boolean", "enum", "list", "binding", "slot"];

export type LayoutParams = Readonly<Record<string, LayoutParam>>;

/** The page state key under which a literal list given for a repeat is kept, per instance: `/params/<instance>/<param>`. */
export const PARAM_STATE = "params";
/** A Layout element's own prop: which layout it draws. A parameter cannot have this name. */
export const LAYOUT_ID_PROP = "id";

const NAME = /^[a-z][A-Za-z0-9-]*$/;

type Fail = (message: string, ...path: (string | number)[]) => void;

const quote = (items: readonly string[]) => items.map((item) => `"${item}"`).join(", ");

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A parameter type in words, for messages and the agent's list of layouts. */
export function describeParam(param: LayoutParam): string {
  switch (param.type) {
    case "enum":
      return `one of ${param.values.map((value) => JSON.stringify(value)).join(", ")}`;
    case "list":
      return `a list of ${describeItem(param.of)}`;
    case "binding":
      return 'a binding, { "$bindState": "/path" }, where the part writes its value';
    case "slot":
      return "child elements, given in the instance's slots";
    default:
      return param.type === "text" ? "text" : `a ${param.type}`;
  }
}

export function describeItem(item: ListItem): string {
  if (item === "option") return '{ "value", "label" } options';
  if (typeof item === "string") return item === "text" ? "texts" : `${item}s`;
  return `records of { ${Object.entries(item.record)
    .map(([field, type]) => `"${field}": ${type}`)
    .join(", ")} }`;
}

function readItem(raw: JsonValue | undefined, fail: Fail, path: (string | number)[]): ListItem | null {
  if (raw === "option" || (typeof raw === "string" && (SCALAR_TYPES as readonly string[]).includes(raw))) return raw as ListItem;
  if (isRecord(raw) && Object.keys(raw).length === 1 && isRecord(raw.record)) {
    const fields: Record<string, ScalarType> = {};
    for (const field of Object.keys(raw.record).sort(compare)) {
      const type = raw.record[field];
      if (typeof type !== "string" || !(SCALAR_TYPES as readonly string[]).includes(type)) {
        fail(`gives field "${field}" the type ${JSON.stringify(type)}; a record's field is ${quote(SCALAR_TYPES)}.`, ...path, "record", field);
        return null;
      }
      fields[field] = type as ScalarType;
    }
    return { record: fields };
  }
  fail(`has "of" ${JSON.stringify(raw)}; a list holds ${quote(SCALAR_TYPES)}, "option", or { "record": { "field": "text", ... } }.`, ...path);
  return null;
}

/** A layout file's `params`, checked. Each one that fails is reported and left out, so a use of it is reported too. */
export function readParams(raw: JsonValue, fail: Fail): Record<string, LayoutParam> {
  const out: Record<string, LayoutParam> = {};
  if (!isRecord(raw)) {
    fail(`"params" must be an object of parameters by name.`, "params");
    return out;
  }
  for (const name of Object.keys(raw).sort(compare)) {
    const at = ["params", name];
    const value = raw[name];
    if (!NAME.test(name) || name === LAYOUT_ID_PROP) {
      fail(`has a parameter named "${name}"; a name starts with a lowercase letter, holds letters, digits and "-", and is not "${LAYOUT_ID_PROP}", which names the layout.`, ...at);
      continue;
    }
    if (!isRecord(value) || typeof value.type !== "string" || !(PARAM_TYPES as readonly string[]).includes(value.type)) {
      fail(`gives parameter "${name}" no type it knows; a parameter is { "type": ${quote(PARAM_TYPES)}, ... }.`, ...at);
      continue;
    }
    const type = value.type as ParamType;
    const allowed = ["type", "required", "description", "example", ...(type === "enum" ? ["values"] : []), ...(type === "list" ? ["of"] : []), ...(["text", "number", "boolean", "enum"].includes(type) ? ["default"] : [])];
    const extra = Object.keys(value).filter((key) => !allowed.includes(key));
    if (extra.length > 0) {
      fail(`gives parameter "${name}" ${quote(extra)}; a ${type} parameter takes ${quote(allowed)}.`, ...at, extra[0] as string);
      continue;
    }
    if (value.required !== undefined && typeof value.required !== "boolean") {
      fail(`gives parameter "${name}" a "required" that is not true or false.`, ...at, "required");
      continue;
    }
    if (value.description !== undefined && typeof value.description !== "string") {
      fail(`gives parameter "${name}" a "description" that is not text.`, ...at, "description");
      continue;
    }
    const common = {
      required: value.required ?? value.default === undefined,
      ...(typeof value.description === "string" ? { description: value.description } : {}),
    };
    let param: LayoutParam;
    if (type === "enum") {
      const values = value.values;
      if (!Array.isArray(values) || values.length === 0 || !values.every((item) => typeof item === "string")) {
        fail(`gives enum parameter "${name}" no "values": a list of strings.`, ...at, "values");
        continue;
      }
      param = { type, values: values as string[], ...common };
    } else if (type === "list") {
      const of = readItem(value.of, (message, ...path) => fail(`gives list parameter "${name}" ${message}`, ...path), [...at, "of"]);
      if (!of) continue;
      param = { type, of, ...common };
    } else if (type === "binding" || type === "slot") {
      param = { type, ...common };
    } else {
      param = { type, ...common };
    }
    if (value.default !== undefined) {
      if (value.required === true) {
        fail(`gives parameter "${name}" a default, so it is not required; leave out "required".`, ...at, "default");
        continue;
      }
      if (!fitsLiteral(param, value.default)) {
        fail(`gives parameter "${name}" the default ${JSON.stringify(value.default)}, which is not ${describeParam(param)}.`, ...at, "default");
        continue;
      }
      param = { ...param, default: value.default } as LayoutParam;
    }
    if (value.example !== undefined) {
      if (type === "slot" || type === "binding" || !fitsLiteral(param, value.example)) {
        fail(`gives parameter "${name}" the example ${JSON.stringify(value.example).slice(0, 80)}, which is not ${type === "slot" || type === "binding" ? "something a " + type + " has" : describeParam(param)}.`, ...at, "example");
        continue;
      }
      param = { ...param, example: value.example };
    }
    out[name] = param;
  }
  return out;
}

function fitsScalar(type: ScalarType, value: JsonValue): boolean {
  return type === "text" ? typeof value === "string" : type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === "boolean";
}

function fitsItem(item: ListItem, value: JsonValue): boolean {
  if (item === "option") return isRecord(value) && Object.keys(value).length === 2 && typeof value.value === "string" && typeof value.label === "string";
  if (typeof item === "string") return fitsScalar(item, value);
  if (!isRecord(value)) return false;
  return Object.entries(item.record).every(([field, type]) => value[field] !== undefined && fitsScalar(type, value[field] as JsonValue));
}

/** True when a literal value is one the parameter takes. */
export function fitsLiteral(param: LayoutParam, value: JsonValue): boolean {
  switch (param.type) {
    case "enum":
      return typeof value === "string" && param.values.includes(value);
    case "list":
      return Array.isArray(value) && value.every((item) => fitsItem(param.of, item));
    case "binding":
    case "slot":
      return false;
    default:
      return fitsScalar(param.type, value);
  }
}

/** True when what an outer layout's parameter holds can be passed on as an inner one's. */
export function fitsParam(outer: LayoutParam, inner: LayoutParam): boolean {
  switch (inner.type) {
    case "text":
      return outer.type === "text" || outer.type === "enum" || outer.type === "number";
    case "enum":
      return outer.type === "enum" && outer.values.every((value) => inner.values.includes(value));
    case "list":
      return outer.type === "list" && JSON.stringify(outer.of) === JSON.stringify(inner.of);
    default:
      return outer.type === inner.type;
  }
}

/** Why a parameter cannot be a prop of this schema, or null when it can. */
export function paramMismatch(param: LayoutParam, schema: PropSchema): string | null {
  switch (schema.type) {
    case "string":
      return param.type === "text" || param.type === "enum" || param.type === "number" || (param.type === "binding" && "bind" in schema && schema.bind) ? null : `it is ${describeParam(param)}, and the prop takes text`;
    case "number":
    case "boolean":
      return param.type === schema.type || (param.type === "binding" && "bind" in schema && schema.bind) ? null : `it is ${describeParam(param)}, and the prop takes a ${schema.type}`;
    case "enum":
      if (param.type === "binding" && "bind" in schema && schema.bind) return null;
      if (param.type !== "enum") return `it is ${describeParam(param)}, and the prop takes one of ${schema.values.map((value) => JSON.stringify(value)).join(", ")}`;
      return param.values.every((value) => schema.values.includes(value)) ? null : `it can be ${param.values.filter((value) => !schema.values.includes(value)).map((value) => JSON.stringify(value)).join(", ")}, which the prop does not take`;
    case "options":
      return param.type === "list" && param.of === "option" ? null : `it is ${describeParam(param)}, and the prop takes a list of { "value", "label" } options`;
  }
}

/** Where an instance is: the parameters of the layout it is written in (null on a page), and how a condition is checked. */
export type ParamContext = { readonly outer: LayoutParams | null; readonly condition: (condition: JsonValue, path: (string | number)[]) => void };

/**
 * What a value given for a parameter may be: a literal the type takes, or
 * an expression that reads one from the page (`$state`, `$item`, `$index`,
 * `$template` for text, `$cond` of two such values), a binding for a
 * binding, or, inside another layout, `{ "$param": name }` of a parameter
 * that fits. What the page reads is checked where the layout uses it, as
 * any value is.
 */
export function checkParamValue(name: string, param: LayoutParam, value: JsonValue, context: ParamContext, fail: Fail, path: (string | number)[]): void {
  const { outer } = context;
  const bad = (why: string) => fail(`gives "${name}" ${JSON.stringify(value).slice(0, 80)}; "${name}" is ${describeParam(param)}${why}.`, ...path);
  if (param.type === "slot") {
    fail(`sets "${name}" as a prop; "${name}" is a slot, so its elements go in the instance's "slots": { "${name}": ["key", ...] }.`, ...path);
    return;
  }
  if (!isRecord(value) || !Object.keys(value).some((key) => key.startsWith("$"))) {
    if (!fitsLiteral(param, value)) bad(param.type === "binding" ? ': give { "$bindState": "/path" }' : "");
    return;
  }
  const keys = Object.keys(value).sort(compare);
  const only = (...allowed: string[]) => keys.length === allowed.length && allowed.every((key) => keys.includes(key));
  if (only("$param")) {
    const ref = value.$param;
    const from = typeof ref === "string" ? outer?.[ref] : undefined;
    if (!outer) fail(`gives "${name}" { "$param": ${JSON.stringify(ref)} }, but only a layout has parameters to pass on.`, ...path);
    else if (!from) fail(`gives "${name}" { "$param": ${JSON.stringify(ref)} }, which is not a parameter of this layout${Object.keys(outer).length > 0 ? ` (${quote(Object.keys(outer))})` : ""}.`, ...path);
    else if (!fitsParam(from, param)) fail(`gives "${name}" this layout's "${String(ref)}", which is ${describeParam(from)}; "${name}" is ${describeParam(param)}.`, ...path);
    return;
  }
  if (param.type === "binding") {
    if (only("$bindState")) {
      const target = value.$bindState;
      if (typeof target !== "string" || !target.startsWith("/")) bad(': give a path such as "/form/name"');
      else if (target === `/${SCENARIO_STATE}` || target.startsWith(`/${SCENARIO_STATE}/`)) bad(`, and ${target} is the harness's, set for each scenario`);
      return;
    }
    if (only("$bindItem")) {
      if (typeof value.$bindItem !== "string") bad(': give a field of the item, such as "name"');
      return;
    }
    bad(': give { "$bindState": "/path" }');
    return;
  }
  if (only("$state") || only("$item")) {
    const ref = value.$state ?? value.$item;
    if (typeof ref !== "string" || ("$state" in value && !ref.startsWith("/"))) bad(': read a path such as "/room/name", or an item\'s field');
    return;
  }
  if (only("$index")) {
    if (value.$index !== true || (param.type !== "number" && param.type !== "text")) bad("");
    return;
  }
  if (only("$template")) {
    if (param.type !== "text" || typeof value.$template !== "string") bad(param.type === "text" ? "" : ", and $template makes text");
    else for (const problem of templateParamProblems(value.$template, outer)) fail(`gives "${name}" a $template that reads ${problem}.`, ...path);
    return;
  }
  if (only("$cond", "$else", "$then") && param.type !== "list") {
    context.condition(value.$cond as JsonValue, [...path, "$cond"]);
    checkParamValue(name, param, value.$then as JsonValue, context, fail, [...path, "$then"]);
    checkParamValue(name, param, value.$else as JsonValue, context, fail, [...path, "$else"]);
    return;
  }
  if (only("$scopedId") && param.type === "text") {
    if (typeof value.$scopedId !== "string" || !NAME.test(value.$scopedId)) bad(': write { "$scopedId": "name" }');
    return;
  }
  bad(`: a literal, or ${param.type === "list" ? "$state or $item" : "$state, $item, $cond" + (param.type === "text" ? ", $template or $scopedId" : "")}`);
}

/** True when `name` is a valid `$scopedId` name. */
export function isScopedIdName(name: unknown): name is string {
  return typeof name === "string" && NAME.test(name);
}

/** How a `$template` reads a parameter of the layout it is written in: `${$param:name}`. */
export const TEMPLATE_PARAM = "$param:";

/** The references of a `$template`, in order: what each `${...}` holds. */
export function templateRefs(template: string): string[] {
  return [...template.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1] ?? "");
}

/**
 * What is wrong with the parameters a `$template` reads, each the end of a
 * sentence that starts "... a $template that reads": a parameter outside a
 * layout, one the layout lacks, or one that is not text, a number or an
 * enum, which is all a template can put in.
 */
export function templateParamProblems(template: string, params: LayoutParams | null): string[] {
  const out: string[] = [];
  for (const ref of templateRefs(template)) {
    if (!ref.startsWith("$")) continue;
    const name = ref.startsWith(TEMPLATE_PARAM) ? ref.slice(TEMPLATE_PARAM.length) : null;
    const param = name !== null ? params?.[name] : undefined;
    if (name === null) out.push(`\${${ref}}, which is not a reference a template here may use: \${/path} reads state, \${field} the repeat item${params ? ", and ${$param:name} a parameter" : ""}`);
    else if (!params) out.push(`\${${ref}}, but only a layout has parameters`);
    else if (!param) out.push(`\${${ref}}, which is not a parameter of this layout${Object.keys(params).length > 0 ? ` (${quote(Object.keys(params))})` : ""}`);
    else if (param.type !== "text" && param.type !== "number" && param.type !== "enum") out.push(`parameter "${name}", but it is ${describeParam(param)}, and a template puts in text, a number or one of an enum's values`);
  }
  return out;
}

/** What a condition compares a parameter as: text (an enum too), a number or a boolean; null for what a condition cannot read. */
function conditionKind(param: LayoutParam): "text" | "number" | "boolean" | null {
  switch (param.type) {
    case "text":
    case "enum":
      return "text";
    case "number":
    case "boolean":
      return param.type;
    default:
      return null;
  }
}

const NUMERIC = ["gt", "gte", "lt", "lte"];

/**
 * What is wrong with the parameters one condition reads, each the end of a
 * sentence that starts "has a condition that": `{ "$param": name }` as its
 * source, or as the value it compares with. A parameter is checked against
 * its use: alone, a condition tests a boolean; `gt`, `gte`, `lt` and `lte`
 * compare numbers; a literal it is compared with must be one the parameter
 * can hold; two parameters compared must hold the same kind of value.
 */
export function conditionParamProblems(condition: { readonly [key: string]: JsonValue }, params: LayoutParams | null): string[] {
  const operator = ["eq", "neq", ...NUMERIC].find((key) => key in condition);
  const operand = operator === undefined ? undefined : condition[operator];
  const sourceName = typeof condition.$param === "string" ? condition.$param : undefined;
  const operandName = isRecord(operand) && Object.keys(operand).length === 1 && typeof operand.$param === "string" ? operand.$param : undefined;
  const out: string[] = [];
  const declared = (name: string | undefined): LayoutParam | null => {
    if (name === undefined) return null;
    const param = params?.[name];
    if (!params) out.push(`reads { "$param": ${JSON.stringify(name)} }, but only a layout has parameters`);
    else if (!param) out.push(`reads { "$param": ${JSON.stringify(name)} }, which is not a parameter of this layout${Object.keys(params).length > 0 ? ` (${quote(Object.keys(params))})` : ""}`);
    else if (conditionKind(param) === null) out.push(`reads parameter "${name}", which is ${describeParam(param)}; a condition reads a boolean, text, a number or one of an enum's values`);
    else return param;
    return null;
  };
  const source = declared(sourceName);
  const other = declared(operandName);
  if (out.length > 0) return out;
  const numeric = operator !== undefined && NUMERIC.includes(operator);
  if (source) {
    const name = sourceName as string;
    if (operator === undefined) {
      if (source.type !== "boolean") out.push(`tests parameter "${name}" alone, but it is ${describeParam(source)}; a condition with no operator tests a boolean, so compare it with "eq" or "neq"`);
    } else if (numeric && source.type !== "number") out.push(`compares parameter "${name}" with "${operator}", which compares numbers, but it is ${describeParam(source)}`);
    else if (other) {
      if (conditionKind(other) !== conditionKind(source)) out.push(`compares parameter "${name}", ${describeParam(source)}, with parameter "${String(operandName)}", ${describeParam(other)}, so they are never equal`);
    } else if (!isRecord(operand) && !fitsLiteral(source, operand as JsonValue)) out.push(`compares parameter "${name}" with ${JSON.stringify(operand)}, which it never holds: it is ${describeParam(source)}`);
  } else if (other && numeric && other.type !== "number") out.push(`compares with parameter "${String(operandName)}" using "${operator}", which compares numbers, but it is ${describeParam(other)}`);
  return out;
}
