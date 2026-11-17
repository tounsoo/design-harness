/**
 * Validates a tool's parsed input against the very JSON Schema the tool was
 * declared with, before the tool runs. With eager input streaming the API no
 * longer validates tool input, and the SDK's tolerant partial-JSON parser can
 * hand back a silently truncated object, so nothing runs on input that fails
 * here. It covers the subset the tools use: `type` (object, array, string,
 * integer, number, boolean), `properties`, `required`, `additionalProperties`
 * (false or a schema), `items`, `enum`, `minLength`, `maxLength`, `pattern`,
 * `minItems`, `maxItems` and `minimum`.
 */

export type JsonSchema = {
  readonly type?: "object" | "array" | "string" | "integer" | "number" | "boolean";
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly enum?: readonly (string | number | boolean)[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minimum?: number;
};

const kindOf = (value: unknown): string => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

/** Every way `value` breaks `schema`, each with its path; empty when it fits. */
export function validateInput(schema: JsonSchema, value: unknown, path = "input"): string[] {
  const issues: string[] = [];
  const kind = kindOf(value);
  switch (schema.type) {
    case "object":
      if (kind !== "object") return [`${path}: expected an object, got ${kind}`];
      break;
    case "array":
      if (kind !== "array") return [`${path}: expected an array, got ${kind}`];
      break;
    case "string":
      if (kind !== "string") return [`${path}: expected a string, got ${kind}`];
      break;
    case "integer":
      if (kind !== "number" || !Number.isInteger(value)) return [`${path}: expected an integer, got ${kind === "number" ? String(value) : kind}`];
      break;
    case "number":
      if (kind !== "number" || !Number.isFinite(value)) return [`${path}: expected a number, got ${kind}`];
      break;
    case "boolean":
      if (kind !== "boolean") return [`${path}: expected true or false, got ${kind}`];
      break;
    default:
  }
  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) issues.push(`${path}: expected one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}, got ${JSON.stringify(value)}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push(`${path}: expected at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push(`${path}: expected at most ${schema.maxLength} characters, got ${value.length}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) issues.push(`${path}: does not match ${schema.pattern}`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) issues.push(`${path}: expected at least ${schema.minimum}`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(`${path}: expected at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(`${path}: expected at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => issues.push(...validateInput(schema.items as JsonSchema, item, `${path}[${index}]`)));
  }
  if (kind === "object") {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) issues.push(`${path}: is missing "${key}"`);
    for (const [key, item] of Object.entries(record)) {
      const property = schema.properties?.[key];
      if (property) issues.push(...validateInput(property, item, `${path}.${key}`));
      else if (schema.additionalProperties === false) issues.push(`${path}: has unknown field "${key}"`);
      else if (typeof schema.additionalProperties === "object") issues.push(...validateInput(schema.additionalProperties, item, `${path}[${JSON.stringify(key)}]`));
    }
  }
  return issues;
}
