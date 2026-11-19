import { Badge, Button, Card, Code, DataList, Disclosure, Loader, Stack, Text } from "@tounsoo/todae";
import { CircleAlert, CircleCheck, CodeXml, Crosshair, Sparkles, TriangleAlert } from "lucide-react";
import { useContext, useMemo } from "react";
import { describeRule, type Finding, type FlowFacts, type ProjectConfig, type RenderedSnapshot, type RuleReport, type View } from "@design-harness/core";
import type { SessionState } from "../runtime/session";
import { frameKey } from "../runtime/session";
import { describeOutline, planOutline } from "../runtime/tags";
import { EvidenceFigure } from "../visual/figures";
import { FlowMap } from "../visual/FlowMap";
import { VisualContext } from "../visual/parts";
import { findingPlace, ruleLead, scenarioLabel, viewLabel } from "./words";

type Props = {
  readonly state: SessionState;
  /** The project's config, to say each rule in plain words. */
  readonly config?: ProjectConfig;
  readonly measuredCount: number;
  readonly selected: Finding | null;
  readonly onSelect: (finding: Finding | null) => void;
  /** Puts a message asking the agent to fix a finding into the chat, for the person to edit and send. */
  readonly onFix?: (finding: Finding) => void;
  /** Opens a finding's file at its line in the code view. */
  readonly onShowCode?: (finding: Finding) => void;
  /** Puts a message about a finding outside the inventories into the chat; absent when there is no key. */
  readonly onAsk?: (finding: Finding) => void;
  /** Whether a finding is about something outside the inventories, which a proposal could add. */
  readonly proposable?: (finding: Finding) => boolean;
  /** Core's facts about the flow: each task's routes, and which scenarios show each state. */
  readonly flow?: FlowFacts | null;
  /** Goes to the artboard of a flow state, from a flow map. */
  readonly onGoToState?: (state: string) => void;
};

/**
 * Core's report for a designer. It leads with a summary in plain words and
 * the things to fix, each with the rule's lead, core's message word for word
 * beside it as the caption of its evidence figure (`visual/figures.tsx`:
 * what the rule measured, drawn from core's evidence), "Show me" (its
 * elements outlined in every frame that draws them, with a line saying
 * where, or its line in the code), "Show in code" and "Ask the agent to
 * fix". Every rule in force, in core's order with its
 * id, type and findings, and core's report as JSON, sit one step away under
 * Details. The panel decides nothing and hides nothing: it only orders what
 * core said.
 */
