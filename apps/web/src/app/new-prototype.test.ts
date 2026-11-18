import { describe, expect, it } from "vitest";
import { checkPrototype, parsePrototype } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { blankPrototype, defaultFormat, prototypeId } from "./new-prototype";

describe("a new prototype", () => {
  it("is a spec prototype by default, and TSX only when the project cannot check specs", () => {
    expect(defaultFormat(nook)).toBe("spec");
    const { parts: _parts, ...library } = nook.library;
    expect(defaultFormat({ ...nook, library })).toBe("tsx");
  });

  it("starts empty and valid in either format, and core checks it", () => {
    for (const format of ["spec", "tsx"] as const) {
      const prototype = blankPrototype(format);
      expect(parsePrototype(prototype)).toEqual({ ok: true, value: prototype });
      expect(prototype.format).toBe(format === "spec" ? "spec" : undefined);
      // Nothing is drawn and no flow is written yet: the checks say so, as for any prototype.
      expect(checkPrototype({ config: nook, prototype }).rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule)).toEqual(["disclosed-sections", "rank-1-shown", "step-budget"]);
    }
  });

  it("gets an id from its name, unique in the project", () => {
    expect(prototypeId("Checkout flow", ["booking"])).toBe("checkout-flow");
    expect(prototypeId("Booking (spec)", ["booking", "booking-spec"])).toBe("booking-spec-2");
    expect(prototypeId("!!!", [])).toBe("prototype");
  });
});
