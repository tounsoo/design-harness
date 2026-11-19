import { Badge, Code, Disclosure, Text } from "@tounsoo/todae";
import { classifyProposal, describeRule, type ChangeClass, type Classification, type ProjectConfig, type Proposal, type ProposalStatus, type RuleSpec } from "@design-harness/core";

/** Parts the proposals list and a proposal's page share. */

export function statusTone(status: ProposalStatus): "info" | "success" | "critical" | "warning" {
  return status === "adopted" ? "success" : status === "declined" ? "critical" : status === "approved" ? "info" : "warning";
}

export function StatusBadge({ status }: { readonly status: ProposalStatus }) {
  return (
    <Badge.Root tone={statusTone(status)} data-testid="proposal-status">
      {status}
    </Badge.Root>
  );
}

const CLASS_WORDS: Readonly<Record<ChangeClass, string>> = { adds: "only adds", tightens: "tightens", "loosens-or-removes": "loosens or removes" };

export function classWords(value: ChangeClass): string {
  return CLASS_WORDS[value];
}

export function ClassBadge({ value }: { readonly value: ChangeClass }) {
  return (
    <Badge.Root tone={value === "adds" ? "success" : value === "tightens" ? "info" : "warning"} data-testid="proposal-class" data-class={value}>
      {CLASS_WORDS[value]}
    </Badge.Root>
  );
}

/**
 * Core's classification: kept with an adopted proposal (the config it was
 * judged against is gone once adopted), otherwise classified against the
 * project as it is now.
 */
export function classificationOf(proposal: Proposal, config: ProjectConfig): Classification {
  return proposal.classification ?? classifyProposal(proposal, config);
}

/** A rule in words generated from its data by core, its author's description under them, and the raw rule one click away. */
export function RuleWords({ rule, config }: { readonly rule: RuleSpec; readonly config: ProjectConfig }) {
  return (
    <div className="rule-words" data-rule={rule.id}>
      <Text.Root as="p" className="rule-words-text" data-testid="rule-words">
        {describeRule(rule, config)}
      </Text.Root>
      {rule.description && (
        <Text.Root as="p" tone="muted" className="rule-words-note">
          Its author says: {rule.description}
        </Text.Root>
      )}
      <Disclosure.Root className="rule-words-raw">
        <Disclosure.Summary>
          Rule data for <Code.Root>{rule.id}</Code.Root> ({rule.type})
        </Disclosure.Summary>
        <pre className="project-json" data-testid="rule-json">
          {JSON.stringify(rule, null, 2)}
        </pre>
      </Disclosure.Root>
    </div>
  );
}