export function ChecksPanel({ state, measuredCount, selected, onSelect, onShowCode, onFix, onAsk, proposable, config, flow, onGoToState }: Props) {
  const report = state.report;
  const visual = useMemo(() => ({ scenarios: flow ? Object.fromEntries(flow.states.map((item) => [item.state, item.scenarios])) : undefined, onOpenState: onGoToState }), [flow, onGoToState]);
  if (!report) {
    return (
      <Stack.Root direction="row" align="center" gap="condensed" className="checks-waiting">
        <Loader.Root aria-label="Checking" />
        <Text.Root as="p">Checking the prototype…</Text.Root>
      </Stack.Root>
    );
  }
  const counts = { pass: 0, fail: 0, "not-run": 0 };
  for (const rule of report.rules) counts[rule.status] += 1;
  const frames = state.frames.length;
  const failing = report.rules.filter((rule) => rule.status === "fail" && rule.findings.length > 0);
  const toFix = failing.filter((rule) => !cannotTell(rule));
  const unknown = failing.filter(cannotTell);
  const tone = toFix.length > 0 ? "critical" : unknown.length > 0 ? "warning" : report.status === "pass" ? "success" : "neutral";
  const headline =
    toFix.length > 0
      ? `${toFix.length} ${toFix.length === 1 ? "thing" : "things"} to fix`
      : unknown.length > 0
        ? `${unknown.length} ${unknown.length === 1 ? "rule" : "rules"} could not be checked`
        : report.status === "pass"
          ? "Everything follows the project's rules"
          : "Checking the rendered pages…";
  // Where the selected finding's elements are outlined on the canvas, in words.
  const outline = outlineOf(selected, state);
  const progress = state.measured ? `${report.rules.length} rules checked, on ${measuredCount} of ${frames} frames.` : `Measuring the frames: ${countAnswered(state)} of ${frames} answered. Rules about the rendered page wait for every frame.`;
  return (
    <VisualContext value={visual}>
    <div className="checks" data-revision={state.revision} data-measured={state.measured ? "" : undefined}>
      <div className="checks-summary" data-tone={tone} data-testid="checks-summary">
        <span className="checks-summary-icon" aria-hidden="true">
          {tone === "success" ? <CircleCheck /> : tone === "critical" ? <CircleAlert /> : tone === "warning" ? <TriangleAlert /> : <Loader.Root aria-hidden="true" />}
        </span>
        <div className="checks-summary-text">
          <Text.Root as="h2" className="checks-headline" data-testid="checks-headline">
            {headline}
          </Text.Root>
          <Text.Root as="p" tone="muted" className="checks-progress" aria-live="polite">
            {progress}
          </Text.Root>
        </div>
      </div>

      {failing.length > 0 && (
        <ol className="fixes" aria-label="Things to fix">
          {[...toFix, ...unknown].map((rule) => (
            <FixItem key={rule.rule} rule={rule} config={config} state={state} selected={selected} onSelect={onSelect} outline={outline} {...(onShowCode ? { onShowCode } : {})} {...(onFix ? { onFix } : {})} {...(onAsk && proposable ? { onAsk, proposable } : {})} />
          ))}
        </ol>
      )}

      <Disclosure.Root className="checks-details" data-testid="checks-details">
        <Disclosure.Summary>{`Details: all ${report.rules.length} rules`}</Disclosure.Summary>
        <Stack.Root gap="condensed" className="checks-details-body">
          <Stack.Root direction="row" align="center" gap="condensed" wrap>
            <Text.Root as="span" tone="muted">
              Core's verdict
            </Text.Root>
            <Badge.Root tone={report.status === "pass" ? "success" : report.status === "fail" ? "critical" : "neutral"} data-testid="report-status">
              {report.status}
            </Badge.Root>
            <Text.Root as="span" tone="muted">
              {counts.pass} pass · {counts.fail} fail · {counts["not-run"]} not run · revision {state.revision}
            </Text.Root>
          </Stack.Root>
          <ol className="checks-rules" aria-label="Rules in force">
            {report.rules.map((rule) => (
              <RuleItem key={rule.rule} rule={rule} selected={selected} onSelect={onSelect} {...(onShowCode ? { onShowCode } : {})} outline={outline} {...(onAsk && proposable ? { onAsk, proposable } : {})} words={wordsFor(rule, config)} flow={stepBudget(rule, config) ? flow : null} />
            ))}
          </ol>
          <Disclosure.Root className="checks-json">
            <Disclosure.Summary>Core's report as JSON</Disclosure.Summary>
            <pre className="project-json" data-testid="report-json">
              {JSON.stringify(report, null, 2)}
            </pre>
          </Disclosure.Root>
        </Stack.Root>
      </Disclosure.Root>
    </div>
    </VisualContext>
  );
}

/** True for a rule that measures each task's routes against its step budget: the flow map sits with it. */
function stepBudget(rule: RuleReport, config: ProjectConfig | undefined): boolean {
  const spec = config?.rules.find((item) => item.id === rule.rule);
  return spec?.type === "flow" && spec.check === "step-budget";
}

