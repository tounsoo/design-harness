import { Badge, Button, Code, DataList, Disclosure, Stack, Table, Text } from "@tounsoo/todae";
import { useState } from "react";
import { ROLE_NAMES, describeRule, flowFacts, rerunExamples, type ConfirmedRole, type ExampleRun, type ProjectConfig, type Proposal, type RoleMapping } from "@design-harness/core";
import { formatTime } from "../review/timeline";
import type { PrototypeRecord } from "../store/project-file";
import { TaskMaps } from "./ChecksPanel";
import { LayoutsView } from "./LayoutsView";

/**
 * The project, read-only, for a designer first: what a prototype here can
 * use, the open spec prototype's layouts drawn before their data, the rules
 * in plain words, and the tasks and limits they read. The library's role
 * mapping, the views and the raw rules sit one step away under their
 * details. Every adopted proposal's examples re-run on demand.
 */
export function ProjectView({ config, onOpenProposal, prototype, onGoToState }: { readonly config: ProjectConfig; readonly onOpenProposal: (id: string) => void; readonly prototype?: PrototypeRecord | undefined; /** Goes to a flow state's artboard on the canvas, from a flow map. */ readonly onGoToState?: ((state: string) => void) | undefined }) {
  // Core's facts about the open prototype's flow: each task's routes against its budget.
  const flow = prototype ? flowFacts(config, prototype.prototype) : null;
  const { library, inventories, inputs } = config;
  const open = config.proposals.filter((proposal) => proposal.status === "open").length;
  return (
    <Stack.Root gap="spacious" className="project">
      <div className="project-intro">
        <Text.Root as="span" variant="label">
          Project
        </Text.Root>
        <Text.Root as="h1">{config.name}</Text.Root>
        <Text.Root as="p" tone="muted">
          The parts and rules every prototype in {config.name} follows. It changes only through proposals you approve.
        </Text.Root>
      </div>

      <ul className="project-summary" aria-label="At a glance">
        <Stat value={inventories.components.length} label="components to build with" />
        <Stat value={inventories.layouts.length} label="layouts" />
        <Stat value={config.rules.length} label="rules checked on every change" />
        <Stat value={open} label={open === 1 ? "proposal waiting for you" : "proposals waiting for you"} />
      </ul>

      {prototype?.prototype.format === "spec" && <LayoutsView config={config} record={prototype} />}

      <section aria-labelledby="project-inventories">
        <SectionHead id="project-inventories" title="What a prototype can use" text="A prototype draws only these. Anything else is a proposal: the agent drafts one when the work needs it." />
        <DataList.Root orientation="horizontal" className="project-facts">
          <Chips term="Components" items={inventories.components} />
          <Chips term="Layouts" items={inventories.layouts} />
          <Chips term="Flow states" items={inventories.flowStates} />
        </DataList.Root>
        <Text.Root as="h3">Page types</Text.Root>
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

      <section aria-labelledby="project-rules">
        <SectionHead id="project-rules" title={`Rules in force (${config.rules.length})`} text="Each rule is checked on every change, by code, the same way every time. Open one for its id, type and data." />
        <ul className="project-rules">
          {config.rules.map((rule) => (
            <li key={rule.id}>
              <Disclosure.Root>
                <Disclosure.Summary>{rule.description ?? describeRule(rule, config)}</Disclosure.Summary>
                <Stack.Root gap="condensed" className="project-rule-detail">
                  <Text.Root as="p" tone="muted">
                    <Code.Root>{rule.id}</Code.Root> {rule.type}
                  </Text.Root>
                  <pre className="project-json">{JSON.stringify(rule, null, 2)}</pre>
                </Stack.Root>
              </Disclosure.Root>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="project-inputs">
        <SectionHead id="project-inputs" title="Tasks and limits" text="What the rules read: the tasks people do and how many steps each may take, which action matters most, and the project's caps." />
        <Table.Root className="project-table">
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Task</Table.HeaderCell>
              <Table.HeaderCell>Done when</Table.HeaderCell>
              <Table.HeaderCell>Max steps</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {inputs.tasks.map((task) => (
              <Table.Row key={task.id}>
                <Table.Cell>
                  {task.description ?? task.id} <Code.Root>{task.id}</Code.Root>
                </Table.Cell>
                <Table.Cell>{task.successState}</Table.Cell>
                <Table.Cell>{task.maxSteps}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
        {flow && prototype && flow.tasks.length > 0 && (
          <div className="project-flow" data-testid="project-flow">
            <Text.Root as="h3" className="project-flow-title">
              Routes in {prototype.name}
            </Text.Root>
            <Text.Root as="p" tone="muted">
              Each task&apos;s routes through the open prototype&apos;s flow. The longest is numbered against the task&apos;s max steps; a dashed state has no scenario yet.
            </Text.Root>
            <TaskMaps flow={flow} onGoToState={onGoToState} />
          </div>
        )}
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

      <section aria-labelledby="project-proposals">
        <SectionHead id="project-proposals" title={`Proposals (${config.proposals.length})`} text="Changes the agent asked for. Open the Proposals tab to review them." />
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

      <Disclosure.Root className="project-technical">
        <Disclosure.Summary>Technical details: the library, its roles and the views</Disclosure.Summary>
        <Stack.Root gap="spacious" className="project-technical-body">
          <Text.Root as="p" tone="muted">
            Project <Code.Root>{config.id}</Code.Root>, config schema {config.schemaVersion}.
          </Text.Root>
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
                  {library.confirmed && <Table.HeaderCell>Confirmed</Table.HeaderCell>}
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
                    {library.confirmed && <Table.Cell data-testid={`confirmed-${role}`}>{confirmedText(library.confirmed.roles.find((entry) => entry.role === role))}</Table.Cell>}
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
            {library.confirmed && (
              <Text.Root as="p" tone="muted" data-testid="confirmed-exclusion">
                {library.confirmed.exclusion.decision === "none"
                  ? "No style props are excluded."
                  : `${library.confirmed.exclusion.props.length} style props are excluded, ${library.confirmed.exclusion.decision === "accepted" ? "as core drafted them" : `changed from core's draft: ${library.confirmed.exclusion.why}`}.`}
              </Text.Root>
            )}
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
        </Stack.Root>
      </Disclosure.Root>
    </Stack.Root>
  );
}

function SectionHead({ id, title, text }: { readonly id: string; readonly title: string; readonly text: string }) {
  return (
    <div className="section-head">
      <Text.Root as="h2" id={id}>
        {title}
      </Text.Root>
      <Text.Root as="p" tone="muted">
        {text}
      </Text.Root>
    </div>
  );
}

function Stat({ value, label }: { readonly value: number; readonly label: string }) {
  return (
    <li className="project-stat">
      <span className="project-stat-value">{value}</span>
      <Text.Root as="span" tone="muted">
        {label}
      </Text.Root>
    </li>
  );
}

function Chips({ term, items }: { readonly term: string; readonly items: readonly string[] }) {
  return (
    <DataList.Item>
      <DataList.Term>{term}</DataList.Term>
      <DataList.Details>
        {items.length === 0 ? (
          "none"
        ) : (
          <Stack.Root as="ul" direction="row" gap="condensed" wrap className="project-chips">
            {items.map((item) => (
              <li key={item}>
                <Badge.Root tone="neutral">{item}</Badge.Root>
              </li>
            ))}
          </Stack.Root>
        )}
      </DataList.Details>
    </DataList.Item>
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

/** How a role was decided when the library was onboarded: as core drafted it, or changed, with the person's reason. */
function confirmedText(entry: ConfirmedRole | undefined): string {
  if (!entry) return "";
  return entry.decision === "accepted" ? `As drafted (${entry.confidence} confidence)` : `Changed from the draft: ${entry.why}`;
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
