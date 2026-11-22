import { describe, expect, it } from "vitest";
import { redact, redactContent } from "./errors";

describe("redact", () => {
  const TOKEN = 'tok"en\\secret-9876543210';

  it("finds a token as written and as written inside a JSON string", () => {
    expect(redact(`raw ${TOKEN}`, null, [TOKEN])).toBe("raw [a docs server token]");
    expect(redact(JSON.stringify({ query: TOKEN }), null, [TOKEN])).toBe('{"query":"[a docs server token]"}');
  });

  it("redacts every string of a tool call's input, and leaves thinking as it came", () => {
    const clean = (text: string) => redact(text, null, [TOKEN]);
    const out = redactContent(
      [
        { type: "thinking", thinking: `about ${TOKEN}`, signature: "sig" },
        { type: "tool_use", id: "toolu_a", name: "patch_spec", input: { path: TOKEN, nested: [{ deep: TOKEN }], [TOKEN]: true, count: 2 }, caller: { type: "direct" } },
      ] as Parameters<typeof redactContent>[0],
      clean,
    );
    expect(out[0]).toMatchObject({ thinking: `about ${TOKEN}` });
    expect(out[1]).toMatchObject({ input: { path: "[a docs server token]", nested: [{ deep: "[a docs server token]" }], "[a docs server token]": true, count: 2 } });
    expect(JSON.stringify(out[1])).not.toContain("secret-9876543210");
  });
});
