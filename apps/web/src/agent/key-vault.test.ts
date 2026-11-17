import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { KeyVault, keyHint, keyProblem } from "./key-vault";

const KEY = "sk-ant-test-0123456789abcdefghij";

describe("the key vault", () => {
  it("keeps a key for the session only by default: a new session starts without it", async () => {
    const device = new IDBFactory();
    const vault = await KeyVault.open(device);
    await vault.set(KEY, false);
    expect(vault.get()).toBe(KEY);
    expect(vault.getState()).toEqual({ present: true, remembered: false, hint: "sk-ant-…ghij" });
    expect((await KeyVault.open(device)).get()).toBeNull();
  });

  it("remembers a key on this device only when asked, and forgets it from memory and the device", async () => {
    const device = new IDBFactory();
    const vault = await KeyVault.open(device);
    await vault.set(KEY, true);
    const next = await KeyVault.open(device);
    expect(next.get()).toBe(KEY);
    expect(next.getState().remembered).toBe(true);
    await next.set(KEY, false);
    expect((await KeyVault.open(device)).get()).toBeNull();
    await next.set(KEY, true);
    await next.forget();
    expect(next.getState()).toEqual({ present: false, remembered: false, hint: null });
    expect((await KeyVault.open(device)).get()).toBeNull();
  });

  it("refuses what cannot be a key, and shows only a hint of one", () => {
    expect(keyProblem("")).toBe("Paste your API key.");
    expect(keyProblem("sk-ant- 123456789012345678")).toBe("An API key has no spaces or line breaks.");
    expect(keyProblem("short")).toBe("That is too short to be an API key.");
    expect(keyProblem(KEY)).toBeNull();
    expect(keyHint(KEY)).not.toContain("0123456789");
  });
});
