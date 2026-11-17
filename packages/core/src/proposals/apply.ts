import type { ProjectConfig } from "../config/types";
import type { Result } from "../validate";
import type { InventoryOp, Proposal } from "./types";

/** A short label for an operation, for messages: `add-component "Toast"`. */
export function opLabel(op: InventoryOp): string {
  switch (op.op) {
    case "add-component":
    case "remove-component":
      return `${op.op} "${op.name}"`;
    case "add-layout":
    case "remove-layout":
    case "remove-page-type":
    case "remove-task":
      return `${op.op} "${op.id}"`;
    case "add-page-type":
      return `${op.op} "${op.pageType.id}"`;
    case "add-flow-state":
    case "remove-flow-state":
      return `${op.op} "${op.state}"`;
    case "add-task":
      return `${op.op} "${op.task.id}"`;
    case "set-max-steps":
      return `${op.op} "${op.task}" to ${op.value}`;
    case "add-cap":
      return `${op.op} ${op.name} = ${op.cap.value}`;
    case "set-cap":
      return `${op.op} ${op.name} to ${op.value}`;
    case "add-disclosed-section":
    case "remove-disclosed-section":
      return `${op.op} "${op.section}"`;
    case "set-ranking":
      return op.op;
    case "set-role":
      return `${op.op} "${op.role}"`;
  }
}

/**
 * The config with a proposal's inventory operations and rule changes applied,
 * in order. An operation that cannot apply as written (adding what is there,
 * removing what is not, setting a value to what it already is) is refused, so
 * a proposal always says exactly what changes.
 */
export function applyProposal(config: ProjectConfig, proposal: Proposal): Result<ProjectConfig, string> {
  let inventories = config.inventories;
  let inputs = config.inputs;
  let roles = config.library.roles;
  for (const [index, op] of proposal.inventory.entries()) {
    const fail = (why: string): Result<ProjectConfig, string> => ({ ok: false, error: `operation ${index + 1}, ${opLabel(op)}: ${why}` });
    switch (op.op) {
      case "add-component":
        if (inventories.components.includes(op.name)) return fail(`${op.name} is already an inventoried component`);
        inventories = { ...inventories, components: [...inventories.components, op.name] };
        break;
      case "remove-component":
        if (!inventories.components.includes(op.name)) return fail(`${op.name} is not an inventoried component`);
        inventories = { ...inventories, components: inventories.components.filter((name) => name !== op.name) };
        break;
      case "add-layout":
        if (inventories.layouts.includes(op.id)) return fail(`"${op.id}" is already an inventoried layout`);
        inventories = { ...inventories, layouts: [...inventories.layouts, op.id] };
        break;
      case "remove-layout":
        if (!inventories.layouts.includes(op.id)) return fail(`"${op.id}" is not an inventoried layout`);
        inventories = { ...inventories, layouts: inventories.layouts.filter((id) => id !== op.id) };
        break;
      case "add-page-type":
        if (inventories.pageTypes.some((type) => type.id === op.pageType.id)) return fail(`"${op.pageType.id}" is already an inventoried page type`);
        inventories = { ...inventories, pageTypes: [...inventories.pageTypes, op.pageType] };
        break;
      case "remove-page-type":
        if (!inventories.pageTypes.some((type) => type.id === op.id)) return fail(`"${op.id}" is not an inventoried page type`);
        inventories = { ...inventories, pageTypes: inventories.pageTypes.filter((type) => type.id !== op.id) };
        break;
      case "add-flow-state":
        if (inventories.flowStates.includes(op.state)) return fail(`"${op.state}" is already an inventoried flow state`);
        inventories = { ...inventories, flowStates: [...inventories.flowStates, op.state] };
        break;
      case "remove-flow-state":
        if (!inventories.flowStates.includes(op.state)) return fail(`"${op.state}" is not an inventoried flow state`);
        inventories = { ...inventories, flowStates: inventories.flowStates.filter((state) => state !== op.state) };
        break;
      case "add-task":
        if (inputs.tasks.some((task) => task.id === op.task.id)) return fail(`task "${op.task.id}" already exists`);
        inputs = { ...inputs, tasks: [...inputs.tasks, op.task] };
        break;
      case "remove-task":
        if (!inputs.tasks.some((task) => task.id === op.id)) return fail(`there is no task "${op.id}"`);
        inputs = { ...inputs, tasks: inputs.tasks.filter((task) => task.id !== op.id) };
        break;
      case "set-max-steps": {
        const task = inputs.tasks.find((item) => item.id === op.task);
        if (!task) return fail(`there is no task "${op.task}"`);
        if (task.maxSteps === op.value) return fail(`max steps is already ${op.value}`);
        inputs = { ...inputs, tasks: inputs.tasks.map((item) => (item.id === op.task ? { ...item, maxSteps: op.value } : item)) };
        break;
      }
      case "add-cap":
        if (op.name in inputs.caps) return fail(`cap ${op.name} already exists`);
        inputs = { ...inputs, caps: { ...inputs.caps, [op.name]: op.cap } };
        break;
      case "set-cap": {
        const cap = inputs.caps[op.name];
        if (!cap) return fail(`there is no cap ${op.name}`);
        if (cap.value === op.value) return fail(`${op.name} is already ${op.value}`);
        inputs = { ...inputs, caps: { ...inputs.caps, [op.name]: { ...cap, value: op.value } } };
        break;
      }
      case "add-disclosed-section":
        if (inputs.disclosedSections.includes(op.section)) return fail(`"${op.section}" is already a disclosed section`);
        inputs = { ...inputs, disclosedSections: [...inputs.disclosedSections, op.section] };
        break;
      case "remove-disclosed-section":
        if (!inputs.disclosedSections.includes(op.section)) return fail(`"${op.section}" is not a disclosed section`);
        inputs = { ...inputs, disclosedSections: inputs.disclosedSections.filter((section) => section !== op.section) };
        break;
      case "set-ranking":
        inputs = { ...inputs, ranking: op.ranking };
        break;
      case "set-role":
        roles = { ...roles, [op.role]: op.mapping };
        break;
    }
  }
  let rules = config.rules;
  for (const id of proposal.rules.remove) {
    if (!rules.some((rule) => rule.id === id)) return { ok: false, error: `rule "${id}" is not in force, so it cannot be removed` };
    rules = rules.filter((rule) => rule.id !== id);
  }
  for (const rule of proposal.rules.add) {
    if (rules.some((existing) => existing.id === rule.id)) return { ok: false, error: `rule "${rule.id}" is already in force` };
    rules = [...rules, rule];
  }
  return { ok: true, value: { ...config, library: { ...config.library, roles }, inventories, inputs, rules } };
}
