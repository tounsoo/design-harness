import { Badge, Button, Card, Code, DataList, Disclosure, Stack, Table, Text, ToggleGroup } from "@tounsoo/todae";
import { useMemo, useState } from "react";
import { ROLE_NAMES, describeRule, flowFacts, rerunExamples, type ConfirmedRole, type ExampleRun, type ProjectConfig, type RoleMapping, type RuleSpec } from "@design-harness/core";
import { formatTime } from "../review/timeline";
import type { PrototypeRecord } from "../store/project-file";
import { BudgetFigure, CapMeterView, PageTypeFigure, RuleFigure, SlotLegend, glyphNote } from "../visual/project-figures";
import { RULE_GROUPS, budgetMeter, capReaders, capsRead, groupRules, projectTimeline, ruleBound, ruleGlyph, ruleGroup, ruleSource, type RuleGroupId } from "../visual/project-model";
import { TaskMaps } from "./ChecksPanel";
import { LayoutsView } from "./LayoutsView";
import { Palette } from "./Palette";
import { StatusBadge } from "./proposal-parts";
import { exampleLabel, humanize } from "./words";

/**
 * The project, read-only, for a designer first, and mostly as pictures:
 * the components a prototype can build with drawn by the project's own
 * library, with the roles the rules know them by; each page type as its
 * slots; the rules in force as cards grouped by what they look at; the
 * tasks' step budgets and the caps as meters. Every picture is drawn from
 * the config or from core's facts, with the same words beside it. The
 * library's role mapping as data, the views and the raw rules sit one step
 * away under their details. Every adopted proposal's examples re-run on
 * demand.
 *
 * The page is about the project. A line about the open prototype is named
 * for it, and is absent when none is open.
 */
