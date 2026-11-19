import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { nook } from "../../../../packages/core/examples/nook/project";
import { seedSpec, seedTsx } from "../../test/nook";
import { NO_PINS, addPin } from "../pins/model";
import { Store } from "./db";

let count = 0;
const open = () => Store.open(indexedDB, `test-${(count += 1)}`);

describe("the browser store", () => {
  it("keeps a project with exactly its prototypes, and an import replaces them whole", async () => {
    const store = await open();
    const legal = seedSpec();
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
    const legal = seedSpec();
    await store.replaceProject(nook, []);
    const edited = { ...legal, files: { ...legal.files, "pages/rooms.json": "// edited" } };
    await store.putPrototype({ projectId: "nook", id: "booking", name: "Booking", prototype: edited });
    expect((await store.prototypes("nook")).items[0]?.prototype.files["pages/rooms.json"]).toBe("// edited");
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
    // A prototype with no format was TSX; this one is not whole, so not even its files can be kept.
    expect(loaded.problems[0]).toMatch(/^Stored prototype "old" no longer validates and was not loaded:\n\$\.format: says the prototype is TSX .*\n\$: is missing "pages"\n\$: is missing "layouts"\n\$: is missing "scenarios"\n\$: is missing "flow"$/);
    reopened.close();
  });

  it("keeps a prototype's variants beside it, across a reopen", async () => {
    const name = `test-${(count += 1)}`;
    const store = await Store.open(indexedDB, name);
    const variants = { variants: [{ id: "a", page: "booking", note: "Book first", spec: "{}" }], picks: [] };
    await store.replaceProject(nook, [{ projectId: "nook", id: "booking", name: "Booking", prototype: seedSpec(), variants }]);
    await store.putPrototype({ projectId: "nook", id: "draft", name: "Draft", prototype: seedSpec() });
    store.close();
    const reopened = await Store.open(indexedDB, name);
    const loaded = await reopened.prototypes("nook");
    expect(loaded.items.map((item) => [item.id, item.variants ?? null])).toEqual([["booking", variants], ["draft", null]]);
    reopened.close();
  });

  it("keeps a prototype's pinned notes beside it across a reopen, and reports ones it cannot read instead of dropping them silently", async () => {
    const name = `test-${(count += 1)}`;
    const store = await Store.open(indexedDB, name);
    const added = addPin(NO_PINS, { scenario: "lantern-open", view: "desktop", revision: "rev-1", seen: "rev-1", point: { x: 270, y: 210 } }, "Make this bigger", "2026-11-19T10:00:00.000Z");
    if (!added.ok) throw new Error(added.error);
    await store.replaceProject(nook, [{ projectId: "nook", id: "booking", name: "Booking", prototype: seedSpec(), pins: added.value }]);
    await store.putPrototype({ projectId: "nook", id: "draft", name: "Draft", prototype: seedSpec(), pins: { ...added.value, version: 9 } as never });
    store.close();
    const reopened = await Store.open(indexedDB, name);
    const loaded = await reopened.prototypes("nook");
    expect(loaded.items.map((item) => [item.id, item.pins ?? null])).toEqual([["booking", added.value], ["draft", null]]);
    expect(loaded.problems).toEqual(['The pinned notes stored with prototype "draft" could not be read and were not loaded:\n$: expected pins as { "version": 1, "next", "pins" }']);
    reopened.close();
  });

  it("loads a stored TSX prototype as it was, for its files alone, and a stored config without the rules only TSX had, saying which", async () => {
    const name = `test-${(count += 1)}`;
    const store = await Store.open(indexedDB, name);
    store.close();
    const tsx = seedTsx();
    const { format: _format, ...unformatted } = tsx;
    const legacy = { ...nook, rules: [...nook.rules, { type: "isolation", id: "no-ambient-globals" }], proposals: [] };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => {
        const tx = request.result.transaction(["projects", "prototypes"], "readwrite");
        tx.objectStore("projects").put({ id: "nook", config: legacy });
        tx.objectStore("prototypes").put({ projectId: "nook", id: "old", name: "Old", prototype: unformatted });
        tx.objectStore("prototypes").put({ projectId: "nook", id: "older", name: "Older", prototype: tsx });
        tx.oncomplete = () => {
          request.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    const reopened = await Store.open(indexedDB, name);
    const projects = await reopened.projects();
    expect(projects.items).toEqual([nook]);
    expect(projects.removed).toEqual({ nook: ['rule "no-ambient-globals", which only TSX had'] });
    expect(projects.problems).toEqual([]);
    const loaded = await reopened.prototypes("nook");
    expect(loaded.problems).toEqual([]);
    expect(loaded.items.map((item) => [item.id, item.prototype])).toEqual([["old", tsx], ["older", tsx]]);
    reopened.close();
  });
});
