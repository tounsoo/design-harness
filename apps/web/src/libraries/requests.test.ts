import { describe, expect, it } from "vitest";
import { MAX_PENDING, readPending, withPending, withoutPending, writePending, type PendingRequest } from "./requests";

const memory = (initial?: string) => {
  const values = new Map<string, string>(initial === undefined ? [] : [["design-harness.library-requests", initial]]);
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values };
};
const ACME = { package: "@acme/ui", version: "1.2.3", stylesheets: ["dist/ui.css"] };
const none = () => false;

describe("pending library requests in this browser", () => {
  it("are kept newest first, one per package and version, and read back", () => {
    const store = memory();
    let list: PendingRequest[] = [];
    list = withPending(list, ACME, "2026-11-19T10:00:00.000Z");
    list = withPending(list, { ...ACME, version: "2.0.0" }, "2026-11-19T11:00:00.000Z");
    list = withPending(list, ACME, "2026-11-19T12:00:00.000Z");
    expect(list.map((entry) => `${entry.version} ${entry.at}`)).toEqual(["1.2.3 2026-11-19T12:00:00.000Z", "2.0.0 2026-11-19T11:00:00.000Z"]);
    writePending(list, store);
    expect(readPending(none, store)).toEqual(list);
    expect(withoutPending(list, ACME).map((entry) => entry.version)).toEqual(["2.0.0"]);
    expect(Array.from({ length: 30 }, (_, n) => n).reduce<PendingRequest[]>((all, n) => withPending(all, { ...ACME, version: `1.0.${n}` }, "2026-11-19T10:00:00.000Z"), [])).toHaveLength(MAX_PENDING);
  });

  it("leave out one the deployment now lists", () => {
    const store = memory(JSON.stringify([{ ...ACME, at: "2026-11-19T10:00:00.000Z" }]));
    expect(readPending((request) => request.package === "@acme/ui" && request.version === "1.2.3", store)).toEqual([]);
  });

  it("read nothing from storage that is blocked, broken or written by something else, and drop entries that are not valid requests", () => {
    expect(readPending(none, undefined)).toEqual([]);
    expect(readPending(none, { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined })).toEqual([]);
    expect(readPending(none, memory("not json"))).toEqual([]);
    expect(readPending(none, memory('{"a":1}'))).toEqual([]);
    const mixed = [null, 3, { ...ACME, at: "never" }, { ...ACME, version: "^1.0.0", at: "2026-11-19T10:00:00.000Z" }, { ...ACME, package: "$(id)", at: "2026-11-19T10:00:00.000Z" }, { ...ACME, stylesheets: ["../x.css"], at: "2026-11-19T10:00:00.000Z" }, { ...ACME, at: "2026-11-19T10:00:00.000Z" }];
    expect(readPending(none, memory(JSON.stringify(mixed)))).toEqual([{ ...ACME, at: "2026-11-19T10:00:00.000Z" }]);
    expect(() => writePending([], { getItem: () => null, setItem: () => { throw new Error("full"); } })).not.toThrow();
  });
});