/** The measured snapshot a finding points into, and its view, when its frame has one. */
function measuredFor(finding: Finding, state: SessionState): { readonly snapshot?: RenderedSnapshot; readonly view?: View } {
  if (finding.scenario === undefined || finding.view === undefined) return {};
  const key = frameKey(finding.scenario, finding.view);
  const frame = state.frameStates[key];
  const view = state.frames.find((item) => item.key === key)?.view;
  return { ...(frame?.state === "measured" ? { snapshot: frame.snapshot } : {}), ...(view ? { view } : {}) };
}

/** Every finding of a failing rule says the rule cannot tell: the prototype is not shown to break it, but it cannot pass. */
function cannotTell(rule: RuleReport): boolean {
  return rule.status === "fail" && rule.findings.length > 0 && rule.findings.every((finding) => finding.kind === "unverifiable");
}

function locatable(finding: Finding): boolean {
  return finding.file !== undefined || (finding.scenario !== undefined && finding.view !== undefined);
}

/**
 * One thing to fix: a failing rule. Its lead in plain words, core's message
 * for the finding shown (the selected one, or the first) word for word, the
 * places it was found, and what the person can do about it. The rule's id
 * and type and every finding's exact place are under Details.
 */
function FixItem({
  rule,
  config,
  state,
  selected,
  onSelect,
  outline,
  onShowCode,
  onFix,
  onAsk,
  proposable,
}: {
  readonly rule: RuleReport;
  readonly config: ProjectConfig | undefined;
  readonly state: SessionState;
  /** Where the selected finding is outlined, in words. */
  readonly outline: string | null;
  readonly onShowCode?: (finding: Finding) => void;
  readonly selected: Finding | null;
  readonly onSelect: (finding: Finding | null) => void;
  readonly onFix?: (finding: Finding) => void;
  readonly onAsk?: (finding: Finding) => void;
  readonly proposable?: (finding: Finding) => boolean;
}) {
  const unknown = cannotTell(rule);
  const shown = rule.findings.find((finding) => same(finding, selected)) ?? rule.findings[0];
  if (!shown) return null;
  const first = rule.findings.find(locatable);
  const isShowing = selected !== null && rule.findings.some((finding) => same(finding, selected));
  const headingId = `fix-${rule.rule}`;
  const places = placesOf(rule.findings);
  const groups = groupPlaces(places);
  return (
    <li className="fix" data-rule={rule.rule} data-kind={unknown ? "unverifiable" : "violation"}>
      <Card.Root aria-labelledby={headingId} className="fix-card">
        <Stack.Root gap="condensed">
          <Text.Root as="h3" id={headingId} className="fix-lead" data-testid="fix-lead">
            {unknown ? `Could not be checked: ${lowerFirst(ruleLead(rule, config))}` : ruleLead(rule, config)}
          </Text.Root>
          {/* What the rule measured, drawn from core's evidence, with core's message word for word as its caption. */}
          <EvidenceFigure finding={shown} findings={rule.findings} {...measuredFor(shown, state)}>
            <Text.Root as="p" className="fix-message" data-testid="fix-message">
              {shown.message}
            </Text.Root>
          </EvidenceFigure>
          {places.length > 1 ? (
            <ul className="fix-places" aria-label={`Found in ${places.length} places`}>
              {groups.map(([group, items]) => (
                <li key={group} className="fix-place-row">
                  <Text.Root as="span" tone="muted" className="fix-place-group">
                    {group}
                  </Text.Root>
                  <Stack.Root direction="row" gap="condensed" wrap>
                    {items.map((place) => (
                      <Button.Root key={place.key} variant="ghost" className="fix-place" pressed={same(place.finding, selected)} disabled={!locatable(place.finding)} onPressedChange={(next) => onSelect(next ? place.finding : null)} aria-label={`Show ${place.name}`}>
                        {place.label}
                      </Button.Root>
                    ))}
                  </Stack.Root>
                </li>
              ))}
            </ul>
          ) : (
            <Text.Root as="p" tone="muted" className="fix-where">
              {findingPlace(shown)}
            </Text.Root>
          )}
          {isShowing && outline !== null && (
            <Text.Root as="p" tone="muted" className="fix-outline" data-testid="fix-outline" aria-live="polite">
              {outline}
            </Text.Root>
          )}
          <Stack.Root direction="row" gap="condensed" wrap className="fix-actions">
            {first && (
              <Button.Root variant="secondary" pressed={isShowing} onPressedChange={(next) => onSelect(next ? first : null)} data-testid="show-me">
                <Button.Icon>
                  <Crosshair />
                </Button.Icon>
                Show me
              </Button.Root>
            )}
            {onShowCode && shown.file !== undefined && (shown.targets?.length ?? 0) > 0 && (
              <Button.Root variant="ghost" onClick={() => onShowCode(shown)} data-testid="show-in-code">
                <Button.Icon>
                  <CodeXml />
                </Button.Icon>
                Show in code
              </Button.Root>
            )}
            {onFix && !unknown && (
              <Button.Root variant="ghost" onClick={() => onFix(shown)}>
                <Button.Icon>
                  <Sparkles />
                </Button.Icon>
                Ask the agent to fix
              </Button.Root>
            )}
            {onAsk && proposable?.(shown) && (
              <Button.Root variant="ghost" onClick={() => onAsk(shown)}>
                Ask the agent to propose this
              </Button.Root>
            )}
          </Stack.Root>
          <Disclosure.Root className="fix-details">
            <Disclosure.Summary>Details</Disclosure.Summary>
            <DataList.Root orientation="horizontal" className="fix-facts">
              <DataList.Item>
                <DataList.Term>Rule</DataList.Term>
                <DataList.Details>
                  <Code.Root>{rule.rule}</Code.Root> ({rule.type})
                </DataList.Details>
              </DataList.Item>
              <DataList.Item>
                <DataList.Term>Findings</DataList.Term>
                <DataList.Details>
                  {rule.findings.length} ({rule.findings.filter((finding) => finding.kind === "violation").length} violations, {rule.findings.filter((finding) => finding.kind === "unverifiable").length} cannot be checked)
                </DataList.Details>
              </DataList.Item>
            </DataList.Root>
            <ul className="findings" aria-label={`Every finding of ${rule.rule}`}>
              {rule.findings.map((finding, index) => (
                <li key={index}>
                  <FindingButton finding={finding} selected={same(finding, selected)} onSelect={onSelect} />
                </li>
              ))}
            </ul>
          </Disclosure.Root>
        </Stack.Root>
      </Card.Root>
    </li>
  );
}

