import type { Prototype } from "@design-harness/core";
import { describe, expect, it } from "vitest";
import { seedSpec } from "../../test/nook";
import { partialString, SpecStreamPreview, streamedPatchInput } from "./spec-stream";

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("a patch_spec input that is still streaming", () => {
  it("decodes the part of a string that has arrived, never half an escape", () => {
    expect(partialString('ab\\nc"rest')).toBe("ab\nc");
    expect(partialString("ab\\")).toBe("ab");
    expect(partialString("ab\\u00")).toBe("ab");
    expect(partialString('{\\"op\\":\\"add\\"}\\n{\\"op')).toBe('{"op":"add"}\n{"op');
  });

  it("finds the path and the patches that have arrived", () => {
    expect(streamedPatchInput('{"path":"pages/booking.json","patches":"{\\"op\\":\\"replace\\"}\\n{\\"o')).toEqual({ path: "pages/booking.json", patches: '{"op":"replace"}\n{"o' });
    expect(streamedPatchInput('{"pa')).toEqual({ path: null, patches: "" });
  });
});

describe("the streaming preview", () => {
  it("shows the draft as each patch line completes, through json-render's stream compiler, then the prototype as it is", async () => {
    const shown: (Prototype | null)[] = [];
    const preview = new SpecStreamPreview((draft) => shown.push(draft), () => seedSpec(), 0);
    const input = JSON.stringify({ path: "pages/booking.json", patches: '{"op":"replace","path":"/elements/book/props/text","value":"Book now"}\n{"op":"replace","path":"/elements/hold/props/text","value":"Hold it"}\n' });
    preview.start("patch_spec");
    // json-render's core loads on the first stream; once it has, each completed line shows.
    await import("@json-render/core");
    await flush();
    const cut = input.indexOf("Hold it");
    preview.delta(input.slice(0, cut));
    await flush();
    preview.delta(input.slice(cut));
    await flush();
    const drafts = shown.filter((item): item is Prototype => item !== null).map((item) => JSON.parse(item.files["pages/booking.json"] ?? "{}") as { elements: Record<string, { props: { text: string } }> });
    expect(drafts.map((draft) => [draft.elements.book?.props.text, draft.elements.hold?.props.text])).toEqual([
      ["Book now", "Hold room"],
      ["Book now", "Hold it"],
    ]);
    preview.finish();
    expect(shown.at(-1)).toBeNull();
  });

  it("follows nothing but patch_spec", async () => {
    const shown: unknown[] = [];
    const spec = new SpecStreamPreview((draft) => shown.push(draft), () => seedSpec(), 0);
    spec.start("write_spec");
    spec.delta('{"path":"pages/booking.json"');
    await flush();
    spec.finish();
    expect(shown).toEqual([]);
  });
});
