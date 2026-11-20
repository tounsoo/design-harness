import { Card, EmptyState, Link, Stack, Text, ToggleGroup } from "@tounsoo/todae";
import { useState } from "react";
import { PROPOSAL_STATUSES, type ProjectConfig, type Proposal } from "@design-harness/core";
import { fromWords, plainSentence, standingWords, waitsForYou } from "../review/plain";
import { sortProposals } from "../visual/project-model";
import { ProposalLead } from "./ProposalPreview";

type Filter = "all" | "waiting" | "adopted" | "declined";

const FILTERS: readonly { readonly value: Exclude<Filter, "all">; readonly label: string; readonly none: string; readonly has: (proposal: Proposal) => boolean }[] = [
  { value: "waiting", label: "Waiting for you", none: "Nothing is waiting for you", has: waitsForYou },
  { value: "adopted", label: "Accepted", none: "Nothing accepted yet", has: (proposal) => proposal.status === "adopted" },
  { value: "declined", label: "Declined", none: "Nothing declined", has: (proposal) => proposal.status === "declined" },
];

/**
 * Every proposal in the project as a card a designer can read: what it
 * changes in one plain sentence, a small picture where there is something to
 * draw (a part it adds, a new kind of page, a rule about how a page looks),
 * its title as the link to its review, and where it stands in words. The
 * ones waiting for the person come first, then accepted and declined,
 * newest first in each; the filter picks one group. Ids, core's status and
 * its classification are on the review page, in its details.
 */
export function ProposalsView({ config, onOpen }: { readonly config: ProjectConfig; readonly onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const chosen = FILTERS.find((item) => item.value === filter);
  const shown = sortProposals(config.proposals.filter((proposal) => !chosen || chosen.has(proposal)), PROPOSAL_STATUSES);

  return (
    <Stack.Root gap="spacious" className="proposals">
      <Stack.Root gap="condensed">
        <Text.Root as="h1">Proposals</Text.Root>
        <Text.Root as="p" tone="muted" className="proposals-about">
          Changes to the project&apos;s rules and parts. The agent suggests one when a design needs something the project doesn&apos;t allow yet, and you can start one from a rule in the Project view. Nothing changes until you accept it; once you do, it holds for every prototype.
        </Text.Root>
      </Stack.Root>
      <ToggleGroup.Root aria-label="Show proposals" value={filter} onValueChange={(value) => setFilter((value ?? "all") as Filter)} className="proposals-filter">
        {/* One string per label: Todae wraps each text child in its own span, which would split the button's name. */}
        <ToggleGroup.Item value="all">{`All (${config.proposals.length})`}</ToggleGroup.Item>
        {FILTERS.map((item) => (
          <ToggleGroup.Item key={item.value} value={item.value}>
            {`${item.label} (${config.proposals.filter(item.has).length})`}
          </ToggleGroup.Item>
        ))}
      </ToggleGroup.Root>
      {shown.length === 0 ? (
        <EmptyState.Root>
          <EmptyState.Title as="h2">{config.proposals.length === 0 ? "No proposals yet" : (chosen?.none ?? "Nothing here")}</EmptyState.Title>
          <EmptyState.Description>
            {config.proposals.length === 0
              ? "When a design needs a part the project doesn't have, or goes against one of its rules, the agent suggests a change here instead of working around the rule. You can start one yourself from a rule in the Project view. Either way, it waits here for you to decide."
              : "Choose another group to see the others."}
          </EmptyState.Description>
        </EmptyState.Root>
      ) : (
        <ul className="proposal-cards" aria-label="Proposals">
          {shown.map((proposal) => (
            <li key={proposal.id} data-proposal={proposal.id} data-status={proposal.status}>
              <ProposalCard proposal={proposal} config={config} onOpen={() => onOpen(proposal.id)} />
            </li>
          ))}
        </ul>
      )}
    </Stack.Root>
  );
}

function ProposalCard({ proposal, config, onOpen }: { readonly proposal: Proposal; readonly config: ProjectConfig; readonly onOpen: () => void }) {
  const waiting = waitsForYou(proposal);
  return (
    <Card.Root className="proposal-card" data-waiting={waiting ? "" : undefined} data-request={proposal.needsRuleType ? "" : undefined}>
      <div className="proposal-card-body">
        <Text.Root as="p" tone="muted" className="proposal-standing" data-testid="proposal-standing">
          <span className="standing" data-standing={waiting ? "waiting" : proposal.status}>
            {standingWords(proposal)}
          </span>
        </Text.Root>
        <Text.Root as="p" className="proposal-plain" data-testid="proposal-plain">
          {plainSentence(proposal, config)}
        </Text.Root>
        <ProposalLead proposal={proposal} config={config} />
        {/* The title is the way in, and reads as one: a link in looks, a button in what it does. */}
        <Link.Root render={({ className, children }) => (
          <button type="button" className={`${className ?? ""} proposals-title`} onClick={onOpen}>
            {children}
          </button>
        )}>
          {proposal.title}
        </Link.Root>
        <Text.Root as="p" tone="muted">
          {fromWords(proposal)}
        </Text.Root>
      </div>
    </Card.Root>
  );
}