/** One place a rule found something, once however many findings it holds: a view of a scenario, or a line of a file. */
type Place = { readonly key: string; readonly group: string; readonly label: string; readonly name: string; readonly finding: Finding };

function placesOf(findings: readonly Finding[]): Place[] {
  const places = new Map<string, Place>();
  for (const finding of findings) {
    const place: Omit<Place, "key"> =
      finding.scenario !== undefined && finding.view !== undefined
        ? { group: scenarioLabel(finding.scenario), label: viewLabel(finding.view), name: findingPlace(finding), finding }
        : finding.file !== undefined
          ? { group: finding.file, label: finding.line !== undefined ? `Line ${finding.line}` : "The file", name: findingPlace(finding), finding }
          : { group: "Elsewhere", label: findingPlace(finding), name: findingPlace(finding), finding };
    const key = `${place.group}\u0000${place.label}`;
    if (!places.has(key)) places.set(key, { key, ...place });
  }
  return [...places.values()];
}

function groupPlaces(places: readonly Place[]): (readonly [string, readonly Place[]])[] {
  const groups = new Map<string, Place[]>();
  for (const place of places) groups.set(place.group, [...(groups.get(place.group) ?? []), place]);
  return [...groups.entries()];
}

function lowerFirst(text: string): string {
  return text ? `${text[0]?.toLowerCase() ?? ""}${text.slice(1)}` : text;
}

