import { ROLE_NAMES, type PageKind, type RoleName } from "../rules/types";
import { arr, bool, int, obj, oneOf, record, scalar, slug, str, tagged, type Check } from "../validate";
import type { Cap, PageType, PartDescription, PropSchema, RankedAction, RoleMapping, Task } from "./types";

/** The config parts a proposal's inventory operations also carry. */
export const roleMapping: Check<RoleMapping> = obj({ components: arr(str()) }, { prop: obj({ name: str(), values: arr(scalar, { min: 1 }), whenMissing: bool }) });

export const roles: Check<Readonly<Record<RoleName, RoleMapping>>> = (value, path, issues) => {
  const shape = Object.fromEntries(ROLE_NAMES.map((name) => [name, roleMapping])) as Record<RoleName, Check<RoleMapping>>;
  return obj(shape)(value, path, issues);
};

const pageTypeFields = { id: slug, slots: arr(str(), { min: 1 }), chrome: arr(str()) } as const;
export const pageType: Check<PageType> = tagged("kind", {
  action: obj({ ...pageTypeFields, kind: oneOf(["action"]), primarySlot: str() }),
  collection: obj({ ...pageTypeFields, kind: oneOf(["collection"]) }),
  content: obj({ ...pageTypeFields, kind: oneOf(["content"]) }),
});
// PageKind and the variants above must agree; this fails to compile when one grows.
const _kinds: Record<PageKind, true> = { action: true, collection: true, content: true };
void _kinds;

export const task: Check<Task> = obj({ id: slug, successState: slug, maxSteps: int({ min: 1 }) }, { description: str() });
export const rankedAction: Check<RankedAction> = obj({ action: str(), rank: int({ min: 1 }), level: oneOf(["primary", "secondary"]) });
export const cap: Check<Cap> = obj({ value: int({ min: 0 }), stricter: oneOf(["lower", "higher"]) }, { description: str() });
export const capName = str({ pattern: /^[A-Z][A-Z0-9_]*$/, patternName: "an UPPER_SNAKE name such as MAX_DISCLOSURES_PER_PAGE" });


/** A library part as a spec names it: an export and its members, such as `Button.Root`. */
export const partName = str({ pattern: /^[A-Z][\w$]*(?:\.[A-Z][\w$]*)*$/, patternName: 'a part name such as "Button.Root"' });

const propSchema: Check<PropSchema> = tagged("type", {
  string: obj({ type: oneOf(["string"]), required: bool }, { bind: str() }),
  number: obj({ type: oneOf(["number"]), required: bool }, { bind: str() }),
  boolean: obj({ type: oneOf(["boolean"]), required: bool }, { bind: str() }),
  enum: obj({ type: oneOf(["enum"]), values: arr(str({ nonEmpty: false }), { min: 1 }), required: bool }, { bind: str() }),
  options: obj({ type: oneOf(["options"]), required: bool }),
  unknown: obj({ type: oneOf(["unknown"]), required: bool }),
});

export const partDescription: Check<PartDescription> = obj(
  { props: record(propSchema), content: oneOf(["children", "options", "none"]) },
  { events: arr(oneOf(["press"])), needs: arr(str()) },
);
