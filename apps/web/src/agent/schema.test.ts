import { describe, expect, it } from "vitest";
import { validateInput, type JsonSchema } from "./schema";

const schema: JsonSchema = {
  type: "object",
  properties: {
    path: { type: "string", pattern: "^[a-z]+\\.tsx$", maxLength: 20 },
    count: { type: "integer", minimum: 1 },
    mode: { type: "string", enum: ["a", "b"] },
    files: { type: "object", additionalProperties: { type: "string" } },
    list: { type: "array", items: { type: "string" }, minItems: 1 },
  },
  required: ["path"],
  additionalProperties: false,
};

describe("tool input validation", () => {
  it("accepts input that fits the schema", () => {
    expect(validateInput(schema, { path: "home.tsx", count: 2, mode: "a", files: { "x.ts": "1" }, list: ["one"] })).toEqual([]);
  });

  it("names every problem with its path, so the agent can fix its call", () => {
    expect(validateInput(schema, { count: 1.5, mode: "c", files: { "x.ts": 1 }, list: [], extra: true })).toEqual([
      'input: is missing "path"',
      "input.count: expected an integer, got 1.5",
      'input.mode: expected one of "a", "b", got "c"',
      'input.files["x.ts"]: expected a string, got number',
      "input.list: expected at least 1 items",
      'input: has unknown field "extra"',
    ]);
    expect(validateInput(schema, { path: "../x.tsx" })).toEqual(["input.path: does not match ^[a-z]+\\.tsx$"]);
  });

  it("refuses a silently truncated input: the wrong type or a missing field, never a crash", () => {
    expect(validateInput(schema, "{\"path\": \"ho")).toEqual(["input: expected an object, got string"]);
    expect(validateInput(schema, null)).toEqual(["input: expected an object, got null"]);
    expect(validateInput(schema, {})).toEqual(['input: is missing "path"']);
  });
});
