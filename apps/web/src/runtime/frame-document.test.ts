import { describe, expect, it } from "vitest";
import { FRAME_SANDBOX, frameCsp, frameDocument } from "./frame-document";

describe("a frame's document", () => {
  it("is sandboxed to scripts only: never same-origin, forms, popups, modals or top navigation", () => {
    expect(FRAME_SANDBOX.split(/\s+/)).toEqual(["allow-scripts"]);
  });

  it("forbids fetch, runs only scripts with its nonce, and lets modules load only from blobs and the package source's origins", () => {
    expect(frameCsp([], "n0nce-n0nce-n0nce")).toBe("default-src 'none'; script-src 'nonce-n0nce-n0nce-n0nce' blob:; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'");
    expect(frameCsp(["https://esm.sh/"], "n0nce-n0nce-n0nce")).toContain("script-src 'nonce-n0nce-n0nce-n0nce' blob: https://esm.sh;");
    expect(frameCsp([], "n0nce-n0nce-n0nce")).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
  });

  it("puts its nonce on the boot script and refuses a nonce that could break out of the attribute", () => {
    const html = frameDocument({ channel: "c", nonce: "0123456789abcdef", parentOrigin: "o", boot: "", scheme: "light", origins: [] });
    expect(html).toContain('<script nonce="0123456789abcdef">');
    expect(() => frameDocument({ channel: "c", nonce: '0123456789abcdef"x', parentOrigin: "o", boot: "", scheme: "light", origins: [] })).toThrow();
  });

  it("escapes what it embeds, so neither the boot script nor an attribute can end early", () => {
    const html = frameDocument({ channel: 'a"><script>', nonce: "0123456789abcdef", parentOrigin: "https://app.example", boot: 'const s = "</script><b>";', scheme: "dark", schemeAttribute: "data-appearance", origins: [] });
    expect(html).toContain('data-channel="a&quot;>&lt;script>"');
    expect(html).toContain('const s = "<\\/script><b>";');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain('data-appearance="dark"');
    expect(html).toContain("color-scheme: dark");
    expect(frameDocument({ channel: "c", nonce: "0123456789abcdef", parentOrigin: "o", boot: "", scheme: "light", schemeAttribute: 'x onload="1', origins: [] })).not.toContain("onload");
  });
});
