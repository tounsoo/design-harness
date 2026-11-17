/**
 * A small runtime validator for plain JSON. Each check pushes issues with a
 * JSON path instead of throwing, so a caller gets every problem at once, in
 * the order the schema lists its fields. Objects are strict: an unknown key is
 * an issue, because a misspelled rule field would otherwise be ignored and the
 * rule would check less than its author meant.
 */

export type Issue = { readonly path: string; readonly message: string };

/** Returns the value as T when it is valid; otherwise pushes issues and returns INVALID. */
export type Check<T> = (value: unknown, path: string, issues: Issue[]) => T | typeof INVALID;

export const INVALID: unique symbol = Symbol("invalid");

export type Result<T, E = readonly Issue[]> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function run<T>(check: Check<T>, value: unknown, root = "$"): Result<T> {
  const issues: Issue[] = [];
  const out = check(value, root, issues);
  if (issues.length > 0 || out === INVALID) return { ok: false, error: issues.length > 0 ? issues : [{ path: root, message: "is invalid" }] };
  return { ok: true, value: out };
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

export function str(options: { readonly pattern?: RegExp; readonly patternName?: string; readonly nonEmpty?: boolean } = {}): Check<string> {
  return (value, path, issues) => {
    if (typeof value !== "string") {
      issues.push({ path, message: `expected a string, got ${kindOf(value)}` });
      return INVALID;
    }
    if ((options.nonEmpty ?? true) && value.length === 0) {
      issues.push({ path, message: "expected a non-empty string" });
      return INVALID;
    }
    if (options.pattern && !options.pattern.test(value)) {
      issues.push({ path, message: `expected ${options.patternName ?? `a string matching ${String(options.pattern)}`}, got ${JSON.stringify(value)}` });
      return INVALID;
    }
    return value;
  };
}

/** Lowercase words joined by hyphens: the shape of every id in a config. */
export const slug = str({ pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, patternName: "a lowercase slug such as \"book-room\"" });

export function int(options: { readonly min?: number } = {}): Check<number> {
  return (value, path, issues) => {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      issues.push({ path, message: `expected a whole number, got ${typeof value === "number" ? value : kindOf(value)}` });
      return INVALID;
    }
    if (options.min !== undefined && value < options.min) {
      issues.push({ path, message: `expected a whole number of at least ${options.min}, got ${value}` });
      return INVALID;
    }
    return value;
  };
}

export function num(options: { readonly min?: number } = {}): Check<number> {
  return (value, path, issues) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push({ path, message: `expected a finite number, got ${kindOf(value)}` });
      return INVALID;
    }
    if (options.min !== undefined && value < options.min) {
      issues.push({ path, message: `expected a number of at least ${options.min}, got ${value}` });
      return INVALID;
    }
    return value;
  };
}

export const bool: Check<boolean> = (value, path, issues) => {
  if (typeof value !== "boolean") {
    issues.push({ path, message: `expected true or false, got ${kindOf(value)}` });
    return INVALID;
  }
  return value;
};

export function oneOf<const T extends readonly (string | number | boolean)[]>(values: T): Check<T[number]> {
  return (value, path, issues) => {
    if (!values.includes(value as T[number])) {
      issues.push({ path, message: `expected one of ${values.map((item) => JSON.stringify(item)).join(", ")}, got ${JSON.stringify(value) ?? kindOf(value)}` });
      return INVALID;
    }
    return value as T[number];
  };
}

/** A JSON scalar: what a prop value or an allowed value can be. */
export const scalar: Check<string | number | boolean | null> = (value, path, issues) => {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  issues.push({ path, message: `expected a string, number, boolean or null, got ${kindOf(value)}` });
  return INVALID;
};

export function arr<T>(item: Check<T>, options: { readonly min?: number } = {}): Check<readonly T[]> {
  return (value, path, issues) => {
    if (!Array.isArray(value)) {
      issues.push({ path, message: `expected an array, got ${kindOf(value)}` });
      return INVALID;
    }
    if (options.min !== undefined && value.length < options.min) {
      issues.push({ path, message: `expected at least ${options.min} item${options.min === 1 ? "" : "s"}, got ${value.length}` });
    }
    const out: T[] = [];
    let valid = true;
    value.forEach((entry, index) => {
      const checked = item(entry, `${path}[${index}]`, issues);
      if (checked === INVALID) valid = false;
      else out.push(checked);
    });
    return valid ? out : INVALID;
  };
}

