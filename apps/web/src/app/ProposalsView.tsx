import {
  Button,
  Card,
  Code,
  EmptyState,
  Stack,
  Text,
  ToggleGroup,
} from "@tounsoo/todae";
import { Check, X } from "lucide-react";
import { useState } from "react";
import {
  PROPOSAL_STATUSES,
  onlyRemovesRules,
  type ProjectConfig,
  type Proposal,
  type ProposalStatus,
} from "@design-harness/core";
import { draftedBy, formatTime } from "../review/timeline";
import { changeLine, sortProposals } from "../visual/project-model";
import {
  ClassBadge,
  RequestBadge,
  StatusBadge,
  classificationOf,
} from "./proposal-parts";
import { ProposalLead } from "./ProposalPreview";

type Filter = "all" | ProposalStatus;

/**
 * Every proposal in the project as a card that leads with what it would put
 * in the project: the part it adds drawn live, a cap before and after, a new
 * page type's slots. Under the picture: its title, where it stands, core's
 * classification on the scale, what changes in a line, its examples, and who
 * drafted it and when. Open proposals come first, then approved, adopted and
 * declined, newest first in each; the filter picks a status.
 */
export function ProposalsView({
  config,
  onOpen,
}: {
  readonly config: ProjectConfig;
  readonly onOpen: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const count = (status: ProposalStatus) =>
    config.proposals.filter((proposal) => proposal.status === status).length;
  const shown = sortProposals(
    config.proposals.filter(
      (proposal) => filter === "all" || proposal.status === filter,
    ),
    PROPOSAL_STATUSES,
  );

  return (
    <Stack.Root gap="spacious" className="proposals">
      <Stack.Root gap="condensed">
        <Text.Root as="h1">Proposals</Text.Root>
        <Text.Root as="p" tone="muted">
          Changes to the project: ones the agent asks for, such as a new
          component or layout, and ones you start from a rule&apos;s card in the
          Project view, to remove or change that rule. Each comes with examples
          that show it working. Only you can approve, decline or adopt one; once
          adopted, it holds for every prototype.
        </Text.Root>
      </Stack.Root>
      <ToggleGroup.Root
        aria-label="Show proposals"
        value={filter}
        onValueChange={(value) => setFilter((value ?? "all") as Filter)}
        className="proposals-filter"
      >
        {/* One string per label: Todae wraps each text child in its own span, which would split the button's name. */}
        <ToggleGroup.Item value="all">{`All (${config.proposals.length})`}</ToggleGroup.Item>
        {PROPOSAL_STATUSES.map((status) => (
          <ToggleGroup.Item key={status} value={status}>
            {`${(status[0] ?? "").toUpperCase()}${status.slice(1)} (${count(status)})`}
          </ToggleGroup.Item>
        ))}
      </ToggleGroup.Root>
      {shown.length === 0 ? (
        <EmptyState.Root>
          <EmptyState.Title as="h2">
            {config.proposals.length === 0
              ? "No proposals yet"
              : `No ${filter} proposals`}
          </EmptyState.Title>
          <EmptyState.Description>
            {config.proposals.length === 0
              ? "When a request needs something the inventories lack or a rule forbids, the agent drafts a proposal instead of working around the check. You start one yourself from a rule's card in the Project view, to remove or change that rule. Either shows up here for you to review."
              : "Choose another status to see the others."}
          </EmptyState.Description>
        </EmptyState.Root>
      ) : (
        <ul className="proposal-cards" aria-label="Proposals">
          {shown.map((proposal) => (
            <li
              key={proposal.id}
              data-proposal={proposal.id}
              data-status={proposal.status}
            >
              <ProposalCard
                proposal={proposal}
                config={config}
                onOpen={() => onOpen(proposal.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </Stack.Root>
  );
}

/** Where a proposal stands, beside its status: what it waits for, or since when it holds. */
function standing(proposal: Proposal): string {
  const last = proposal.history.at(-1);
  switch (proposal.status) {
    case "open":
      return "Waiting for you";
    case "approved":
      return "Approved: waiting for you to adopt it";
    case "adopted":
      return `In force since ${formatTime(last?.at ?? "")}`;
    case "declined":
      return last?.note ? `“${last.note}”` : "Declined";
  }
}

function ProposalCard({
  proposal,
  config,
  onOpen,
}: {
  readonly proposal: Proposal;
  readonly config: ProjectConfig;
  readonly onOpen: () => void;
}) {
  const drafted = draftedBy(proposal);
  const request = proposal.needsRuleType;
  const waiting = proposal.status === "open" || proposal.status === "approved";
  return (
    <Card.Root
      className="proposal-card"
      data-waiting={waiting ? "" : undefined}
    >
      <ProposalLead proposal={proposal} config={config} />
      <div className="proposal-card-body">
        <Button.Root
          variant="ghost"
          onClick={onOpen}
          className="proposals-title"
        >
          {proposal.title}
        </Button.Root>
        <Stack.Root direction="row" align="center" gap="condensed" wrap>
          <StatusBadge status={proposal.status} />
          <Text.Root
            as="span"
            weight={waiting ? "medium" : "regular"}
            tone={waiting ? "default" : "muted"}
            className="proposal-standing"
            data-testid="proposal-standing"
          >
            {standing(proposal)}
          </Text.Root>
        </Stack.Root>
        {request ? (
          <RequestBadge />
        ) : (
          <ClassBadge value={classificationOf(proposal, config).class} />
        )}
        <Text.Root as="p">{changeLine(proposal)}</Text.Root>
        {!request &&
        onlyRemovesRules(proposal) &&
        proposal.examples.pass.length + proposal.examples.fail.length === 0 ? (
          <Text.Root
            as="p"
            tone="muted"
            className="proposal-examples"
            data-testid="proposal-examples"
          >
            No examples needed: it only removes.
          </Text.Root>
        ) : (
          <Text.Root
            as="p"
            className="proposal-examples"
            data-testid="proposal-examples"
          >
            <span className="proposal-example" data-expect="pass">
              <Check aria-hidden="true" />{" "}
              {request ? request.pass.length : proposal.examples.pass.length}{" "}
              must pass
            </span>
            <span className="proposal-example" data-expect="fail">
              <X aria-hidden="true" />{" "}
              {request ? request.fail.length : proposal.examples.fail.length}{" "}
              must fail{request ? ", in words" : ""}
            </span>
          </Text.Root>
        )}
        <Text.Root as="p" tone="muted">
          By {drafted.by},{" "}
          <time dateTime={drafted.at}>{formatTime(drafted.at)}</time>{" "}
          <Code.Root className="proposals-id">{proposal.id}</Code.Root>
        </Text.Root>
      </div>
    </Card.Root>
  );
}
