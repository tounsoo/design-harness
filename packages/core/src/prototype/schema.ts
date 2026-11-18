import { arr, obj, oneOf, record, slug, str, type Check } from "../validate";
import type { Prototype } from "./types";

const filePath = str({ pattern: /^(?!\/)(?!\.\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\]+$/, patternName: "a relative path with forward slashes, no leading \"/\" or \"./\", and no \".\" or \"..\" segments" });
const exportName = str({ pattern: /^(?:default|[A-Za-z_$][\w$]*)$/, patternName: "\"default\" or an identifier" });
const componentRef = obj({ file: filePath, export: exportName });

export const prototypeSchema: Check<Prototype> = obj(
  {
    files: record(str({ nonEmpty: false }), filePath),
    pages: arr(obj({ id: slug, pageType: slug, component: componentRef })),
    layouts: arr(obj({ id: slug, component: componentRef })),
    scenarios: arr(obj({ id: slug, state: slug, page: slug })),
    flow: obj({
      states: arr(slug),
      tasks: arr(obj({ task: slug, start: slug, transitions: arr(obj({ from: slug, event: slug, to: slug })) })),
    }),
  },
  { format: oneOf(["tsx", "spec"]) },
);
