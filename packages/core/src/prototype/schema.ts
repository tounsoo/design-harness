import { INVALID, arr, obj, oneOf, record, slug, str, type Check } from "../validate";
import type { Prototype, TsxPrototype } from "./types";

const filePath = str({ pattern: /^(?!\/)(?!\.\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\]+$/, patternName: "a relative path with forward slashes, no leading \"/\" or \"./\", and no \".\" or \"..\" segments" });
const exportName = str({ pattern: /^(?:default|[A-Za-z_$][\w$]*)$/, patternName: "\"default\" or an identifier" });
const componentRef = obj({ file: filePath, export: exportName });

const manifest = {
  files: record(str({ nonEmpty: false }), filePath),
  pages: arr(obj({ id: slug, pageType: slug, component: componentRef })),
  layouts: arr(obj({ id: slug, component: componentRef })),
  scenarios: arr(obj({ id: slug, state: slug, page: slug })),
  flow: obj({
    states: arr(slug),
    tasks: arr(obj({ task: slug, start: slug, transitions: arr(obj({ from: slug, event: slug, to: slug })) })),
  }),
} as const;

/** Why core refuses a TSX prototype, in words the app can show as they are. */
export const TSX_REFUSED = "says the prototype is TSX (a prototype with no format was TSX), and core no longer reads TSX prototypes: it cannot be checked or rendered. Its files can still be shown and exported as they are.";

/** True for stored data that says it is a TSX prototype: `format` is "tsx", or absent, which meant TSX before every prototype was a spec. */
export function saysTsx(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const format = (value as { format?: unknown }).format;
  return format === undefined || format === "tsx";
}

const spec = obj({ format: oneOf(["spec"]), ...manifest });

/** A spec prototype. Stored data that says it is TSX is refused with `TSX_REFUSED` at `format`. */
export const prototypeSchema: Check<Prototype> = (value, path, issues) => {
  if (saysTsx(value)) {
    issues.push({ path: `${path}.format`, message: TSX_REFUSED });
    return INVALID;
  }
  return spec(value, path, issues);
};

/** A TSX prototype's shape, for reading back a stored one: `format` may be absent, as it was before specs. */
export const tsxPrototypeSchema: Check<Omit<TsxPrototype, "format"> & { readonly format?: "tsx" }> = obj(manifest, { format: oneOf(["tsx"]) });