function countAnswered(state: SessionState): number {
  return state.frames.filter((frame) => {
    const value = state.frameStates[frame.key]?.state;
    return value === "measured" || value === "failed";
  }).length;
}

/** Where the selected finding's elements are outlined, in words; null when it has no elements to outline. */
function outlineOf(selected: Finding | null, state: SessionState): string | null {
  const plan = selected ? planOutline(selected, state.frames, state.frameStates) : null;
  return plan ? describeOutline(plan, state.frames) : null;
}

function statusTone(status: RuleReport["status"]): "success" | "critical" | "neutral" {
  return status === "pass" ? "success" : status === "fail" ? "critical" : "neutral";
}

/** Core's words for a rule that came without a description, such as one an adopted proposal added. */
function wordsFor(rule: RuleReport, config: ProjectConfig | undefined): string | undefined {
  if (rule.description || !config) return undefined;
  const spec = config.rules.find((item) => item.id === rule.rule);
  return spec ? describeRule(spec, config) : undefined;
}

function RuleItem({
  rule,
  selected,
  onSelect,
  onShowCode,
  outline,
  onAsk,
  proposable,
  words,
  flow,
}: {
  readonly rule: RuleReport;
  readonly words?: string | undefined;
  /** Core's flow facts, on the rule that measures routes against the step budget. */
  readonly flow?: FlowFacts | null | undefined;
  readonly selected: Finding | null;
  readonly onSelect: (finding: Finding | null) => void;
  readonly onShowCode?: (finding: Finding) => void;
  /** Where the selected finding is outlined, in words. */
  readonly outline: string | null;
  readonly onAsk?: (finding: Finding) => void;
  readonly proposable?: (finding: Finding) => boolean;
}) {
  const head = (
    <Stack.Root direction="row" align="center" gap="condensed" wrap className="rule-head">
      <Badge.Root tone={statusTone(rule.status)} className="rule-status">
        {rule.status === "not-run" ? "not run" : rule.status}
      </Badge.Root>
      <Text.Root as="span" weight="medium" className="rule-id">
        {rule.rule}
      </Text.Root>
      {cannotTell(rule) && <Badge.Root tone="warning">cannot be checked</Badge.Root>}
      {rule.findings.length > 0 && (
        <Text.Root as="span" tone="muted">
          {rule.findings.length} {rule.findings.length === 1 ? "finding" : "findings"}
        </Text.Root>
      )}
    </Stack.Root>
  );
  return (
    <li className="rule" data-rule={rule.rule} data-status={rule.status}>
      {rule.findings.length === 0 ? (
        <div className="rule-plain">
          {head}
          <RuleText rule={rule} words={words} />
          {flow && <FlowMaps flow={flow} />}
        </div>
      ) : (
        <Disclosure.Root open={rule.status === "fail" ? true : undefined} className="rule-disclosure">
          <Disclosure.Summary>{head}</Disclosure.Summary>
          <RuleText rule={rule} words={words} />
          {flow && <FlowMaps flow={flow} />}
          <ul className="findings" aria-label={`Findings of ${rule.rule}`}>
            {rule.findings.map((finding, index) => (
              <li key={index}>
                <FindingButton finding={finding} selected={same(finding, selected)} onSelect={onSelect} />
                {same(finding, selected) && outline !== null && (
                  <Text.Root as="p" tone="muted" className="finding-outline" data-testid="finding-outline" aria-live="polite">
                    {outline}
                  </Text.Root>
                )}
                {onShowCode && finding.file !== undefined && (finding.targets?.length ?? 0) > 0 && (
                  <Button.Root type="button" variant="ghost" className="finding-code" onClick={() => onShowCode(finding)}>
                    Show in code
                  </Button.Root>
                )}
                {onAsk && proposable?.(finding) && (
                  <Button.Root type="button" variant="ghost" className="finding-ask" onClick={() => onAsk(finding)}>
                    Ask the agent to propose this
                  </Button.Root>
                )}
              </li>
            ))}
          </ul>
        </Disclosure.Root>
      )}
    </li>
  );
}