/** A string-keyed record. Keys are checked with `key`, and the result keeps the input's keys. */
export function record<T>(value: Check<T>, key: Check<string> = str()): Check<Readonly<Record<string, T>>> {
  return (input, path, issues) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      issues.push({ path, message: `expected an object, got ${kindOf(input)}` });
      return INVALID;
    }
    const out: Record<string, T> = {};
    let valid = true;
    for (const name of Object.keys(input).sort()) {
      if (key(name, `${path}.${name}`, issues) === INVALID) valid = false;
      const checked = value((input as Record<string, unknown>)[name], `${path}.${name}`, issues);
      if (checked === INVALID) valid = false;
      else out[name] = checked;
    }
    return valid ? out : INVALID;
  };
}

type Shape = Readonly<Record<string, Check<unknown>>>;
type Out<S extends Shape> = { -readonly [K in keyof S]: S[K] extends Check<infer T> ? T : never };
type Optional<S extends Shape> = { -readonly [K in keyof S]?: S[K] extends Check<infer T> ? T : never };
type Flatten<T> = { [K in keyof T]: T[K] };

/** A strict object: every required key present, no keys outside required and optional. */
export function obj<R extends Shape, O extends Shape = Record<never, never>>(required: R, optional?: O): Check<Flatten<Out<R> & Optional<O>>> {
  return (input, path, issues) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      issues.push({ path, message: `expected an object, got ${kindOf(input)}` });
      return INVALID;
    }
    const source = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let valid = true;
    for (const [name, check] of Object.entries(required)) {
      if (!(name in source)) {
        issues.push({ path, message: `is missing "${name}"` });
        valid = false;
        continue;
      }
      const checked = check(source[name], `${path}.${name}`, issues);
      if (checked === INVALID) valid = false;
      else out[name] = checked;
    }
    for (const [name, check] of Object.entries(optional ?? {})) {
      if (!(name in source) || source[name] === undefined) continue;
      const checked = check(source[name], `${path}.${name}`, issues);
      if (checked === INVALID) valid = false;
      else out[name] = checked;
    }
    const known = new Set([...Object.keys(required), ...Object.keys(optional ?? {})]);
    for (const name of Object.keys(source).sort()) {
      if (known.has(name)) continue;
      issues.push({ path, message: `has an unknown field "${name}"; expected only ${[...known].map((key) => `"${key}"`).join(", ")}` });
      valid = false;
    }
    return valid ? (out as Flatten<Out<R> & Optional<O>>) : INVALID;
  };
}

/** A union told apart by one string field, such as a rule's `type`. */
export function tagged<K extends string, M extends Readonly<Record<string, Check<unknown>>>>(
  key: K,
  variants: M,
): Check<{ [V in keyof M]: M[V] extends Check<infer T> ? T : never }[keyof M]> {
  type Variant = { [V in keyof M]: M[V] extends Check<infer T> ? T : never }[keyof M];
  return (input, path, issues) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      issues.push({ path, message: `expected an object, got ${kindOf(input)}` });
      return INVALID;
    }
    const tag = (input as Record<string, unknown>)[key];
    const names = Object.keys(variants);
    if (typeof tag !== "string" || !Object.hasOwn(variants, tag)) {
      issues.push({ path: `${path}.${key}`, message: `expected one of ${names.map((name) => JSON.stringify(name)).join(", ")}, got ${JSON.stringify(tag) ?? "nothing"}` });
      return INVALID;
    }
    const check = variants[tag] as Check<unknown>;
    return check(input, path, issues) as Variant | typeof INVALID;
  };
}

/** The first of several checks that accepts the value; issues come from the one `pick` chooses when none does. */
export function either<A, B>(pick: (value: unknown) => "a" | "b", a: Check<A>, b: Check<B>): Check<A | B> {
  return (value, path, issues) => (pick(value) === "a" ? a(value, path, issues) : b(value, path, issues));
}

/** A literal `true`, for flags whose only meaningful value is present. */
export const yes: Check<true> = (value, path, issues) => {
  if (value !== true) {
    issues.push({ path, message: `expected true, got ${JSON.stringify(value) ?? kindOf(value)}` });
    return INVALID;
  }
  return true;
};

/** Defers to a check defined later, for recursive shapes such as a selector inside a selector. */
export function lazy<T>(get: () => Check<T>): Check<T> {
  return (value, path, issues) => get()(value, path, issues);
}
