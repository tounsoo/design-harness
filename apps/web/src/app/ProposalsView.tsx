import { Button, Code, EmptyState, Stack, Table, Text, ToggleGroup } from "@tounsoo/todae";
import { useState } from "react";
import { PROPOSAL_STATUSES, type ProjectConfig, type ProposalStatus } from "@design-harness/core";
import { draftedBy, formatTime } from "../review/timeline";
import { ClassBadge, StatusBadge, classificationOf } from "./proposal-parts";

type Filter = "all" | ProposalStatus;

/**
 * Every proposal in the project: its title, status, core's classification,
 * who drafted it and when, filtered by status. Open proposals come first,
 * then approved, adopted and declined, newest first in each.
 */
export function ProposalsView({ config, onOpen }: { readonly config: ProjectConfig; readonly onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const count = (status: ProposalStatus) => config.proposals.filter((proposal) => proposal.status === status).length;
  const order = (status: ProposalStatus) => PROPOSAL_STATUSES.indexOf(status);
  const shown = config.proposals
    .filter((proposal) => filter === "all" || proposal.status === filter)
    .sort((a, b) => order(a.status) - order(b.status) || (draftedBy(b).at < draftedBy(a).at ? -1 : draftedBy(b).at > draftedBy(a).at ? 1 : 0));

  return (
    <Stack.Root gap="spacious" className="proposals">
      <Stack.Root gap="condensed">
        <Text.Root as="h1">Proposals</Text.Root>
        <Text.Root as="p" tone="muted">
          What the agent asks to change in the project&apos;s inventories and rules. Each carries the rule that would govern the change and examples that must pass and fail. Only you can approve, decline or adopt one; once adopted, its rules run on every prototype.
        </Text.Root>
      </Stack.Root>
      <ToggleGroup.Root aria-label="Show proposals" value={filter} onValueChange={(value) => setFilter((value ?? "all") as Filter)} className="proposals-filter">
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
          <EmptyState.Title as="h2">{config.proposals.length === 0 ? "No proposals yet" : `No ${filter} proposals`}</EmptyState.Title>
          <EmptyState.Description>
            {config.proposals.length === 0
              ? "When a request needs something the inventories lack or a rule forbids, the agent drafts a proposal instead of working around the check. It shows up here for you to review."
              : "Choose another status to see the others."}
          </EmptyState.Description>
        </EmptyState.Root>
      ) : (
        <Table.Root className="proposals-table" aria-label="Proposals">
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Proposal</Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell>Change</Table.HeaderCell>
              <Table.HeaderCell>Drafted</Table.HeaderCell>
              <Table.HeaderCell>Examples</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {shown.map((proposal) => {
              const drafted = draftedBy(proposal);
              return (
                <Table.Row key={proposal.id} data-proposal={proposal.id} data-status={proposal.status}>
                  <Table.Cell>
                    <Stack.Root gap="none" align="start">
                      <Button.Root variant="ghost" onClick={() => onOpen(proposal.id)} className="proposals-title">
                        {proposal.title}
                      </Button.Root>
                      <Code.Root>{proposal.id}</Code.Root>
                    </Stack.Root>
                  </Table.Cell>
                  <Table.Cell>
                    <StatusBadge status={proposal.status} />
                  </Table.Cell>
                  <Table.Cell>
                    <ClassBadge value={classificationOf(proposal, config).class} />
                  </Table.Cell>
                  <Table.Cell>
                    by {drafted.by}, <time dateTime={drafted.at}>{formatTime(drafted.at)}</time>
                  </Table.Cell>
                  <Table.Cell>
                    {proposal.examples.pass.length} pass · {proposal.examples.fail.length} fail
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Root>
      )}
    </Stack.Root>
  );
}
