import { proposalSchema } from "../proposals/schema";
import { ruleSpec } from "../rules/schema";
import { arr, int, obj, oneOf, record, slug, str, type Check } from "../validate";
import { cap, capName, pageType, rankedAction, roles, task } from "./parts";
import { CONFIG_SCHEMA_VERSION, type ProjectConfig } from "./types";

const configShape = obj({
  schemaVersion: oneOf([CONFIG_SCHEMA_VERSION]),
  id: slug,
  name: str(),
  library: obj({ package: str(), version: str(), roles }),
  inventories: obj({ components: arr(str({ pattern: /^[A-Z][\w$]*$/, patternName: "a capitalised export name such as \"Button\"" })), layouts: arr(slug), pageTypes: arr(pageType), flowStates: arr(slug) }),
  inputs: obj({ tasks: arr(task), ranking: arr(rankedAction), disclosedSections: arr(str()), caps: record(cap, capName) }),
  views: arr(obj({ name: slug, width: int({ min: 1 }), height: int({ min: 1 }), scheme: oneOf(["light", "dark"]) })),
  rules: arr(ruleSpec),
  proposals: arr(proposalSchema),
});

export const configSchema: Check<ProjectConfig> = configShape;

