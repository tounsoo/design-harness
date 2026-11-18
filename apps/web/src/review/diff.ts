import { applyProposal, ROLE_NAMES, type ProjectConfig, type Proposal, type RoleMapping, type Result } from "@design-harness/core";

/**
 * What a proposal does to the inventories and rule inputs, as before and
 * after: the config as it is, and the config with the proposal applied by
 * core's applyProposal. Only the parts that differ are listed. Rules are
 * shown on their own, in words.
 */

/** A list that gains or loses members: components, layouts, flow states, disclosed sections. */
export type ListDiff = {
  readonly kind: "list";
  readonly key: string;
  readonly title: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
};

/** A row of named values that is added, removed or changed: a page type, a task, a cap, a rank, a role. */
export type ValueRow = { readonly name: string; readonly change: "added" | "removed" | "changed"; readonly before?: string; readonly after?: string };

export type ValuesDiff = { readonly kind: "values"; readonly key: string; readonly title: string; readonly rows: readonly ValueRow[] };

export type DiffSection = ListDiff | ValuesDiff;

function listDiff(key: string, title: string, before: readonly string[], after: readonly string[]): ListDiff | null {
  const added = after.filter((item) => !before.includes(item));
  const removed = before.filter((item) => !after.includes(item));
  if (added.length === 0 && removed.length === 0 && before.join("\n") === after.join("\n")) return null;
  return { kind: "list", key, title, before, after, added, removed };
}

function valuesDiff(key: string, title: string, before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): ValuesDiff | null {
  const names = [...new Set([...before.keys(), ...after.keys()])];
  const rows: ValueRow[] = [];
  for (const name of names) {
    const was = before.get(name);
    const now = after.get(name);
    if (was === now) continue;
    if (was === undefined && now !== undefined) rows.push({ name, change: "added", after: now });
    else if (now === undefined && was !== undefined) rows.push({ name, change: "removed", before: was });
    else if (was !== undefined && now !== undefined) rows.push({ name, change: "changed", before: was, after: now });
  }
  return rows.length === 0 ? null : { kind: "values", key, title, rows };
}

export function roleText(mapping: RoleMapping): string {
  const parts = mapping.components.join(", ");
  if (!mapping.prop) return parts;
  const values = mapping.prop.values.map((value) => JSON.stringify(value)).join(" or ");
  return `${parts}, ${mapping.prop.name} = ${values}${mapping.prop.whenMissing ? ", or none" : ""}`;
}

function views(config: ProjectConfig) {
  const { inventories, inputs, library } = config;
  return {
    pageTypes: new Map(inventories.pageTypes.map((type) => [type.id, `${type.kind}: slots ${type.slots.join(", ")}; chrome ${type.chrome.join(", ") || "none"}${type.kind === "action" ? `; primary slot ${type.primarySlot}` : ""}`])),
    tasks: new Map(inputs.tasks.map((task) => [task.id, `ends in ${task.successState}, at most ${task.maxSteps} ${task.maxSteps === 1 ? "step" : "steps"}`])),
    caps: new Map(Object.entries(inputs.caps).map(([name, cap]) => [name, `${cap.value} (stricter when ${cap.stricter})`])),
    ranking: new Map(inputs.ranking.map((item) => [`rank ${item.rank}`, `${item.action} (${item.level})`])),
    roles: new Map(ROLE_NAMES.map((role) => [role, roleText(library.roles[role])])),
  };
}

/** The before and after of every inventory and rule input the proposal touches, or why it cannot apply to the config as it is. */
export function inventoryDiff(config: ProjectConfig, proposal: Proposal): Result<readonly DiffSection[], string> {
  const applied = applyProposal(config, proposal);
  if (!applied.ok) return applied;
  const after = applied.value;
  const was = views(config);
  const now = views(after);
  const sections = [
    listDiff("components", "Components", config.inventories.components, after.inventories.components),
    listDiff("layouts", "Layouts", config.inventories.layouts, after.inventories.layouts),
    valuesDiff("page-types", "Page types", was.pageTypes, now.pageTypes),
    listDiff("flow-states", "Flow states", config.inventories.flowStates, after.inventories.flowStates),
    valuesDiff("tasks", "Tasks", was.tasks, now.tasks),
    valuesDiff("caps", "Caps", was.caps, now.caps),
    listDiff("disclosed-sections", "Disclosed sections", config.inputs.disclosedSections, after.inputs.disclosedSections),
    valuesDiff("ranking", "Ranking", was.ranking, now.ranking),
    valuesDiff("roles", "Roles", was.roles, now.roles),
  ].filter((section): section is DiffSection => section !== null);
  return { ok: true, value: sections };
}
