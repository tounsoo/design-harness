import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { KeyVault } from "../agent/key-vault";
import { DocTokens, tokenProblem } from "./token-vault";

const TOKEN = "mcp-token-0123456789-abcdefgh";
const URL = "https://mcp.example.com/mcp";

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
    await tokens.set("nook", "todae-docs", URL, TOKEN, false);
    expect(tokens.get("nook", "todae-docs", URL)).toBe(TOKEN);
    expect(tokens.state("nook", "todae-docs", URL)).toEqual({ present: true, remembered: false, hint: "mcp-tok…efgh" });
    expect(tokens.get("tally", "todae-docs", URL)).toBeNull();
    expect(await rows(factory)).toEqual([]);
    expect((await DocTokens.open(factory)).get("nook", "todae-docs", URL)).toBeNull();
  });

  it("are remembered beside the API key, each under its project and server, and forgotten from both memory and the device", async () => {
    const factory = new IDBFactory();
    const vault = await KeyVault.open(factory);
    await vault.set("sk-ant-test-0123456789abcdefghij", true);
    const tokens = await DocTokens.open(factory);
    await tokens.set("nook", "todae-docs", URL, TOKEN, true);
    expect(await rows(factory)).toEqual([
      { id: "anthropic", key: "sk-ant-test-0123456789abcdefghij" },
      { id: "mcp:nook:todae-docs", token: TOKEN, url: URL },
    ]);
    const reopened = await DocTokens.open(factory);
    expect(reopened.state("nook", "todae-docs", URL)).toMatchObject({ present: true, remembered: true });
    expect(reopened.all()).toEqual([TOKEN]);
    // The API key's vault reads only its own row.
    expect((await KeyVault.open(factory)).get()).toBe("sk-ant-test-0123456789abcdefghij");
    await reopened.rename("nook", "todae-docs", "docs");
    expect(reopened.get("nook", "docs", URL)).toBe(TOKEN);
    expect(await rows(factory)).toEqual([
      { id: "anthropic", key: "sk-ant-test-0123456789abcdefghij" },
      { id: "mcp:nook:docs", token: TOKEN, url: URL },
    ]);
    await reopened.forget("nook", "docs");
    expect(reopened.get("nook", "docs", URL)).toBeNull();
    expect(await rows(factory)).toEqual([{ id: "anthropic", key: "sk-ant-test-0123456789abcdefghij" }]);
  });

  it("are sent only to the address they were given for", async () => {
    const factory = new IDBFactory();
    const tokens = await DocTokens.open(factory);
    await tokens.set("nook", "todae-docs", URL, TOKEN, true);
    // An imported project that reuses the id and the server's name, at another address, gets no token.
    expect(tokens.get("nook", "todae-docs", "https://elsewhere.example/mcp")).toBeNull();
    expect(tokens.state("nook", "todae-docs", "https://elsewhere.example/mcp")).toEqual({ present: false, remembered: false, hint: null });
    expect((await DocTokens.open(factory)).get("nook", "todae-docs", "https://elsewhere.example/mcp")).toBeNull();
    // It is still held for redaction.
    expect(tokens.all()).toEqual([TOKEN]);
  });

  it("kept before they were bound to an address are never sent, only redacted", async () => {
    const factory = new IDBFactory();
    await KeyVault.open(factory);
    await new Promise<void>((resolve, reject) => {
      const request = factory.open("design-harness-key", 1);
      request.onsuccess = () => {
        const tx = request.result.transaction("keys", "readwrite");
        tx.objectStore("keys").put({ id: "mcp:nook:todae-docs", token: TOKEN });
        tx.oncomplete = () => {
          request.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    const tokens = await DocTokens.open(factory);
    expect(tokens.get("nook", "todae-docs", URL)).toBeNull();
    expect(tokens.all()).toEqual([TOKEN]);
  });

  it("refuse what cannot be a token", async () => {
    expect(tokenProblem("")).toMatch(/^Paste the token/);
    expect(tokenProblem("two words")).toBe("A token has no spaces or line breaks.");
    expect(tokenProblem("x".repeat(9000))).toBe("That is too long to be a token.");
    expect(tokenProblem(TOKEN)).toBeNull();
    const tokens = await DocTokens.open(null);
    await expect(tokens.set("nook", "a", URL, "has space", false)).rejects.toThrow("A token has no spaces");
  });
});
