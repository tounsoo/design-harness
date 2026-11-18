/**
 * A JSON parser that remembers where things are. `JSON.parse` gives values
 * but no positions, and its error messages differ between engines, so a
 * finding about a spec could not point at a line, and a file that does not
 * parse would read differently in each browser. This one gives every value's
 * position by its JSON Pointer, refuses a key written twice in one object
 * (`JSON.parse` would keep the last silently), and words its own errors.
 */

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Line and column, counting from 1. */
export type Position = { readonly line: number; readonly column: number };

export type ParsedJson =
  | { readonly ok: true; readonly value: JsonValue; readonly positions: ReadonlyMap<string, Position> }
  | { readonly ok: false; readonly message: string; readonly at: Position };

/** RFC 6901: `~` and `/` in a key are written `~0` and `~1`. */
export function pointer(path: readonly (string | number)[]): string {
  return path.map((part) => `/${String(part).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

class Fail {
  constructor(
    readonly message: string,
    readonly offset: number,
  ) {}
}

/**
 * Parses `text` as JSON. Each value's position is kept under its JSON Pointer;
 * for an object member it is where the member's key starts, so a finding
 * about an element points at the line that names it.
 */
export function parseJson(text: string): ParsedJson {
  const positions = new Map<string, Position>();
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) if (text[index] === "\n") lineStarts.push(index + 1);
  const positionOf = (offset: number): Position => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: offset - (lineStarts[low] ?? 0) + 1 };
  };

  let at = 0;
  const space = () => {
    while (at < text.length && (text[at] === " " || text[at] === "\t" || text[at] === "\n" || text[at] === "\r")) at += 1;
  };
  const describe = (offset: number) => (offset >= text.length ? "the end of the file" : `${JSON.stringify(text[offset])}`);

  const string = (): string => {
    const start = at;
    at += 1;
    let out = "";
    while (at < text.length) {
      const char = text[at] as string;
      if (char === '"') {
        at += 1;
        return out;
      }
      if (char === "\\") {
        const next = text[at + 1];
        const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (next !== undefined && next in simple) {
          out += simple[next];
          at += 2;
          continue;
        }
        if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(at + 2, at + 6))) {
          out += String.fromCharCode(parseInt(text.slice(at + 2, at + 6), 16));
          at += 6;
          continue;
        }
        throw new Fail("has an escape JSON does not allow", at);
      }
      if (char.charCodeAt(0) < 0x20) throw new Fail("has a line break or control character inside a string", at);
      out += char;
      at += 1;
    }
    throw new Fail("has a string that never ends", start);
  };

  const value = (path: (string | number)[]): JsonValue => {
    space();
    const start = at;
    if (!positions.has(pointer(path))) positions.set(pointer(path), positionOf(start));
    const char = text[at];
    if (char === "{") {
      at += 1;
      const out: Record<string, JsonValue> = {};
      const seen = new Set<string>();
      space();
      if (text[at] === "}") {
        at += 1;
        return out;
      }
      for (;;) {
        space();
        if (text[at] !== '"') throw new Fail(`expected a key in quotes, found ${describe(at)}`, at);
        const keyAt = at;
        const key = string();
        if (seen.has(key)) throw new Fail(`has the key ${JSON.stringify(key)} twice in one object`, keyAt);
        seen.add(key);
        positions.set(pointer([...path, key]), positionOf(keyAt));
        space();
        if (text[at] !== ":") throw new Fail(`expected ":" after the key ${JSON.stringify(key)}, found ${describe(at)}`, at);
        at += 1;
        // A key named __proto__ is an own property, as JSON.parse makes it, never the prototype.
        Object.defineProperty(out, key, { value: value([...path, key]), enumerable: true, writable: true, configurable: true });
        space();
        if (text[at] === ",") {
          at += 1;
          continue;
        }
        if (text[at] === "}") {
          at += 1;
          return out;
        }
        throw new Fail(`expected "," or "}", found ${describe(at)}`, at);
      }
    }
    if (char === "[") {
      at += 1;
      const out: JsonValue[] = [];
      space();
      if (text[at] === "]") {
        at += 1;
        return out;
      }
      for (;;) {
        out.push(value([...path, out.length]));
        space();
        if (text[at] === ",") {
          at += 1;
          continue;
        }
        if (text[at] === "]") {
          at += 1;
          return out;
        }
        throw new Fail(`expected "," or "]", found ${describe(at)}`, at);
      }
    }
    if (char === '"') return string();
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at, at + 64));
    if (literal) {
      at += literal[0].length;
      const word = literal[0];
      return word === "true" ? true : word === "false" ? false : word === "null" ? null : Number(word);
    }
    throw new Fail(`expected a value, found ${describe(at)}`, at);
  };

  try {
    const parsed = value([]);
    space();
    if (at < text.length) throw new Fail(`has more after the value ends, at ${describe(at)}`, at);
    return { ok: true, value: parsed, positions };
  } catch (error) {
    if (error instanceof Fail) return { ok: false, message: error.message, at: positionOf(Math.min(error.offset, text.length)) };
    throw error;
  }
}

export function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
