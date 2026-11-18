import { Badge, Button, Disclosure, Stack, Text } from "@tounsoo/todae";
import { describeRule, type Finding, type ProjectConfig, type RuleReport } from "@design-harness/core";
import type { SessionState } from "../runtime/session";

/**
 * Core's report, as core wrote it: every rule in force in core's order, its
 * status, and every finding's message word for word. The panel adds where a
 * finding is (file and line, page, scenario and view) and lets a finding be
 * selected to point at it. It decides nothing and hides nothing.
 */
export function ChecksPanel({
  state,
  measuredCount,
  selected,
  onSelect,
  onAsk,
  proposable,
  config,
}: {
  readonly state: SessionState;
  /** The project's config, to say a rule without a description in words generated from its data. */
  readonly config?: ProjectConfig;
  readonly measuredCount: number;
  readonly selected: Finding | null;
  readonly onSelect: (finding: Finding | null) => void;
  /** Puts a message about the finding into the chat, for the person to edit and send; absent when there is no key. */
  readonly onAsk?: (finding: Finding) => void;
  /** Whether a finding is about something outside the inventories, which a proposal could add. */
  readonly proposable?: (finding: Finding) => boolean;
}) {
  const report = state.report;
  if (!report) return <Text.Root as="p">Nothing checked yet.</Text.Root>;
  const counts = { pass: 0, fail: 0, "not-run": 0 };
  for (const rule of report.rules) counts[rule.status] += 1;
  const frames = state.frames.length;
  return (
    <div className="checks" data-revision={state.revision} data-measured={state.measured ? "" : undefined}>
      <div className="checks-summary">
        <Stack.Root direction="row" align="center" gap="condensed" wrap>
          <Badge.Root tone={report.status === "pass" ? "success" : report.status === "fail" ? "critical" : "neutral"} data-testid="report-status">
            {report.status}
          </Badge.Root>
          <Text.Root as="span">
            {counts.pass} pass · {counts.fail} fail · {counts["not-run"]} not run
          </Text.Root>
        </Stack.Root>
        {counts.fail > 0 && (
          <Text.Root as="p" className="checks-failing">
            Failing:{" "}
            {report.rules
              .filter((rule) => rule.status === "fail")
              .map((rule) => rule.rule)
              .join(", ")}
          </Text.Root>
        )}
        <Text.Root as="p" tone="muted" className="checks-revision" aria-live="polite">
          {state.measured
            ? `Revision ${state.revision}: source and ${measuredCount} of ${frames} frames measured.`
            : `Revision ${state.revision}: source checked; measuring frames (${countAnswered(state)} of ${frames} answered). Rendered rules report not-run until every frame answers.`}
        </Text.Root>
      </div>
      <ol className="checks-rules" aria-label="Rules in force">
        {report.rules.map((rule) => (
          <RuleItem key={rule.rule} rule={rule} selected={selected} onSelect={onSelect} {...(onAsk && proposable ? { onAsk, proposable } : {})} words={wordsFor(rule, config)} />
        ))}
      </ol>
      <Disclosure.Root className="checks-json">
        <Disclosure.Summary>Core's report as JSON</Disclosure.Summary>
        <pre className="project-json" data-testid="report-json">
          {JSON.stringify(report, null, 2)}
        </pre>
      </Disclosure.Root>
    </div>
  );
}

function countAnswered(state: SessionState): number {
  return state.frames.filter((frame) => {
    const value = state.frameStates[frame.key]?.state;
    return value === "measured" || value === "failed";
  }).length;
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
  onAsk,
  proposable,
  words,
}: {
  readonly rule: RuleReport;
  readonly words?: string | undefined;
  readonly selected: Finding | null;
  readonly onSelect: (finding: Finding | null) => void;
  readonly onAsk?: (finding: Finding) => void;
  readonly proposable?: (finding: Finding) => boolean;
}) {
  // Every finding of a failing rule says the rule cannot tell: the prototype is not shown to break it, but it cannot pass.
  const cannotTell = rule.status === "fail" && rule.findings.length > 0 && rule.findings.every((finding) => finding.kind === "unverifiable");
  const head = (
    <Stack.Root direction="row" align="center" gap="condensed" className="rule-head">
      <Badge.Root tone={statusTone(rule.status)} className="rule-status">
        {rule.status === "not-run" ? "not run" : rule.status}
      </Badge.Root>
      <Text.Root as="span" weight="medium" className="rule-id">
        {rule.rule}
      </Text.Root>
      {cannotTell && <Badge.Root tone="warning">cannot be checked</Badge.Root>}
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
        </div>
      ) : (
        <Disclosure.Root open={rule.status === "fail" ? true : undefined} className="rule-disclosure">
          <Disclosure.Summary>{head}</Disclosure.Summary>
          <RuleText rule={rule} words={words} />
          <ul className="findings" aria-label={`Findings of ${rule.rule}`}>
            {rule.findings.map((finding, index) => (
              <li key={index}>
                <FindingButton finding={finding} selected={same(finding, selected)} onSelect={onSelect} />
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
  const locatable = finding.file !== undefined || (finding.scenario !== undefined && finding.view !== undefined);
  return (
    <button
      type="button"
      className="finding"
      data-kind={finding.kind}
      aria-pressed={selected}
      disabled={!locatable}
      onClick={() => onSelect(selected ? null : finding)}
    >
      <span className="finding-message">{finding.message}</span>
      <span className="finding-place">{placeOf(finding)}</span>
    </button>
  );
}
