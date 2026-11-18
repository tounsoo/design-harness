import { Badge, Button, Code, DataList, Disclosure, Stack, Table, Text } from "@tounsoo/todae";
import { useState } from "react";
import { ROLE_NAMES, rerunExamples, type ExampleRun, type ProjectConfig, type Proposal, type RoleMapping } from "@design-harness/core";
import { formatTime } from "../review/timeline";
import type { PrototypeRecord } from "../store/project-file";
import { LayoutsView } from "./LayoutsView";

/** The project, read-only: library and roles, inventories, the open spec prototype's layouts, rule inputs, views, rules, proposals, and their examples re-run on demand. */
export function ProjectView({ config, onOpenProposal, prototype }: { readonly config: ProjectConfig; readonly onOpenProposal: (id: string) => void; readonly prototype?: PrototypeRecord | undefined }) {
  const { library, inventories, inputs } = config;
  return (
    <Stack.Root gap="spacious" className="project">
      <Stack.Root gap="condensed">
        <Text.Root as="h1">{config.name}</Text.Root>
        <Text.Root as="p" tone="muted">
          Project <Code.Root>{config.id}</Code.Root>, config schema {config.schemaVersion}. Read-only in this version: proposals change the project.
        </Text.Root>
      </Stack.Root>

      <section aria-labelledby="project-library">
        <Text.Root as="h2" id="project-library">
          Component library
        </Text.Root>
        <DataList.Root orientation="horizontal" className="project-facts">
          <Fact term="Package" value={`${library.package} ${library.version}`} />
          <Fact term="React" value={library.react} />
          <Fact term="Stylesheets" value={(library.stylesheets ?? []).join(", ") || "none"} />
          <Fact term="Scheme attribute" value={library.schemeAttribute ?? "none (color-scheme only)"} />
        </DataList.Root>
        <Table.Root className="project-table">
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Role</Table.HeaderCell>
              <Table.HeaderCell>Parts</Table.HeaderCell>
              <Table.HeaderCell>Prop</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {ROLE_NAMES.map((role) => (
              <Table.Row key={role}>
                <Table.Cell>
                  <Code.Root>{role}</Code.Root>
                </Table.Cell>
                <Table.Cell>{library.roles[role].components.join(", ")}</Table.Cell>
                <Table.Cell>{propText(library.roles[role])}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </section>

      <section aria-labelledby="project-inventories">
        <Text.Root as="h2" id="project-inventories">
          Inventories
        </Text.Root>
        <DataList.Root orientation="horizontal" className="project-facts">
          <Fact term="Components" value={inventories.components.join(", ")} />
          <Fact term="Layouts" value={inventories.layouts.join(", ") || "none"} />
          <Fact term="Flow states" value={inventories.flowStates.join(", ") || "none"} />
        </DataList.Root>
        <Table.Root className="project-table">
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Page type</Table.HeaderCell>
              <Table.HeaderCell>Kind</Table.HeaderCell>
              <Table.HeaderCell>Slots</Table.HeaderCell>
              <Table.HeaderCell>Chrome</Table.HeaderCell>
              <Table.HeaderCell>Primary slot</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {inventories.pageTypes.map((type) => (
              <Table.Row key={type.id}>
                <Table.Cell>
                  <Code.Root>{type.id}</Code.Root>
                </Table.Cell>
                <Table.Cell>{type.kind}</Table.Cell>
                <Table.Cell>{type.slots.join(", ")}</Table.Cell>
                <Table.Cell>{type.chrome.join(", ") || "none"}</Table.Cell>
                <Table.Cell>{type.kind === "action" ? type.primarySlot : "none"}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </section>

      {prototype?.prototype.format === "spec" && <LayoutsView config={config} record={prototype} />}

      <section aria-labelledby="project-inputs">
        <Text.Root as="h2" id="project-inputs">
          Rule inputs
        </Text.Root>
        <Table.Root className="project-table">
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Task</Table.HeaderCell>
              <Table.HeaderCell>Success state</Table.HeaderCell>
              <Table.HeaderCell>Max steps</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {inputs.tasks.map((task) => (
              <Table.Row key={task.id}>
                <Table.Cell>
                  <Code.Root>{task.id}</Code.Root>
                  {task.description ? ` ${task.description}` : ""}
                </Table.Cell>
                <Table.Cell>{task.successState}</Table.Cell>
                <Table.Cell>{task.maxSteps}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
        <DataList.Root orientation="horizontal" className="project-facts">
          <Fact term="Ranking" value={[...inputs.ranking].sort((a, b) => a.rank - b.rank).map((item) => `${item.rank}. ${item.action} (${item.level})`).join("; ") || "none"} />
          <Fact term="Disclosed sections" value={inputs.disclosedSections.join(", ") || "none"} />
          {Object.entries(inputs.caps)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([name, cap]) => (
              <Fact key={name} term={name} value={`${cap.value} (stricter when ${cap.stricter})${cap.description ? `. ${cap.description}` : ""}`} />
            ))}
        </DataList.Root>
      </section>

      <section aria-labelledby="project-views">
        <Text.Root as="h2" id="project-views">
          Views
        </Text.Root>
        <DataList.Root orientation="horizontal" className="project-facts">
          {config.views.map((view) => (
            <Fact key={view.name} term={view.name} value={`${view.width} by ${view.height}, ${view.scheme}`} />
          ))}
        </DataList.Root>
      </section>

      <section aria-labelledby="project-rules">
        <Text.Root as="h2" id="project-rules">
          Rules in force ({config.rules.length})
        </Text.Root>
        <ul className="project-rules">
          {config.rules.map((rule) => (
            <li key={rule.id}>
              <Disclosure.Root>
                <Disclosure.Summary>
                  <Code.Root>{rule.id}</Code.Root> <Text.Root as="span" tone="muted">{rule.type}</Text.Root>
                </Disclosure.Summary>
                {rule.description && <Text.Root as="p">{rule.description}</Text.Root>}
                <pre className="project-json">{JSON.stringify(rule, null, 2)}</pre>
              </Disclosure.Root>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="project-proposals">
        <Text.Root as="h2" id="project-proposals">
          Proposals ({config.proposals.length})
        </Text.Root>
        {config.proposals.length === 0 ? (
          <Text.Root as="p" tone="muted">
            No proposals yet. A proposal carries an inventory change, the rule that governs it, and examples that must pass and fail; it is adopted only when its rules prove themselves on its examples.
          </Text.Root>
        ) : (
          <ul className="project-rules">
            {config.proposals.map((proposal) => (
              <ProposalItem key={proposal.id} proposal={proposal} onOpen={() => onOpenProposal(proposal.id)} />
            ))}
          </ul>
        )}
      </section>

      <Regression config={config} onOpenProposal={onOpenProposal} />
    </Stack.Root>
  );
}

function Fact({ term, value }: { readonly term: string; readonly value: string }) {
  return (
    <DataList.Item>
      <DataList.Term>{term}</DataList.Term>
      <DataList.Details>{value}</DataList.Details>
    </DataList.Item>
  );
}

function propText(mapping: RoleMapping): string {
  if (!mapping.prop) return "any";
  const values = mapping.prop.values.map((value) => JSON.stringify(value)).join(" or ");
  return `${mapping.prop.name} = ${values}${mapping.prop.whenMissing ? ", or none" : ""}`;
}

function ProposalItem({ proposal, onOpen }: { readonly proposal: Proposal; readonly onOpen: () => void }) {
  const tone = proposal.status === "adopted" ? "success" : proposal.status === "declined" ? "critical" : proposal.status === "approved" ? "info" : "neutral";
  return (
    <li>
      <Disclosure.Root>
        <Disclosure.Summary>
          <Badge.Root tone={tone}>{proposal.status}</Badge.Root> {proposal.title} <Code.Root>{proposal.id}</Code.Root>
        </Disclosure.Summary>
        <Text.Root as="p">{proposal.reason}</Text.Root>
        <Text.Root as="p" tone="muted">
          {proposal.history.map((entry) => `${entry.status} ${entry.at}${entry.by ? ` by ${entry.by}` : ""}`).join(" → ")}
        </Text.Root>
        <Text.Root as="p" tone="muted">
          {proposal.inventory.length} inventory changes, {proposal.rules.add.length} rules added, {proposal.rules.remove.length} removed, {proposal.examples.pass.length} passing and {proposal.examples.fail.length} failing examples.
        </Text.Root>
        <Button.Root variant="secondary" onClick={onOpen}>
          {`Review ${proposal.id}`}
        </Button.Root>
      </Disclosure.Root>
    </li>
  );
}

/**
 * Every adopted proposal's examples re-run, on demand, with core's
 * rerunExamples against the config as it is now: passing examples must still
 * pass every rule, failing ones must still be flagged by their rule. Rendered
 * rules read the snapshots stored with each example when it was adopted, so
 * nothing is rendered again and the result is the same after a reload.
 */
function Regression({ config, onOpenProposal }: { readonly config: ProjectConfig; readonly onOpenProposal: (id: string) => void }) {
  const [runs, setRuns] = useState<{ readonly at: string; readonly runs: readonly ExampleRun[] } | null>(null);
  const adopted = config.proposals.filter((proposal) => proposal.status === "adopted");
  const broken = runs?.runs.filter((run) => !run.ok) ?? [];
  return (
    <section aria-labelledby="project-regression" data-testid="regression">
      <Text.Root as="h2" id="project-regression">
        Adopted proposals&apos; examples
      </Text.Root>
      <Text.Root as="p" tone="muted">
        Each adopted proposal keeps its examples as regression tests, with the snapshots it was adopted on. Re-run them to see whether the project as it is now still holds them.
      </Text.Root>
      <div>
        <Button.Root variant="secondary" onClick={() => setRuns({ at: new Date().toISOString(), runs: rerunExamples(config) })} disabled={adopted.length === 0}>
          Re-run every adopted proposal&apos;s examples
        </Button.Root>
      </div>
      {adopted.length === 0 && (
        <Text.Root as="p" tone="muted">
          No proposal is adopted yet.
        </Text.Root>
      )}
      {runs && (
        <>
          <Text.Root as="p" data-testid="regression-summary" aria-live="polite">
            {broken.length === 0 ? `All ${runs.runs.length} examples behave` : `${broken.length} of ${runs.runs.length} examples no longer behave`}, re-run <time dateTime={runs.at}>{formatTime(runs.at)}</time>.
          </Text.Root>
          <Table.Root className="project-table" aria-label="Re-run examples">
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell>Proposal</Table.HeaderCell>
                <Table.HeaderCell>Example</Table.HeaderCell>
                <Table.HeaderCell>Must</Table.HeaderCell>
                <Table.HeaderCell>Result</Table.HeaderCell>
                <Table.HeaderCell>What core says</Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {runs.runs.map((run) => (
                <Table.Row key={`${run.proposal}/${run.example}`} data-example={run.example} data-ok={run.ok ? "" : undefined}>
                  <Table.Cell>
                    <Button.Root variant="ghost" onClick={() => onOpenProposal(run.proposal)}>
                      {run.proposal}
                    </Button.Root>
                  </Table.Cell>
                  <Table.Cell>
                    <Code.Root>{run.example}</Code.Root>
                  </Table.Cell>
                  <Table.Cell>{run.expect}</Table.Cell>
                  <Table.Cell>
                    <Badge.Root tone={run.retiredBy ? "neutral" : run.ok ? "success" : "critical"}>{run.retiredBy ? "retired" : run.ok ? "behaves" : "no longer behaves"}</Badge.Root>
                  </Table.Cell>
                  <Table.Cell>{run.detail}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </>
      )}
    </section>
  );
}
