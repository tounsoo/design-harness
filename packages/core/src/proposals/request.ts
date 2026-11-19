import type { Proposal, RuleTypeExample } from "./types";

/** A request for a new rule type as an issue a person files: a title and a Markdown body. */
export type RuleTypeIssue = { readonly title: string; readonly body: string };

function fence(text: string): string {
  // A fence longer than any run of backticks in the snippet, so the snippet cannot close it.
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}\n${text}\n${marks}`;
}

function examples(list: readonly RuleTypeExample[]): string {
  return list.map((example) => [`- **${example.name}**: ${example.description.trim()}`, ...(example.snippet ? ["", fence(example.snippet).replace(/^/gm, "  ")] : [])].join("\n")).join("\n");
}

/**
 * The issue a request for a new rule type is filed as, written from the
 * proposal alone: what the rule should check, why the vocabulary cannot say
 * it, the examples it must pass and fail, and where it came from. Pure, so
 * the same request gives the same text. Undefined for a proposal that is
 * not a request.
 */
export function ruleTypeIssue(proposal: Proposal): RuleTypeIssue | undefined {
  const request = proposal.needsRuleType;
  if (!request) return undefined;
  const drafted = proposal.history[0];
  const body = [
    `A prototype rule the project needs cannot be written in core's rule vocabulary. This asks for a new rule type in \`packages/core\`: a code change, with its evaluator, schema, words and tests.`,
    "",
    "## What the rule should check",
    "",
    request.checks.trim(),
    "",
    "## Why the vocabulary cannot express it",
    "",
    request.whyNot.trim(),
    "",
    "## Must pass",
    "",
    examples(request.pass),
    "",
    "## Must fail",
    "",
    examples(request.fail),
    "",
    "## Where it came from",
    "",
    proposal.reason.trim(),
    "",
    `Proposal \`${proposal.id}\`${drafted ? `, drafted by ${drafted.by ?? "unknown"} at ${drafted.at}` : ""}. Once core has the rule type, a proposal that uses it, with examples that prove it, can be adopted like any other.`,
  ].join("\n");
  return { title: `New rule type: ${proposal.title.trim()}`, body };
}
