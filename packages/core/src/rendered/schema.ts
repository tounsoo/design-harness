import { INVALID, arr, bool, int, num, obj, slug, str, type Check } from "../validate";
import type { Rgba, RenderedSnapshot } from "./types";

const rgba: Check<Rgba> = (value, path, issues) => {
  const channels = arr(num({ min: 0 }))(value, path, issues);
  if (channels === INVALID) return INVALID;
  const [r, g, b, a] = channels;
  if (channels.length !== 4 || r === undefined || g === undefined || b === undefined || a === undefined || r > 255 || g > 255 || b > 255 || a > 1) {
    issues.push({ path, message: "expected [r, g, b, a] with channels from 0 to 255 and alpha from 0 to 1" });
    return INVALID;
  }
  return [r, g, b, a];
};

const rect = obj({ x: num(), y: num(), width: num({ min: 0 }), height: num({ min: 0 }) });

const element = obj(
  { role: str(), name: str({ nonEmpty: false }), tag: str(), rect, interactive: bool, visible: bool },
  { inline: bool, disabled: bool, headingLevel: int({ min: 1 }), text: obj({ px: num({ min: 0 }), weight: num({ min: 0 }), color: rgba, backgrounds: arr(rgba) }, { overImage: bool }) },
);

export const snapshotSchema: Check<RenderedSnapshot> = obj({ scenario: slug, view: slug, scrollWidth: num({ min: 0 }), canvas: rgba, elements: arr(element) }, { viewportWidth: num({ min: 0 }) });
