import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { KeyVault } from "../agent/key-vault";
import { DocTokens, tokenProblem } from "./token-vault";

const TOKEN = "mcp-token-0123456789-abcdefgh";

async function rows(factory: IDBFactory): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const request = factory.open("design-harness-key", 1);
    request.onsuccess = () => {
      const all = request.result.transaction("keys").objectStore("keys").getAll();
      all.onsuccess = () => {
        request.result.close();
        resolve(all.result);
      };
      all.onerror = () => reject(all.error);
    };
    request.onerror = () => reject(request.error);
  });
}

describe("docs server tokens", () => {
  it("are kept in memory for the session unless remembered", async () => {
    const factory = new IDBFactory();
    const tokens = await DocTokens.open(factory);
    await tokens.set("nook", "todae-docs", TOKEN, false);
    expect(tokens.get("nook", "todae-docs")).toBe(TOKEN);
    expect(tokens.state("nook", "todae-docs")).toEqual({ present: true, remembered: false, hint: "mcp-tok…efgh" });
    expect(tokens.get("tally", "todae-docs")).toBeNull();
    expect(await rows(factory)).toEqual([]);
    expect((await DocTokens.open(factory)).get("nook", "todae-docs")).toBeNull();
  });

  it("are remembered beside the API key, each under its project and server, and forgotten from both memory and the device", async () => {
    const factory = new IDBFactory();
    const vault = await KeyVault.open(factory);
    await vault.set("sk-ant-test-0123456789abcdefghij", true);
    const tokens = await DocTokens.open(factory);
    await tokens.set("nook", "todae-docs", TOKEN, true);
    expect(await rows(factory)).toEqual([
      { id: "anthropic", key: "sk-ant-test-0123456789abcdefghij" },
      { id: "mcp:nook:todae-docs", token: TOKEN },
    ]);
    const reopened = await DocTokens.open(factory);
    expect(reopened.state("nook", "todae-docs")).toMatchObject({ present: true, remembered: true });
    expect(reopened.all()).toEqual([TOKEN]);
    // The API key's vault reads only its own row.
    expect((await KeyVault.open(factory)).get()).toBe("sk-ant-test-0123456789abcdefghij");
    await reopened.rename("nook", "todae-docs", "docs");
    expect(reopened.get("nook", "docs")).toBe(TOKEN);
    expect(await rows(factory)).toEqual([
      { id: "anthropic", key: "sk-ant-test-0123456789abcdefghij" },
      { id: "mcp:nook:docs", token: TOKEN },
    ]);
    await reopened.forget("nook", "docs");
    expect(reopened.get("nook", "docs")).toBeNull();
    expect(await rows(factory)).toEqual([{ id: "anthropic", key: "sk-ant-test-0123456789abcdefghij" }]);
  });

  it("refuse what cannot be a token", async () => {
    expect(tokenProblem("")).toMatch(/^Paste the token/);
    expect(tokenProblem("two words")).toBe("A token has no spaces or line breaks.");
    expect(tokenProblem("x".repeat(9000))).toBe("That is too long to be a token.");
    expect(tokenProblem(TOKEN)).toBeNull();
    const tokens = await DocTokens.open(null);
    await expect(tokens.set("nook", "a", "has space", false)).rejects.toThrow("A token has no spaces");
  });
});
