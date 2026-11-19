import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { exportReactProject } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { seedSpec, seedTsx } from "../../test/nook";
import { codeZip } from "./code-zip";

const at = "2026-11-18T12:00:00.000Z";

describe("the code export's zip", () => {
  it("holds exactly core's project files, under the project's folder, word for word", () => {
    const zipped = codeZip({ config: nook, prototype: seedSpec(), name: "Booking (spec)", at });
    expect(zipped.ok).toBe(true);
    if (!zipped.ok) return;
    const project = exportReactProject({ config: nook, prototype: seedSpec(), name: "Booking (spec)", at });
    if (!project.ok) throw new Error(project.error);
    const entries = unzipSync(zipped.value.bytes);
    expect(Object.keys(entries).sort()).toEqual(Object.keys(project.value.files).sort().map((path) => `nook-booking-spec/${path}`));
    expect(Object.keys(entries).sort()).toEqual([
      "nook-booking-spec/README.md",
      "nook-booking-spec/index.html",
      "nook-booking-spec/package.json",
      "nook-booking-spec/src/main.tsx",
      "nook-booking-spec/src/page-kit.tsx",
      "nook-booking-spec/src/prototype/layouts/room-cards.tsx",
      "nook-booking-spec/src/prototype/layouts/room-details.tsx",
      "nook-booking-spec/src/prototype/layouts/select-question.tsx",
      "nook-booking-spec/src/prototype/manifest.json",
      "nook-booking-spec/src/prototype/pages/booking.tsx",
      "nook-booking-spec/src/prototype/pages/rooms.tsx",
      "nook-booking-spec/src/scenarios.ts",
      "nook-booking-spec/src/shell.css",
      "nook-booking-spec/tsconfig.json",
      "nook-booking-spec/vite.config.ts",
    ]);
    for (const [path, text] of Object.entries(project.value.files)) expect(strFromU8(entries[`nook-booking-spec/${path}`] as Uint8Array)).toBe(text);
    expect(zipped.value.fileName).toBe("nook-booking-spec.zip");
  });

  it("is the same bytes for the same export, and says the checks' verdict in the README", () => {
    const report = { status: "fail" as const, rules: [{ rule: "one-primary-per-page", type: "count" as const, status: "fail" as const, findings: [] }], findings: [] };
    const first = codeZip({ config: nook, prototype: seedSpec(), name: "Booking (spec)", at, report });
    const again = codeZip({ config: nook, prototype: seedSpec(), name: "Booking (spec)", at, report });
    expect(first.ok && again.ok && Buffer.from(first.value.bytes).equals(Buffer.from(again.value.bytes))).toBe(true);
    if (!first.ok) return;
    expect(strFromU8(unzipSync(first.value.bytes)["nook-booking-spec/README.md"] as Uint8Array)).toContain("Core's checks at export: fail: one-primary-per-page.");
  });

  it("zips a stored TSX prototype in the same shape, its files as they are, saying nothing checked them", () => {
    const zipped = codeZip({ config: nook, prototype: seedTsx(), name: "Booking", at });
    if (!zipped.ok) throw new Error(zipped.error);
    const entries = unzipSync(zipped.value.bytes);
    for (const [path, text] of Object.entries(seedTsx().files)) expect(strFromU8(entries[`nook-booking/src/prototype/${path}`] as Uint8Array)).toBe(text);
    expect(strFromU8(entries["nook-booking/README.md"] as Uint8Array)).toContain("which design-harness no longer reads");
    expect(strFromU8(entries["nook-booking/README.md"] as Uint8Array)).not.toContain("Core's checks at export");
    expect(Object.keys(entries).filter((path) => !path.startsWith("nook-booking/src/prototype/")).sort()).toEqual(
      ["README.md", "index.html", "package.json", "src/main.tsx", "src/page-kit.tsx", "src/scenarios.ts", "src/shell.css", "tsconfig.json", "vite.config.ts"].map((path) => `nook-booking/${path}`),
    );
  });
});