export function ProjectView({ config, onOpenProposal, onOpenProposals, prototype, onGoToState }: { readonly config: ProjectConfig; readonly onOpenProposal: (id: string) => void; /** Opens the Proposals tab. */ readonly onOpenProposals?: (() => void) | undefined; readonly prototype?: PrototypeRecord | undefined; /** Goes to a flow state's artboard on the canvas, from a flow map. */ readonly onGoToState?: ((state: string) => void) | undefined }) {
  // Core's facts about the open prototype's flow: each task's routes against its budget.
  const flow = prototype ? flowFacts(config, prototype.prototype) : null;
  const { library, inventories, inputs } = config;
  const open = config.proposals.filter((proposal) => proposal.status === "open").length;
  const ranking = [...inputs.ranking].sort((a, b) => a.rank - b.rank);
  const caps = Object.entries(inputs.caps).sort(([a], [b]) => (a < b ? -1 : 1));
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
        <SectionHead
          id="project-inventories"
          title="What a prototype can build with"
          text={`${inventories.components.length} ${inventories.components.length === 1 ? "component" : "components"} from ${library.package} ${library.version}, each drawn by the library itself. A tag points at a part the rules know by a role. Anything else is a proposal: the agent drafts one when the work needs it.`}
        />
        <Palette config={config} />
        <DataList.Root orientation="horizontal" className="project-facts">
          <Chips term="Layouts" items={inventories.layouts} />
          <Chips term="Flow states" items={inventories.flowStates} />
        </DataList.Root>
        <div className="section-head">
          <Text.Root as="h3">Page types</Text.Root>
          <Text.Root as="p" tone="muted">
            Every page is one of these. A page fills each slot once and puts nothing outside them. The slots are in the order the project lists them, which is not a promise about where each one renders.
          </Text.Root>
        </div>
        <SlotLegend />
        <ul className="page-types" aria-label="Page types">
          {inventories.pageTypes.map((type) => (
            <li key={type.id}>
              <Card.Root className="figure-card">
                <PageTypeFigure type={type}>
                  <Text.Root as="p" tone="muted">
                    <Code.Root>{type.id}</Code.Root>
                  </Text.Root>
                </PageTypeFigure>
              </Card.Root>
            </li>
          ))}
        </ul>
      </section>

      <Rules config={config} onOpenProposal={onOpenProposal} />

      <section aria-labelledby="project-inputs">
        <SectionHead id="project-inputs" title="Tasks and limits" text={`The numbers the rules read: how many steps each task may take, which action matters most, and the project's caps.${prototype && flow ? ` A filled step is one ${prototype.name} takes today; the dashed line is the limit.` : " The dashed line is the limit."}`} />
        <div className="limits">
          <Card.Root className="figure-card" data-testid="project-tasks">
            <Text.Root as="h3" className="figure-title">
              Tasks and their step budgets
            </Text.Root>
            {inputs.tasks.length === 0 && (
              <Text.Root as="p" tone="muted">
                No tasks.
              </Text.Root>
            )}
            <ul className="limit-list">
              {inputs.tasks.map((task) => (
                <li key={task.id} data-task={task.id}>
                  <Text.Root as="h4" className="figure-title">
                    {task.description ?? humanize(task.id)}
                  </Text.Root>
                  <BudgetFigure meter={budgetMeter(task, flow?.tasks.find((item) => item.task === task.id), prototype?.name)} />
                  <Text.Root as="p" tone="muted">
                    Done at <Badge.Root tone="neutral">{humanize(task.successState)}</Badge.Root> <Code.Root>{task.id}</Code.Root>
                  </Text.Root>
                </li>
              ))}
            </ul>
          </Card.Root>
          <Card.Root className="figure-card" data-testid="project-ranking">
            <Text.Root as="h3" className="figure-title">
              Actions, in rank order
            </Text.Root>
            {ranking.length === 0 ? (
              <Text.Root as="p" tone="muted">
                No ranked actions.
              </Text.Root>
            ) : (
              <ol className="ranking">
                {ranking.map((item) => (
                  <li key={item.rank}>
                    <span className="rank" aria-hidden="true">
                      {item.rank}
                    </span>
                    <span>
                      <span className="visually-hidden">{item.rank}. </span>
                      <Text.Root as="span" weight="medium">
                        {item.action}
                      </Text.Root>{" "}
                      <Text.Root as="span" tone="muted">
                        ({item.level})
                      </Text.Root>
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <Text.Root as="p" tone="muted">
              Rank 1 is the one primary action on a page. Each is drawn by the library on the tile of the part that carries its role, above.
            </Text.Root>
            <Text.Root as="h4" className="figure-title">
              Always behind a disclosure
            </Text.Root>
            {inputs.disclosedSections.length === 0 ? (
              <Text.Root as="p" tone="muted">
                No section.
              </Text.Root>
            ) : (
              <ul className="disclosed">
                {inputs.disclosedSections.map((section) => (
                  <li key={section}>{section}</li>
                ))}
              </ul>
            )}
          </Card.Root>
          <Card.Root className="figure-card" data-testid="project-caps">
            <Text.Root as="h3" className="figure-title">
              Caps
            </Text.Root>
            {caps.length === 0 && (
              <Text.Root as="p" tone="muted">
                No caps.
              </Text.Root>
            )}
            <ul className="limit-list">
              {caps.map(([name, cap]) => {
                const readers = capReaders(config, name);
                return (
                  <li key={name}>
                    <CapMeterView name={name} cap={cap}>
                      <Text.Root as="p" tone="muted">
                        <Code.Root>{name}</Code.Root> {readers.length === 0 ? "No rule reads it." : `Read by ${readers.length === 1 ? "the rule" : `${readers.length} rules:`} ${readers.map((rule) => rule.id).join(", ")}.`}
                      </Text.Root>
                    </CapMeterView>
                  </li>
                );
              })}
            </ul>
          </Card.Root>
        </div>
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
      </section>

      <History config={config} onOpenProposal={onOpenProposal} onOpenProposals={onOpenProposals} />

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
              <Fact term="Components" value={inventories.components.join(", ") || "none"} />
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

/**
 * The rules in force as cards, grouped by what a rule looks at. The group
 * and the glyph come from the rule's type and check, so a rule a proposal
 * adds is grouped and drawn the day it is adopted. A glyph shows the rule's
 * shape, not this prototype's page; core's words for the rule are beside it.
 */
function Rules({ config, onOpenProposal }: { readonly config: ProjectConfig; readonly onOpenProposal: (id: string) => void }) {
  const [filter, setFilter] = useState<"all" | RuleGroupId>("all");
  const groups = useMemo(() => groupRules(config.rules), [config.rules]);
  const shown = groups.filter((item) => filter === "all" || item.group.id === filter);
  return (
    <section aria-labelledby="project-rules" data-testid="project-rules">
      <SectionHead id="project-rules" title={`Rules in force (${config.rules.length})`} text="Each rule is checked on every change, by code, the same way every time. A picture shows the kind of thing a rule checks, not a page of yours; open a rule for its id, type and data." />
      <ToggleGroup.Root aria-label="Show rules" value={filter} onValueChange={(value) => setFilter((value ?? "all") as "all" | RuleGroupId)} className="proposals-filter rule-filter">
        <ToggleGroup.Item value="all">{`All (${config.rules.length})`}</ToggleGroup.Item>
        {RULE_GROUPS.map((group) => {
          const count = config.rules.filter((rule) => ruleGroup(rule) === group.id).length;
          return count === 0 ? null : (
            <ToggleGroup.Item key={group.id} value={group.id}>
              {`${group.title} (${count})`}
            </ToggleGroup.Item>
          );
        })}
      </ToggleGroup.Root>
      {shown.map(({ group, rules }) => (
        <div key={group.id} className="rule-group" data-group={group.id}>
          <Text.Root as="h3" className="figure-title">
            {group.title}{" "}
            <Text.Root as="span" tone="muted" className="rule-group-about">
              {rules.length} · {group.about}
            </Text.Root>
          </Text.Root>
          <ul className="rule-cards" aria-label={group.title}>
            {rules.map((rule) => (
              <li key={rule.id}>
                <RuleCard rule={rule} config={config} onOpenProposal={onOpenProposal} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function RuleCard({ rule, config, onOpenProposal }: { readonly rule: RuleSpec; readonly config: ProjectConfig; readonly onOpenProposal: (id: string) => void }) {
  const words = describeRule(rule, config);
  const source = ruleSource(config, rule.id);
  const caps = capsRead(rule);
  return (
    <Card.Root className="rule-card" data-rule={rule.id} data-glyph-note={glyphNote(rule)}>
      <RuleFigure rule={rule} label={ruleGlyph(rule) === "count" || ruleGlyph(rule) === "count-min" ? ruleBound(rule, config) : undefined} />
      <div className="rule-card-body">
        <Text.Root as="p" weight="medium" className="rule-card-lead">
          {rule.description ?? words}
        </Text.Root>
        {rule.description && (
          <Text.Root as="p" tone="muted" className="rule-card-words">
            {words}
          </Text.Root>
        )}
        {caps.map((cap) => (
          <Text.Root as="p" tone="muted" key={cap}>
            Reads the cap <Code.Root>{cap}</Code.Root>, now {config.inputs.caps[cap]?.value ?? "not set"}.
          </Text.Root>
        ))}
        {source && (
          <div className="rule-card-source" data-testid="rule-source">
            <Badge.Root tone="success">From a proposal</Badge.Root>
            <Text.Root as="p" tone="muted">
              Its examples are kept as tests: {[...source.examples.pass.map((example) => `${exampleLabel(example.name)} must pass`), ...source.examples.fail.filter((example) => example.flaggedBy.rule === rule.id).map((example) => `${exampleLabel(example.name)} must fail`)].join("; ")}.
            </Text.Root>
            <Button.Root variant="ghost" onClick={() => onOpenProposal(source.id)}>
              {`Open ${source.title}`}
            </Button.Root>
          </div>
        )}
        <Disclosure.Root className="rule-card-data">
          <Disclosure.Summary>
            <Code.Root>{rule.id}</Code.Root>
          </Disclosure.Summary>
          <Stack.Root gap="condensed" className="project-rule-detail">
            <Text.Root as="p" tone="muted">
              {rule.type}. {glyphNote(rule)}.
            </Text.Root>
            <pre className="project-json">{JSON.stringify(rule, null, 2)}</pre>
          </Stack.Root>
        </Disclosure.Root>
      </div>
    </Card.Root>
  );
}

/** How the project got like this, in five lines: the newest proposals, open ones waiting. The Proposals tab is their home. */
function History({ config, onOpenProposal, onOpenProposals }: { readonly config: ProjectConfig; readonly onOpenProposal: (id: string) => void; readonly onOpenProposals?: (() => void) | undefined }) {
  const { items, more } = projectTimeline(config);
  return (
    <section aria-labelledby="project-proposals" data-testid="project-history">
      <SectionHead id="project-proposals" title={`Proposals (${config.proposals.length})`} text="How the project got like this: the newest changes the agent asked for. The Proposals tab is where you review them." />
      {items.length === 0 ? (
        <Text.Root as="p" tone="muted">
          No proposals yet. A proposal carries an inventory change, the rule that governs it, and examples that must pass and fail; it is adopted only when its rules prove themselves on its examples.
        </Text.Root>
      ) : (
        <ol className="history-line">
          {items.map((item) => (
            <li key={item.id} data-proposal={item.id} data-status={item.status} data-waiting={item.waiting ? "" : undefined}>
              <i className="track-dot" aria-hidden="true" />
              <div className="history-line-body">
                <Stack.Root direction="row" align="center" gap="condensed" wrap>
                  <Button.Root variant="ghost" className="proposals-title" onClick={() => onOpenProposal(item.id)}>
                    {item.title}
                  </Button.Root>
                  <StatusBadge status={item.status} />
                  {item.status === "open" && (
                    <Text.Root as="span" weight="medium">
                      Waiting for you
                    </Text.Root>
                  )}
                </Stack.Root>
                <Text.Root as="p" tone="muted">
                  {item.what} <time dateTime={item.at}>{formatTime(item.at)}</time>
                </Text.Root>
              </div>
            </li>
          ))}
        </ol>
      )}
      {(more > 0 || items.length > 0) && onOpenProposals && (
        <div>
          <Button.Root variant="secondary" onClick={onOpenProposals}>
            {more > 0 ? `All ${config.proposals.length} proposals` : "Open the Proposals tab"}
          </Button.Root>
        </div>
      )}
    </section>
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