/** Each task's routes as a map, under the rule that measures them: there when it passes too. */
function FlowMaps({ flow }: { readonly flow: FlowFacts }) {
  return (
    <Disclosure.Root className="rule-flow" data-testid="rule-flow">
      <Disclosure.Summary>{`Flow map: ${flow.tasks.length} ${flow.tasks.length === 1 ? "task" : "tasks"}`}</Disclosure.Summary>
      <TaskMaps flow={flow} />
    </Disclosure.Root>
  );
}

/** One flow map per task, each named by the task and its budget. */
export function TaskMaps({ flow, onGoToState }: { readonly flow: FlowFacts; readonly onGoToState?: ((state: string) => void) | undefined }) {
  const scenarios = Object.fromEntries(flow.states.map((item) => [item.state, item.scenarios]));
  const context = useContext(VisualContext);
  const go = onGoToState ?? context.onOpenState;
  return (
    <ul className="task-maps">
      {flow.tasks.map((task) => (
        <li key={task.task} className="task-map">
          <Text.Root as="p" weight="medium" className="task-map-title">
            {task.description ?? task.task}: at most {task.budget} {task.budget === 1 ? "step" : "steps"}
          </Text.Root>
          <FlowMap task={{ id: task.task, start: task.start, success: task.success, budget: task.budget, transitions: task.transitions, longest: task.longest, status: task.status, routes: task.routes }} scenarios={scenarios} onOpenState={go} />
        </li>
      ))}
    </ul>
  );
}

function RuleText({ rule, words }: { readonly rule: RuleReport; readonly words?: string | undefined }) {
  const said = rule.description ?? words;
  return (
    <>
      <Text.Root as="p" tone="muted" className="rule-description">
        {rule.type}
        {said ? ` · ${said}` : ""}
      </Text.Root>
      {rule.note && (
        <Text.Root as="p" tone="muted" className="rule-note">
          {rule.note}
        </Text.Root>
      )}
    </>
  );
}

function same(a: Finding, b: Finding | null): boolean {
  return b !== null && JSON.stringify(a) === JSON.stringify(b);
}

/** Where a finding is, for the line under its message. */
export function placeOf(finding: Finding): string {
  const parts: string[] = [finding.kind];
  if (finding.file !== undefined) parts.push(`${finding.file}${finding.line !== undefined ? `:${finding.line}${finding.column !== undefined ? `:${finding.column}` : ""}` : ""}`);
  // Inside a spec layout instance: where the layout is used, nearest first.
  for (const use of finding.via ?? []) parts.push(use.slot !== undefined ? `in slot ${use.slot} of ${use.layout} at ${use.file}:${use.line}` : `in ${use.layout} used at ${use.file}:${use.line}`);
  if (finding.page !== undefined) parts.push(`page ${finding.page}`);
  if (finding.scenario !== undefined) parts.push(`scenario ${finding.scenario}`);
  if (finding.state !== undefined) parts.push(`state ${finding.state}`);
  if (finding.view !== undefined) parts.push(`view ${finding.view}`);
  return parts.join(" · ");
}

/** A finding as a row that points at it: its message word for word, and where it is. */
export function FindingButton({ finding, selected, onSelect }: { readonly finding: Finding; readonly selected: boolean; readonly onSelect: (finding: Finding | null) => void }) {
  return (
    <button type="button" className="finding" data-kind={finding.kind} aria-pressed={selected} disabled={!locatable(finding)} onClick={() => onSelect(selected ? null : finding)}>
      <span className="finding-message">{finding.message}</span>
      <span className="finding-place">{placeOf(finding)}</span>
    </button>
  );
}
