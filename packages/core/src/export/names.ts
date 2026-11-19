/**
 * Names for exported code: identifiers a person would choose, from spec
 * keys, ids and paths, kept clear of JavaScript's reserved words, of the
 * browser's globals and event fields, and of the built-ins a component reads,
 * so no name in the export shadows one a reader would take for the
 * platform's.
 */

/** The module the exported pages import `Slot` and `PageProps` from: the page kit the export writes beside them. */
export const PAGE_KIT = "@design-harness/page";

const RESERVED = new Set([
  // JavaScript and TypeScript
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield", "let", "static", "implements", "interface", "package", "private", "protected", "public", "await", "async", "of", "type", "as", "undefined", "NaN", "Infinity", "arguments", "eval",
  // The browser's globals, an event's DOM fields, and the built-ins a component reads
  "window", "self", "globalThis", "parent", "top", "frames", "opener", "document", "view", "target", "currentTarget", "srcElement", "relatedTarget", "nativeEvent", "location", "constructor", "prototype", "caller", "callee", "fetch", "event",
  "Math", "JSON", "Number", "String", "Boolean", "Array", "Object", "Map", "Set", "Symbol", "Date", "Promise", "Error", "React", "Fragment",
]);

/** `room-details` → `roomDetails`, `2nd` → `n2nd`: a camelCase identifier, never a reserved or refused name. */
export function camel(raw: string, fallback = "value"): string {
  const words = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);
  let name = words.map((word, index) => (index === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1))).join("");
  if (name === "") name = fallback;
  if (/^[0-9]/.test(name)) name = `n${name}`;
  return RESERVED.has(name) ? `${name}Value` : name;
}

/** `room-details` → `RoomDetails`. */
export function pascal(raw: string, fallback = "Component"): string {
  const name = camel(raw, fallback);
  const upper = name.charAt(0).toUpperCase() + name.slice(1);
  return RESERVED.has(upper) ? `${upper}Part` : upper;
}

/** The singular a list's items are named by: `rooms` → `room`, `entries` → `entry`, anything else → `<name>Item`. */
export function singular(list: string): string {
  const name = camel(list, "item");
  if (/ies$/.test(name) && name.length > 3) return camel(`${name.slice(0, -3)}y`);
  if (/[^s]s$/.test(name)) return camel(name.slice(0, -1));
  return camel(`${name}Item`);
}

/** True for a name usable as `object.name`. */
export function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !RESERVED.has(name);
}

/** A name not in `taken`, adding 2, 3, ... when it is; the name is then taken. */
export function fresh(name: string, taken: Set<string>): string {
  let out = name;
  for (let n = 2; taken.has(out) || RESERVED.has(out); n += 1) out = `${name}${n}`;
  taken.add(out);
  return out;
}
