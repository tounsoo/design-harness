import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCompanyTokens } from "@tounsoo/todae/tokens-builder";
import { describe, expect, it } from "vitest";

const web = join(import.meta.dirname, "..", "..");

describe("the design-harness token layer", () => {
  it("is what todae-tokens builds from tokens/resolver.json, with every check Todae's build runs", async () => {
    // buildCompanyTokens runs Todae's checks (layers, references, light and dark parity, APCA contrast) and throws on a failure.
    const built = await buildCompanyTokens({ resolver: join(web, "tokens", "resolver.json") });
    expect(built.css, "src/theme/todae-theme.css is stale: run npm run tokens in apps/web").toBe(readFileSync(join(web, "src", "theme", "todae-theme.css"), "utf8"));
    expect(built.overrideTypes, "src/theme/todae-theme.types.ts is stale: run npm run tokens in apps/web").toBe(readFileSync(join(web, "src", "theme", "todae-theme.types.ts"), "utf8"));
  }, 30_000);
});
