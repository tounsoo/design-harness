import type { IsolationRule } from "../../rules/types";
import { locate, where, type CheckContext } from "../context";
import type { Finding } from "../report";
import type { Outcome } from "./outcome";

/**
 * Prototype code reaches only its imports and plain language built-ins. Every
 * use the source scan found is a violation, except a property read by a
 * computed key, which the scan cannot clear: that one is unverifiable, and
 * fails the rule all the same.
 */
export function evaluateIsolation(rule: IsolationRule, ctx: CheckContext): Outcome {
  const findings: Finding[] = ctx.model.ambient.map((use) => {
    const at = where(use.at);
    switch (use.kind) {
      case "computed":
        return {
          rule: rule.id,
          ...locate(use.at),
          kind: "unverifiable",
          message: `Cannot tell what ${at} reaches: it ${use.reason}. Read properties by name, or keep the records in an array and use .find.`,
        };
      case "global":
        return { rule: rule.id, ...locate(use.at), kind: "violation", message: `${at} uses ${use.name}, which ${use.reason}. Prototype code uses only its imports and plain language built-ins.` };
      case "member":
        return { rule: rule.id, ...locate(use.at), kind: "violation", message: `${at} reads .${use.name}, which ${use.reason}. Prototype code may not reach the frame it is measured in.` };
      case "write":
        return { rule: rule.id, ...locate(use.at), kind: "violation", message: `${at} ${use.reason}. Prototype code builds new values instead of changing objects, so it cannot change the built-ins its frame is measured with.` };
      case "dom":
        return { rule: rule.id, ...locate(use.at), kind: "violation", message: `${at} uses ${use.name}, which ${use.reason}. Prototype code renders library parts and never touches the DOM itself.` };
      case "meta":
        return { rule: rule.id, ...locate(use.at), kind: "violation", message: `${at} uses import.meta, which ${use.reason}.` };
    }
  });
  return { findings };
}
