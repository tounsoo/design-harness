import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { nook } from "../../../../packages/core/examples/nook/project";
import { seedLegal } from "../../test/nook";
import { Store } from "./db";

let count = 0;
const open = () => Store.open(indexedDB, `test-${(count += 1)}`);

describe("the browser store", () => {
  it("keeps a project with exactly its prototypes, and an import replaces them whole", async () => {
    const store = await open();
    const legal = seedLegal();
    await store.replaceProject(nook, [
      { projectId: "nook", id: "booking", name: "Booking", prototype: legal },
      { projectId: "nook", id: "draft", name: "Draft", prototype: legal },
    ]);
    expect((await store.projects()).items).toEqual([nook]);
    expect((await store.prototypes("nook")).items.map((item) => item.id)).toEqual(["booking", "draft"]);
    await store.replaceProject({ ...nook, name: "Nook 2" }, [{ projectId: "nook", id: "booking", name: "Booking", prototype: legal }]);
    expect((await store.projects()).items.map((item) => item.name)).toEqual(["Nook 2"]);
    expect((await store.prototypes("nook")).items.map((item) => item.id)).toEqual(["booking"]);
    store.close();
  });

  it("saves an edited prototype, and reads it back validated", async () => {
    const store = await open();
    const legal = seedLegal();
    await store.replaceProject(nook, []);
    const edited = { ...legal, files: { ...legal.files, "pages/rooms.tsx": "// edited" } };
    await store.putPrototype({ projectId: "nook", id: "booking", name: "Booking", prototype: edited });
    expect((await store.prototypes("nook")).items[0]?.prototype.files["pages/rooms.tsx"]).toBe("// edited");
    store.close();
  });

  it("reports stored data that no longer validates instead of loading it", async () => {
    const name = `test-${(count += 1)}`;
    const store = await Store.open(indexedDB, name);
    await store.replaceProject(nook, []);
    store.close();
    // Write a row the way an older version of the app might have.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => {
        const tx = request.result.transaction("prototypes", "readwrite");
        tx.objectStore("prototypes").put({ projectId: "nook", id: "old", name: "Old", prototype: { files: {} } });
        tx.oncomplete = () => {
          request.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    const reopened = await Store.open(indexedDB, name);
    const loaded = await reopened.prototypes("nook");
    expect(loaded.items).toEqual([]);
    expect(loaded.problems[0]).toBe(`Stored prototype "old" no longer validates and was not loaded:\n$: is missing "pages"\n$: is missing "layouts"\n$: is missing "scenarios"\n$: is missing "flow"`);
    reopened.close();
  });
});
