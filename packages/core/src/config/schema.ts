import { proposalSchema } from "../proposals/schema";
import { ruleSpec } from "../rules/schema";
import { arr, int, obj, oneOf, record, scalar, slug, str, type Check } from "../validate";
import { cap, capName, confirmedLibrary, pageType, partDescription, partName, rankedAction, roles, task } from "./parts";
import { CONFIG_SCHEMA_VERSION, type ProjectConfig } from "./types";

/** An npm package name, scoped or not. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/** An exact version, never a range, so the same config renders the same library on every load. */
const exactVersion = str({ pattern: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, patternName: 'an exact version such as "1.2.3", not a range' });
/** A file inside a package: relative, forward slashes, no `..`. */
const packagePath = str({ pattern: /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[\w@.~-]+(?:\/[\w@.~-]+)*$/, patternName: 'a path inside the package such as "dist/todae.css"' });

/** A part every page renders inside: a top-level export, its literal props, and the prop that takes the view's scheme. */
const libraryRoot = obj(
  { component: str({ pattern: /^[A-Z][\w$]*$/, patternName: 'a top-level export such as "MantineProvider"' }) },
  { props: record(scalar), schemeProp: str({ pattern: /^[A-Za-z_$][\w$]*$/, patternName: 'a prop name such as "forceColorScheme"' }) },
);

const configShape = obj({
  schemaVersion: oneOf([CONFIG_SCHEMA_VERSION]),
  id: slug,
  name: str(),
  library: obj({ package: str({ pattern: PACKAGE_NAME, patternName: 'an npm package name such as "@tounsoo/todae"' }), version: exactVersion, react: exactVersion, roles }, { stylesheets: arr(packagePath), schemeAttribute: str({ pattern: /^[a-z][a-z0-9-]*$/, patternName: 'a lowercase attribute name such as "data-appearance"' }), root: libraryRoot, excludedProps: arr(str({ pattern: /^[A-Za-z_$*][\w$*-]*$/, patternName: 'a prop name, or a pattern with * such as "data-*"' })), parts: record(partDescription, partName), confirmed: confirmedLibrary }),
  inventories: obj({ components: arr(str({ pattern: /^[A-Z][\w$]*$/, patternName: "a capitalised export name such as \"Button\"" })), layouts: arr(slug), pageTypes: arr(pageType), flowStates: arr(slug) }),
  inputs: obj({ tasks: arr(task), ranking: arr(rankedAction), disclosedSections: arr(str()), caps: record(cap, capName) }),
  views: arr(obj({ name: slug, width: int({ min: 1 }), height: int({ min: 1 }), scheme: oneOf(["light", "dark"]) })),
  rules: arr(ruleSpec),
  proposals: arr(proposalSchema),
});

export const configSchema: Check<ProjectConfig> = configShape;

