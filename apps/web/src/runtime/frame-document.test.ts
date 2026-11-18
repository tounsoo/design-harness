import { describe, expect, it } from "vitest";
import { FRAME_SANDBOX, frameCsp, frameDocument } from "./frame-document";

describe("a frame's document", () => {
  it("is sandboxed to scripts only: never same-origin, forms, popups, modals or top navigation", () => {
    expect(FRAME_SANDBOX.split(/\s+/)).toEqual(["allow-scripts"]);
  });

  it("forbids fetch and lets modules load only from blobs and the package source's origins", () => {
    expect(frameCsp([])).toBe("default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'");
    expect(frameCsp(["https://esm.sh/"])).toContain("script-src 'unsafe-inline' blob: https://esm.sh;");
  });

  it("escapes what it embeds, so neither the boot script nor an attribute can end early", () => {
    const html = frameDocument({ channel: 'a"><script>', parentOrigin: "https://app.example", boot: 'const s = "</script><b>";', scheme: "dark", schemeAttribute: "data-appearance", origins: [] });
    expect(html).toContain('data-channel="a&quot;>&lt;script>"');
    expect(html).toContain('const s = "<\\/script><b>";');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain('data-appearance="dark"');
    expect(html).toContain("color-scheme: dark");
    expect(frameDocument({ channel: "c", parentOrigin: "o", boot: "", scheme: "light", schemeAttribute: 'x onload="1', origins: [] })).not.toContain("onload");
  });
});
