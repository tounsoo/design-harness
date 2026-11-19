import { Alert, Badge, Button, Card, Code, DataList, Disclosure, EmptyState, ErrorMessage, Field, Label, Stack, Steps, Table, Text } from "@tounsoo/todae";
import { Check, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  applyProposal,
  checkPrototype,
  describeRule,
  dryRunAdoption,
  newlyFailingOf,
  rerunExamples,
  ruleTypeIssue,
  tryExamples,
  withExampleSnapshots,
  type Adoption,
  type CheckReport,
  type ExampleResult,
  type ExistingPrototype,
  type FailingExample,
  type Finding,
  type NewlyFailing,
  type PassingExample,
  type InventoryOp,
  type ProjectConfig,
  type Proposal,
  type ProposalContent,
  type Refusal,
  type RuleTypeExample,
  type View,
} from "@design-harness/core";
import { frameKey, type Session, type SessionState } from "../runtime/session";
import { isSpecRecord, type PrototypeRecord, type SpecRecord } from "../store/project-file";
import { adoptProposal, approveProposal, declineProposal, sendBackProposal, type ExampleMeasurement } from "../review/actions";
import { inventoryDiff, type DiffSection } from "../review/diff";
import { REVIEWER, draftedBy, formatTime, proposalTimeline, timelineTitle, type TimelineEntry } from "../review/timeline";
import { FrameCard, FrameViewport } from "./Board";
import { EvidenceFigure, drawsFigure } from "../visual/figures";
import { ClassScale, ProposalTrack, RuleFigure } from "../visual/project-figures";
import { proofPair, proposalPreview, ruleBound } from "../visual/project-model";
import { FindingButton } from "./ChecksPanel";
import { lineRange } from "./CodePanel";
import { SpecimenTile } from "./Palette";
import { PreviewFigure, SnapshotThumb, flaggedIn } from "./ProposalPreview";
import { ClassBadge, RequestBadge, RuleWords, StatusBadge, classWords, classificationOf } from "./proposal-parts";
import { measurementOf, useSessions, type Measured, type Measurement } from "./sessions";
import { exampleLabel, frameNameOf, scenarioName, scenarioNameOf, viewLabel } from "./words";

type Props = {
  readonly config: ProjectConfig;
  readonly id: string;
  readonly prototypes: readonly PrototypeRecord[];
  readonly openPrototypeId: string;
  /** The board's session, which measures the open prototype: its snapshots are that prototype's, so it is not measured twice. */
  readonly board: { readonly session: Session; readonly state: SessionState };
  readonly agent: { readonly ready: boolean; readonly why: string };
  readonly onBack: () => void;
  readonly onSave: (next: ProjectConfig) => Promise<void>;
  readonly onSendBack: (message: string) => void;
  readonly onOpenPrototype: (id: string, finding?: Finding) => void;
  readonly onOpenProposal: (id: string) => void;
};

/** One example as the page shows it: what it must do, its frames, and what core says it did. */
type ExampleView = {
  readonly name: string;
  readonly expect: "pass" | "fail";
  readonly example: PassingExample | FailingExample;
  readonly frames: Measured;
  readonly verdict: Verdict;
  /** What to point at: the named rule's findings on a failing example, or what makes an example misbehave. */
  readonly findings: readonly Finding[];
};

type Verdict =
  | { readonly state: "measuring"; readonly text: string }
  | { readonly state: "unmeasured"; readonly text: string }
  | { readonly state: "ok"; readonly text: string }
  | { readonly state: "bad"; readonly text: string; readonly refusal?: Refusal }
  | { readonly state: "not-judged"; readonly text: string };

/** Core's judgement of the examples on their measurement: the config with the snapshots stored and every example tried, or why core could not. */
type Judged = { readonly refusal: Refusal } | { readonly config: ProjectConfig; readonly tried: { readonly config: ProjectConfig; readonly results: readonly ExampleResult[] } };

const now = () => new Date().toISOString();

/** How tall an example's frame may be drawn, in CSS px, so a tall view stays beside its text. */
const FRAME_MAX_HEIGHT = 380;

/**
 * A proposal's review page: what it changes and why, its examples rendered
 * side by side in frames and measured, core's verdict on each, what adopting
 * it would do to the project's prototypes, its history, and the actions only
 * the person can take. Every verdict on the page is core's: the page renders,
 * measures, and passes the snapshots to core.
 */
export function ProposalPage(props: Props) {
  const proposal = props.config.proposals.find((item) => item.id === props.id);
  if (!proposal) {
    return (
      <EmptyState.Root>
        <EmptyState.Title as="h2">No proposal &quot;{props.id}&quot;</EmptyState.Title>
        <EmptyState.Actions>
          <Button.Root variant="secondary" onClick={props.onBack}>
            All proposals
          </Button.Root>
        </EmptyState.Actions>
      </EmptyState.Root>
    );
  }
  return proposal.needsRuleType ? <RequestReview {...props} proposal={proposal} /> : <Review {...props} proposal={proposal} />;
}

/** What copying a request does, and what the page says after. */
type Copied = { readonly state: "idle" } | { readonly state: "copied" } | { readonly state: "failed"; readonly message: string };

/**
 * The review page of a request for a new rule type. It is a code change, and
 * the page says so first: what the rule should check, why core's vocabulary
 * cannot say it, its examples in words, and the request ready to copy and
 * file. There is no Approve or Adopt: core refuses both, and the page shows
 * core's refusal word for word. Send back and decline work as on any proposal.
 */
function RequestReview({ config, proposal, agent, onBack, onSave, onSendBack }: Props & { readonly proposal: Proposal }) {
  const request = proposal.needsRuleType;
  const issue = ruleTypeIssue(proposal);
  const id = proposal.id;
  const [refusal, setRefusal] = useState<{ readonly action: string; readonly refusal: Refusal } | null>(null);
  const [copied, setCopied] = useState<Copied>({ state: "idle" });
  if (!request || !issue) return null;
  const text = `# ${issue.title}\n\n${issue.body}\n`;
  // Core's own answer to approving it, shown so the page never claims more than core says.
  const approval = approveProposal(config, id, "dry run");
  const refused = approval.ok ? null : approval.error;
  const drafted = draftedBy(proposal);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied({ state: "copied" });
    } catch (error) {
      setCopied({ state: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  };
  const act = async (action: string, run: () => ReturnType<typeof approveProposal>) => {
    const result = run();
    if (!result.ok) return setRefusal({ action, refusal: result.error });
    setRefusal(null);
    await onSave(result.value);
  };
  return (
    <div className="review" data-proposal={id} data-status={proposal.status} data-request="">
      <Stack.Root gap="spacious">
        <Stack.Root gap="condensed">
          <div>
            <Button.Root variant="ghost" onClick={onBack} className="review-back">
              ← All proposals
            </Button.Root>
          </div>
          <Text.Root as="h1" className="review-title">
            {proposal.title}
          </Text.Root>
          <ProposalTrack proposal={proposal} note={proposal.status === "open" ? "it cannot be approved: it needs a code change" : undefined} />
          <Stack.Root direction="row" align="center" gap="condensed" wrap>
            <StatusBadge status={proposal.status} />
            <RequestBadge />
            <Code.Root>{id}</Code.Root>
            <Text.Root as="span" tone="muted">
              Drafted by {drafted.by}, <time dateTime={drafted.at}>{formatTime(drafted.at)}</time>
            </Text.Root>
          </Stack.Root>
        </Stack.Root>

        <Alert.Root tone="warning" data-testid="rule-type-request">
          <Alert.Title>Needs a new rule type: this is a code change</Alert.Title>
          <Alert.Description>
            <Stack.Root gap="condensed">
              <Text.Root as="p">
                Core&apos;s rule vocabulary cannot express this rule, so it can never become a check here. A person adds the rule type to core; then the agent can propose a rule that uses it, with examples that prove it, for you to adopt.
              </Text.Root>
              {refused && (
                <Text.Root as="p" tone="muted" className="review-small" data-testid="request-refusal" data-code={refused.code}>
                  Core on approving it: {refused.message}
                </Text.Root>
              )}
              <Stack.Root direction="row" align="center" gap="condensed" wrap>
                <Button.Root variant="primary" onClick={() => void copy()}>
                  Copy the request to file
                </Button.Root>
                <Text.Root as="span" className="review-small" aria-live="polite" data-testid="request-copied" data-state={copied.state}>
                  {copied.state === "copied" ? "Copied: a title and a Markdown body, ready to file as an issue." : copied.state === "failed" ? `Could not copy (${copied.message}); select the request below instead.` : ""}
                </Text.Root>
              </Stack.Root>
            </Stack.Root>
          </Alert.Description>
        </Alert.Root>

        <RequestActions
          proposal={proposal}
          agent={agent}
          onDecline={(note) => act("decline", () => declineProposal(config, id, note, now()))}
          onSendBack={async (note) => {
            const sent = sendBackProposal(config, id, note, now());
            if (!sent.ok) return setRefusal({ action: "send back", refusal: sent.error });
            setRefusal(null);
            await onSave(sent.value.config);
            onSendBack(sent.value.message);
          }}
        />
        {refusal && <RefusalAlert action={refusal.action} refusal={refusal.refusal} onShowExample={() => undefined} onOpenProposal={() => undefined} />}

        <section aria-labelledby="request-checks" className="review-section">
          <Text.Root as="h2" id="request-checks">
            What the rule should check
          </Text.Root>
          <Text.Root as="p" className="pre" data-testid="request-checks">
            {request.checks}
          </Text.Root>
        </section>
        <section aria-labelledby="request-why-not" className="review-section">
          <Text.Root as="h2" id="request-why-not">
            Why the vocabulary cannot express it
          </Text.Root>
          <Text.Root as="p" className="pre" data-testid="request-why-not">
            {request.whyNot}
          </Text.Root>
        </section>
        <section aria-labelledby="request-examples" className="review-section">
          <Text.Root as="h2" id="request-examples">
            Examples
          </Text.Root>
          <Text.Root as="p" tone="muted">
            In words: there is no rule to run them against yet.
          </Text.Root>
          <div className="review-columns">
            <WordExamples title="Must pass" examples={request.pass} expect="pass" />
            <WordExamples title="Must fail" examples={request.fail} expect="fail" />
          </div>
        </section>
        <section aria-labelledby="review-why" className="review-section">
          <Text.Root as="h2" id="review-why">
            Why
          </Text.Root>
          <Text.Root as="p" className="pre" data-testid="proposal-reason">
            {proposal.reason}
          </Text.Root>
        </section>
        <section aria-labelledby="request-text-title" className="review-section">
          <Text.Root as="h2" id="request-text-title">
            The request as it is copied
          </Text.Root>
          <Field.Root id="request-text" aria-label="The request as it is copied">
            <Field.Textarea value={text} readOnly rows={12} autoGrow maxRows={24} data-testid="request-text" />
          </Field.Root>
        </section>

        <History proposal={proposal} config={config} />
      </Stack.Root>
    </div>
  );
}

function WordExamples({ title, examples, expect }: { readonly title: string; readonly examples: readonly RuleTypeExample[]; readonly expect: "pass" | "fail" }) {
  return (
    <div className="review-column">
      <Text.Root as="h3">{title}</Text.Root>
      <ul className="review-rules" aria-label={title}>
        {examples.map((example) => (
          <li key={example.name} data-example={example.name} data-expect={expect}>
            <Stack.Root gap="condensed">
              <Text.Root as="span" className="example-name">
                {example.name}
              </Text.Root>
              <Text.Root as="p" className="review-small pre">
                {example.description}
              </Text.Root>
              {example.snippet && <pre className="project-json">{example.snippet}</pre>}
            </Stack.Root>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A request's actions: send it back or decline it, each with its note. Approve and Adopt are not offered: core refuses both. */
function RequestActions({ proposal, agent, onDecline, onSendBack }: { readonly proposal: Proposal; readonly agent: { readonly ready: boolean; readonly why: string }; readonly onDecline: (note: string) => Promise<void> | void; readonly onSendBack: (note: string) => Promise<void> | void }) {
  const [form, setForm] = useState<"decline" | "send-back" | null>(null);
  if (proposal.status !== "open") return null;
  return (
    <Card.Root className="review-actions" data-testid="review-actions">
      <Card.Body>
        <Stack.Root gap="condensed">
          <Stack.Root direction="row" align="center" gap="condensed" wrap>
            <Button.Root variant="secondary" onClick={() => setForm(form === "send-back" ? null : "send-back")} aria-expanded={form === "send-back"}>
              Send back to the agent
            </Button.Root>
            <Button.Root variant="ghost" onClick={() => setForm(form === "decline" ? null : "decline")} aria-expanded={form === "decline"}>
              Decline
            </Button.Root>
          </Stack.Root>
          <Text.Root as="p" tone="muted" className="review-small">
            Once the request is filed, decline it here with a note that says where. Send it back if the vocabulary can say it after all.
          </Text.Root>
          {form === "decline" && <NoteForm key="decline" label="Why decline it?" hint="Declining is final. The note is kept in the request's history." submit="Decline proposal" required="Say why you decline it." onCancel={() => setForm(null)} onSubmit={async (note) => {
            await onDecline(note);
            setForm(null);
          }} />}
          {form === "send-back" &&
            (agent.ready ? (
              <NoteForm key="send-back" label="What should the agent change?" hint="The note goes to the agent as a chat message naming this request, and into its history. It stays open." submit="Send to the agent" required="Say what the agent should change." onCancel={() => setForm(null)} onSubmit={async (note) => {
                await onSendBack(note);
                setForm(null);
              }} />
            ) : (
              <Alert.Root tone="info">
                <Alert.Description>{agent.why}</Alert.Description>
              </Alert.Root>
            ))}
        </Stack.Root>
      </Card.Body>
    </Card.Root>
  );
}

function Review({ config, proposal, prototypes, openPrototypeId, board, agent, onBack, onSave, onSendBack, onOpenPrototype, onOpenProposal }: Props & { readonly proposal: Proposal }) {
  const id = proposal.id;
  const live = proposal.status === "open" || proposal.status === "approved";

  // Examples render with the proposal applied, so a page type or component it adds is there; an adopted proposal is applied already.
  const renderConfig = useMemo(() => {
    if (proposal.status === "adopted") return config;
    const applied = applyProposal(config, proposal);
    return applied.ok ? applied.value : config;
  }, [config, proposal]);
  const all = useMemo(
    () => [...proposal.examples.pass.map((example) => ({ example, expect: "pass" as const })), ...proposal.examples.fail.map((example) => ({ example, expect: "fail" as const }))],
    [proposal.examples],
  );
  const exampleItems = useMemo(() => all.map(({ example }) => ({ id: example.name, config: renderConfig, prototype: example.prototype })), [all, renderConfig]);
  const exampleFrames = useSessions(exampleItems);

  // Every spec prototype in the project, measured, for the impact; a stored TSX one is checked by nothing. The open one is the board's.
  const others = useMemo(() => (live ? prototypes.filter(isSpecRecord).filter((record) => record.id !== openPrototypeId) : []), [live, prototypes, openPrototypeId]);
  const otherItems = useMemo(() => others.map((record) => ({ id: `prototype-${record.id}`, config, prototype: record.prototype })), [others, config]);
  const otherFrames = useSessions(otherItems);
  const openRecord = prototypes.filter(isSpecRecord).find((record) => record.id === openPrototypeId);
  const boardCurrent = board.session.current();
  const openMeasurement: Measurement | null = !live || !openRecord ? null : boardCurrent?.prototype === openRecord.prototype && board.state.revision === boardCurrent.revision ? measurementOf(board.state) : { state: "measuring", answered: 0, total: board.state.frames.length };
  const existing: readonly ExistingPrototype[] | null = useMemo(() => {
    if (!live) return null;
    const out: ExistingPrototype[] = [];
    const add = (record: SpecRecord, measurement: Measurement) => out.push({ name: record.name, prototype: record.prototype, snapshots: measurement.state === "measured" ? measurement.snapshots : [] });
    if (openRecord && openMeasurement) {
      if (openMeasurement.state === "measuring") return null;
      add(openRecord, openMeasurement);
    }
    for (const [index, record] of others.entries()) {
      const measured = otherFrames[index];
      if (!measured || measured.measurement.state === "measuring") return null;
      add(record, measured.measurement);
    }
    return out;
    // The measurements' states decide; their objects are new on every render.
  }, [live, openRecord, openMeasurement?.state, others, otherFrames.map((item) => item.measurement.state).join(",")]);

  const exampleMeasurement: ExampleMeasurement | null = exampleFrames.every((item) => item.measurement.state === "measured")
    ? Object.fromEntries(exampleFrames.map((item) => [item.id, item.measurement.state === "measured" ? item.measurement.snapshots : []]))
    : null;
  const measurementKey = exampleMeasurement ? exampleFrames.map((item) => item.key).join("|") : null;

  // Core's judgement of every example, on the complete measurement only.
  const judged = useMemo((): Judged | null => {
    if (!live || !exampleMeasurement) return null;
    const measured = withExampleSnapshots(config, id, exampleMeasurement);
    if (!measured.ok) return { refusal: measured.error };
    const tried = tryExamples(measured.value, id);
    if (!tried.ok) return { refusal: tried.error };
    return { config: measured.value, tried: tried.value };
    // Keyed by the measured content, not the measurement object.
  }, [live, config, id, measurementKey]);

  const dryRun = useMemo(() => {
    if (!judged || !("tried" in judged) || !existing) return null;
    return dryRunAdoption(judged.config, id, { at: "dry run", by: REVIEWER }, existing);
  }, [judged, existing, id]);
  const impact: readonly NewlyFailing[] | null = useMemo(() => {
    if (!dryRun || !judged || !("tried" in judged) || !existing) return null;
    if (dryRun.ok) return dryRun.value.newlyFailing;
    return newlyFailingOf(config, judged.tried.config, existing);
  }, [dryRun, judged, existing, config]);

  // An adopted proposal's examples are judged on the snapshots stored at adoption, with no frame: rerunExamples.
  const reruns = useMemo(() => (proposal.status === "adopted" ? rerunExamples(config).filter((run) => run.proposal === id) : []), [proposal.status, config, id]);

  const views: ExampleView[] = all.map(({ example, expect }, index) => {
    const frames = exampleFrames[index] as Measured;
    const named = expect === "fail" ? (example as FailingExample).flaggedBy.rule : undefined;
    const ruleFindings = (report: CheckReport) => (named ? (report.rules.find((rule) => rule.rule === named)?.findings ?? []) : []);
    if (proposal.status === "adopted") {
      const run = reruns.find((item) => item.example === example.name && item.expect === expect);
      const report = checkPrototype({ config, prototype: example.prototype, ...(example.snapshots ? { snapshots: example.snapshots } : {}) });
      return { name: example.name, expect, example, frames, findings: ruleFindings(report), verdict: run ? (run.ok ? { state: "ok", text: run.detail } : { state: "bad", text: run.detail }) : { state: "not-judged", text: "Not re-run." } };
    }
    if (proposal.status === "declined") return { name: example.name, expect, example, frames, findings: [], verdict: { state: "not-judged", text: "Declined: its examples are no longer judged." } };
    const measurement = frames.measurement;
    if (measurement.state === "measuring") return { name: example.name, expect, example, frames, findings: [], verdict: { state: "measuring", text: `Measuring: ${measurement.answered} of ${measurement.total} frames answered.` } };
    if (measurement.state === "failed") {
      return { name: example.name, expect, example, frames, findings: [], verdict: { state: "unmeasured", text: `Not measured: ${measurement.problems.map((problem) => `${frameNameOf(problem.frame, frames.state.frames)} (${problem.stage}): ${problem.message}`).join("; ")}` } };
    }
    if (!judged) return { name: example.name, expect, example, frames, findings: [], verdict: { state: "measuring", text: "Measured; waiting for the other examples." } };
    if ("refusal" in judged) return { name: example.name, expect, example, frames, findings: [], verdict: { state: "bad", text: judged.refusal.message, refusal: judged.refusal } };
    const result = judged.tried.results.find((item) => item.example === example.name && item.expect === expect);
    if (!result) return { name: example.name, expect, example, frames, findings: [], verdict: { state: "not-judged", text: "Not judged." } };
    const findings = result.ok ? ruleFindings(result.report) : (result.refusal?.findings ?? ruleFindings(result.report));
    return { name: example.name, expect, example, frames, findings, verdict: result.ok ? { state: "ok", text: result.detail } : { state: "bad", text: result.detail, ...(result.refusal ? { refusal: result.refusal } : {}) } };
  });

  const measuring = exampleFrames.reduce(
    (sum, item) => {
      const state = item.measurement;
      return state.state === "measuring" ? { answered: sum.answered + state.answered, total: sum.total + state.total, failed: sum.failed } : { answered: sum.answered + item.state.frames.length, total: sum.total + item.state.frames.length, failed: sum.failed + (state.state === "failed" ? 1 : 0) };
    },
    { answered: 0, total: 0, failed: 0 },
  );

  const [refusal, setRefusal] = useState<{ readonly action: string; readonly refusal: Refusal } | null>(null);
  const [adoption, setAdoption] = useState<Adoption | null>(null);
  const [focusExample, setFocusExample] = useState<string | null>(null);
  const refusalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (refusal) refusalRef.current?.scrollIntoView({ block: "start" });
  }, [refusal]);

  const act = async (action: string, run: () => ReturnType<typeof approveProposal>) => {
    const result = run();
    if (!result.ok) return setRefusal({ action, refusal: result.error });
    setRefusal(null);
    await onSave(result.value);
  };
  const adopt = async () => {
    if (!exampleMeasurement || !existing) return;
    const result = adoptProposal(config, id, exampleMeasurement, existing, now());
    if (!result.ok) {
      setRefusal({ action: "adopt", refusal: result.error });
      if (result.error.example && !result.error.proposal) setFocusExample(result.error.example);
      return;
    }
    setRefusal(null);
    setAdoption(result.value);
    await onSave(result.value.config);
  };

  const drafted = draftedBy(proposal);
  const classification = classificationOf(proposal, config);
  // What the current step waits for, from the measurement and core's dry run.
  const trackNote =
    proposal.status === "open"
      ? "waiting for you"
      : proposal.status === "approved"
        ? exampleMeasurement === null || existing === null
          ? measuring.failed > 0
            ? "an example could not be measured"
            : `measuring, ${measuring.answered} of ${measuring.total} frames`
          : dryRun && !dryRun.ok
            ? "core's dry run refuses it"
            : "ready for you to adopt"
        : proposal.status === "adopted"
          ? "in force"
          : undefined;
  const classSection = (
    <section aria-labelledby="review-class" className="review-section" data-testid="review-class">
      <Text.Root as="h2" id="review-class">
        How far it moves the project
      </Text.Root>
      <Text.Root as="p" tone="muted">
        Core classifies every change{proposal.classification ? ", kept from when it was adopted" : ", against the project as it is now"}. A proposal sits at its loosest change: this one {classWords(classification.class)}.
      </Text.Root>
      <Card.Root className="figure-card">
        <ClassScale value={classification.class} />
        <Table.Root className="project-table" aria-label="Each change and its class">
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Change</Table.HeaderCell>
              <Table.HeaderCell>Class</Table.HeaderCell>
              <Table.HeaderCell>Why</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {classification.changes.map((change, index) => (
              <Table.Row key={index} data-sets-class={change.class === classification.class ? "" : undefined}>
                <Table.Cell>
                  <Code.Root>{change.change}</Code.Root>
                </Table.Cell>
                <Table.Cell>
                  <ClassBadge value={change.class} />
                </Table.Cell>
                <Table.Cell>{change.reason}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Card.Root>
    </section>
  );

  return (
    <div className="review" data-proposal={id} data-status={proposal.status}>
      <Stack.Root gap="spacious">
        <Stack.Root gap="condensed">
          <div>
            <Button.Root variant="ghost" onClick={onBack} className="review-back">
              ← All proposals
            </Button.Root>
          </div>
          <Text.Root as="h1" className="review-title">
            {proposal.title}
          </Text.Root>
          <ProposalTrack proposal={proposal} note={trackNote} />
          <Stack.Root direction="row" align="center" gap="condensed" wrap>
            <StatusBadge status={proposal.status} />
            <Code.Root>{id}</Code.Root>
            <Text.Root as="span" tone="muted">
              Drafted by {drafted.by}, <time dateTime={drafted.at}>{formatTime(drafted.at)}</time>
            </Text.Root>
          </Stack.Root>
        </Stack.Root>

        <Actions
          proposal={proposal}
          agent={agent}
          measuring={measuring}
          ready={exampleMeasurement !== null && existing !== null}
          dryRun={dryRun}
          judgedRefusal={judged && "refusal" in judged ? judged.refusal : null}
          onApprove={() => act("approve", () => approveProposal(config, id, now()))}
          onDecline={(note) => act("decline", () => declineProposal(config, id, note, now()))}
          onSendBack={async (note) => {
            const sent = sendBackProposal(config, id, note, now());
            if (!sent.ok) return setRefusal({ action: "send back", refusal: sent.error });
            setRefusal(null);
            await onSave(sent.value.config);
            onSendBack(sent.value.message);
          }}
          onAdopt={adopt}
        />

        {refusal && (
          <div ref={refusalRef} className="review-refusal">
            <RefusalAlert action={refusal.action} refusal={refusal.refusal} onShowExample={setFocusExample} onOpenProposal={onOpenProposal} />
          </div>
        )}

        {proposal.status === "adopted" && <InForce proposal={proposal} config={config} adoption={adoption} onOpenPrototype={onOpenPrototype} prototypes={prototypes} />}

        {classSection}

        <section aria-labelledby="review-why" className="review-section">
          <Text.Root as="h2" id="review-why">
            Why
          </Text.Root>
          <Text.Root as="p" className="pre" data-testid="proposal-reason">
            {proposal.reason}
          </Text.Root>
          {proposal.states.length > 0 && (
            <>
              <Text.Root as="h3">States it shows</Text.Root>
              <DataList.Root orientation="horizontal" className="project-facts" data-testid="proposal-states">
                {proposal.states.map((state, index) => (
                  <DataList.Item key={index}>
                    <DataList.Term>{state.state}</DataList.Term>
                    <DataList.Details>{state.note}</DataList.Details>
                  </DataList.Item>
                ))}
              </DataList.Root>
            </>
          )}
        </section>

        <Changes proposal={proposal} config={config} renderConfig={renderConfig} views={views} onShowExample={setFocusExample} />

        <Examples views={views} config={renderConfig} status={proposal.status} focus={focusExample} onFocused={() => setFocusExample(null)} />

        {live && <Impact impact={impact} measuring={existing === null} dryRun={dryRun} prototypes={prototypes} existing={existing} views={config.views} onOpenPrototype={onOpenPrototype} />}
        {live && <OtherFrames items={otherFrames} />}

        <History proposal={proposal} config={config} />
      </Stack.Root>
    </div>
  );
}

type ActionsProps = {
  readonly proposal: Proposal;
  readonly agent: { readonly ready: boolean; readonly why: string };
  readonly measuring: { readonly answered: number; readonly total: number; readonly failed: number };
  readonly ready: boolean;
  readonly dryRun: ReturnType<typeof dryRunAdoption> | null;
  readonly judgedRefusal: Refusal | null;
  readonly onApprove: () => void;
  readonly onDecline: (note: string) => Promise<void> | void;
  readonly onSendBack: (note: string) => Promise<void> | void;
  readonly onAdopt: () => void;
};

/** The person's actions, each a deliberate click, with what core's dry run says beside them. */
function Actions({ proposal, agent, measuring, ready, dryRun, judgedRefusal, onApprove, onDecline, onSendBack, onAdopt }: ActionsProps) {
  const [form, setForm] = useState<"decline" | "send-back" | null>(null);
  const { status } = proposal;
  if (status === "adopted" || status === "declined") return null;
  const measured = measuring.total > 0 && measuring.answered === measuring.total && measuring.failed === 0;
  const progress = measured
    ? `Every example measured: ${measuring.total} frames.`
    : measuring.failed > 0
      ? `${measuring.failed === 1 ? "An example" : `${measuring.failed} examples`} could not be measured in every frame, so it cannot be adopted as it is.`
      : `Measuring the examples: ${measuring.answered} of ${measuring.total} frames answered.`;
  const verdict = judgedRefusal
    ? { tone: "critical" as const, text: `Core cannot judge the examples: [${judgedRefusal.code}] ${judgedRefusal.message}` }
    : !dryRun
      ? null
      : dryRun.ok
        ? { tone: "success" as const, text: `Core's adoption dry run: it would be adopted, classified ${classWords(dryRun.value.classification.class)}, and ${dryRun.value.newlyFailing.length === 0 ? "no prototype would newly fail" : `${dryRun.value.newlyFailing.length} ${dryRun.value.newlyFailing.length === 1 ? "prototype" : "prototypes"} would newly fail`}.` }
        : { tone: "warning" as const, text: `Core's adoption dry run refuses it: [${dryRun.error.code}] ${dryRun.error.message}` };
  return (
    <Card.Root className="review-actions" data-testid="review-actions">
      <Card.Body>
        <Stack.Root gap="condensed">
          <Stack.Root direction="row" align="center" gap="condensed" wrap>
            {status === "open" && (
              <Button.Root variant="primary" onClick={onApprove}>
                Approve
              </Button.Root>
            )}
            {status === "approved" && (
              <Button.Root variant="primary" onClick={onAdopt} disabled={!ready} aria-describedby="review-measuring">
                Adopt
              </Button.Root>
            )}
            {status === "open" && (
              <Button.Root variant="secondary" onClick={() => setForm(form === "send-back" ? null : "send-back")} aria-expanded={form === "send-back"}>
                Send back to the agent
              </Button.Root>
            )}
            <Button.Root variant="ghost" onClick={() => setForm(form === "decline" ? null : "decline")} aria-expanded={form === "decline"}>
              Decline
            </Button.Root>
          </Stack.Root>
          <Text.Root as="p" tone="muted" id="review-measuring" className="review-small" aria-live="polite" data-testid="review-measuring" data-measured={measured ? "" : undefined}>
            {progress}
            {status === "approved" && !ready ? " Adoption waits until every example, and every prototype in the project, is measured." : ""}
          </Text.Root>
          {verdict && (
            <Text.Root as="p" className="review-small review-verdict" data-tone={verdict.tone} data-testid="review-verdict">
              {verdict.text}
            </Text.Root>
          )}
          {form === "decline" && <NoteForm key="decline" label="Why decline it?" hint="Declining is final. The note is kept in the proposal's history." submit="Decline proposal" required="Say why you decline it." onCancel={() => setForm(null)} onSubmit={async (note) => {
            await onDecline(note);
            setForm(null);
          }} />}
          {form === "send-back" &&
            (agent.ready ? (
              <NoteForm key="send-back" label="What should the agent change?" hint="The note goes to the agent as a chat message naming this proposal, and into the proposal's history. The proposal stays open." submit="Send to the agent" required="Say what the agent should change." onCancel={() => setForm(null)} onSubmit={async (note) => {
                await onSendBack(note);
                setForm(null);
              }} />
            ) : (
              <Alert.Root tone="info">
                <Alert.Description>{agent.why}</Alert.Description>
              </Alert.Root>
            ))}
        </Stack.Root>
      </Card.Body>
    </Card.Root>
  );
}

/** A note the action needs, which it refuses to go without. */
function NoteForm({ label, hint, submit, required, onSubmit, onCancel }: { readonly label: string; readonly hint: string; readonly submit: string; readonly required: string; readonly onSubmit: (note: string) => Promise<void> | void; readonly onCancel: () => void }) {
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const fieldId = useMemo(() => `note-${submit.toLowerCase().replace(/[^a-z]+/g, "-")}`, [submit]);
  return (
    <form
      className="review-note"
      onSubmit={(event) => {
        event.preventDefault();
        if (note.trim() === "") return setProblem(required);
        setProblem(null);
        void onSubmit(note);
      }}
    >
      <Stack.Root gap="condensed">
        <Label.Root htmlFor={fieldId}>{label}</Label.Root>
        <Field.Root id={fieldId} invalid={problem !== null} {...(problem ? { "aria-describedby": `${fieldId}-problem` } : {})}>
          <Field.Textarea value={note} onValueChange={setNote} rows={3} autoGrow maxRows={8} />
        </Field.Root>
        {problem && (
          <ErrorMessage.Root id={`${fieldId}-problem`} role="alert">
            {problem}
          </ErrorMessage.Root>
        )}
        <Text.Root as="p" tone="muted" className="review-small">
          {hint}
        </Text.Root>
        <Stack.Root direction="row" gap="condensed">
          <Button.Root type="submit" variant="secondary">
            {submit}
          </Button.Root>
          <Button.Root type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button.Root>
        </Stack.Root>
      </Stack.Root>
    </form>
  );
}

/** A refusal from core, precisely: what was refused, core's words, the example and the earlier proposal it names, and its findings. */
function RefusalAlert({ action, refusal, onShowExample, onOpenProposal }: { readonly action: string; readonly refusal: Refusal; readonly onShowExample: (name: string) => void; readonly onOpenProposal: (id: string) => void }) {
  return (
    <Alert.Root tone="critical" data-testid="review-refusal" data-code={refusal.code}>
      <Alert.Title>Not {action === "adopt" ? "adopted" : action === "approve" ? "approved" : action === "decline" ? "declined" : "sent back"}: core refused it</Alert.Title>
      <Alert.Description>
        <Stack.Root gap="condensed">
          <Text.Root as="p" className="pre" data-testid="review-refusal-message">
            {refusal.message}
          </Text.Root>
          <DataList.Root orientation="horizontal" className="project-facts">
            <DataList.Item>
              <DataList.Term>Reason</DataList.Term>
              <DataList.Details>
                <Code.Root>{refusal.code}</Code.Root>
              </DataList.Details>
            </DataList.Item>
            {refusal.example && (
              <DataList.Item>
                <DataList.Term>Example</DataList.Term>
                <DataList.Details>
                  {refusal.proposal ? (
                    <>
                      <Code.Root>{refusal.example}</Code.Root> of adopted proposal{" "}
                      <Button.Root variant="ghost" onClick={() => onOpenProposal(refusal.proposal ?? "")}>
                        {refusal.proposal}
                      </Button.Root>
                    </>
                  ) : (
                    <Button.Root variant="ghost" onClick={() => onShowExample(refusal.example ?? "")}>
                      {`Show ${exampleLabel(refusal.example)}`}
                    </Button.Root>
                  )}
                </DataList.Details>
              </DataList.Item>
            )}
          </DataList.Root>
          {refusal.findings && refusal.findings.length > 0 && (
            <ul className="findings" aria-label="What core found">
              {refusal.findings.slice(0, 8).map((finding, index) => (
                <li key={index}>
                  <FindingButton finding={finding} selected={false} onSelect={() => refusal.example && onShowExample(refusal.example)} />
                </li>
              ))}
            </ul>
          )}
        </Stack.Root>
      </Alert.Description>
    </Alert.Root>
  );
}

/** Once adopted: the rules now in force, and what the re-check of every prototype found. */
function InForce({ proposal, config, adoption, prototypes, onOpenPrototype }: { readonly proposal: Proposal; readonly config: ProjectConfig; readonly adoption: Adoption | null; readonly prototypes: readonly PrototypeRecord[]; readonly onOpenPrototype: (id: string, finding?: Finding) => void }) {
  const adopted = proposal.history.at(-1);
  const inForce = proposal.rules.add.filter((rule) => config.rules.some((item) => item.id === rule.id));
  return (
    <Alert.Root tone="success" data-testid="review-in-force">
      <Alert.Title>
        Adopted{adopted?.by ? ` by ${adopted.by}` : ""}, <time dateTime={adopted?.at}>{formatTime(adopted?.at ?? "")}</time>
      </Alert.Title>
      <Alert.Description>
        <Stack.Root gap="condensed">
          {inForce.length > 0 ? (
            <Text.Root as="p">
              In force now, on every prototype: {inForce.map((rule) => rule.id).join(", ")}. The Checks panel runs {inForce.length === 1 ? "it" : "them"} on the open prototype.
            </Text.Root>
          ) : (
            <Text.Root as="p">Its changes are in the project&apos;s inventories{proposal.rules.remove.length > 0 ? `, and ${proposal.rules.remove.join(", ")} left force` : ""}.</Text.Root>
          )}
          {adoption && (
            <Text.Root as="p" data-testid="review-rechecked">
              Every prototype was re-checked: {adoption.newlyFailing.length === 0 ? "none newly fails." : `${adoption.newlyFailing.map((item) => item.name).join(", ")} newly ${adoption.newlyFailing.length === 1 ? "fails" : "fail"}.`}
            </Text.Root>
          )}
          {adoption?.newlyFailing.map((item) => {
            const record = prototypes.find((entry) => entry.name === item.name);
            return record ? (
              <div key={item.name}>
                <Button.Root variant="secondary" onClick={() => onOpenPrototype(record.id, item.findings[0])}>
                  {`Open ${item.name} on the board`}
                </Button.Root>
              </div>
            ) : null;
          })}
        </Stack.Root>
      </Alert.Description>
    </Alert.Root>
  );
}

/** What it changes: the inventories and rule inputs before and after, and each rule it adds or removes in words. */
function Changes({ proposal, config, renderConfig, views, onShowExample }: { readonly proposal: Proposal; readonly config: ProjectConfig; /** The project with the proposal applied. */ readonly renderConfig: ProjectConfig; readonly views: readonly ExampleView[]; readonly onShowExample: (name: string) => void }) {
  const diff = proposal.status === "adopted" ? null : inventoryDiff(config, proposal);
  const added = proposal.inventory.flatMap((op) => (op.op === "add-component" ? [op.name] : []));
  const dropped = proposal.inventory.flatMap((op) => (op.op === "remove-component" ? [op.name] : []));
  const quiet = renderConfig.inventories.components.filter((name) => !added.includes(name));
  // The rule inputs it moves, each as its figure: a cap, a step budget, a page type's slots.
  const figured = proposal.inventory.filter((op) => FIGURED_OPS.includes(op.op));
  const removed = proposal.rules.remove.map((id) => ({ id, rule: config.rules.find((rule) => rule.id === id) }));
  return (
    <section aria-labelledby="review-changes" className="review-section">
      <Text.Root as="h2" id="review-changes">
        What it changes
      </Text.Root>
      {proposal.inventory.length === 0 ? (
        <Text.Root as="p" tone="muted">
          No inventory or rule input changes; only rules.
        </Text.Root>
      ) : diff === null ? (
        <Text.Root as="p" tone="muted">
          Adopted: these changes are in the project now. {proposal.inventory.length} {proposal.inventory.length === 1 ? "operation" : "operations"}: {proposal.inventory.map((op) => op.op).join(", ")}.
        </Text.Root>
      ) : !diff.ok ? (
        <Alert.Root tone="warning">
          <Alert.Description>It cannot apply to the project as it is now: {diff.error}</Alert.Description>
        </Alert.Root>
      ) : (
        <div className="diff" data-testid="inventory-diff">
          {diff.value.map((section) => (
            <DiffView key={section.key} section={section} />
          ))}
        </div>
      )}
      {(added.length > 0 || dropped.length > 0) && (
        <div className="palette-after" data-testid="palette-after">
          <div className="section-head">
            <Text.Root as="h3">What a prototype could build with, after</Text.Root>
            <Text.Root as="p" tone="muted">
              {added.length > 0 ? `The new ${added.length === 1 ? "part is" : "parts are"} drawn by ${config.library.package} ${config.library.version}, as the examples below draw ${added.length === 1 ? "it" : "them"}.` : `What it removes is drawn by ${config.library.package} ${config.library.version}, as it is in the project now.`}
            </Text.Root>
          </div>
          <ul className="palette" aria-label="Components it adds or removes">
            {added.map((name) => (
              <li key={name}>
                <SpecimenTile config={renderConfig} component={name} mark="new">
                  <Text.Root as="p" tone="muted">
                    {proposal.status === "adopted" ? "Added by this proposal." : "Before: not in the inventory."}
                  </Text.Root>
                </SpecimenTile>
              </li>
            ))}
            {dropped.map((name) => (
              <li key={name}>
                <SpecimenTile config={config} component={name} mark="removed">
                  <Text.Root as="p" tone="muted">
                    {proposal.status === "adopted" ? "Removed by this proposal." : "After: not in the inventory."}
                  </Text.Root>
                </SpecimenTile>
              </li>
            ))}
          </ul>
          <Text.Root as="p" tone="muted" className="review-small">
            {quiet.length === 0 ? "Nothing else is in the inventory." : `Unchanged beside ${added.length + dropped.length === 1 ? "it" : "them"}: ${quiet.join(", ")}.`}
          </Text.Root>
        </div>
      )}
      {figured.length > 0 && (
        <ul className="review-rules op-figures" aria-label="The limits it moves, drawn" data-testid="op-figures">
          {figured.map((op, index) => (
            <li key={index} className="op-figure preview" data-op={op.op}>
              <PreviewFigure preview={proposalPreview({ ...proposal, inventory: [op] }, config)} config={config} />
            </li>
          ))}
        </ul>
      )}
      {proposal.rules.add.length > 0 && (
        <>
          <div className="section-head">
            <Text.Root as="h3">
              {proposal.rules.add.length === 1 ? "The rule it adds, and its proof" : `The ${proposal.rules.add.length} rules it adds, and their proof`}
            </Text.Root>
            <Text.Root as="p" tone="muted">
              Each rule in core&apos;s words, with a picture when it is about how the page looks, and two of the proposal&apos;s examples: one it must pass and one it must flag. They are examples, not a before and after.
            </Text.Root>
          </div>
          <ul className="review-rules" aria-label="Rules it adds">
            {proposal.rules.add.map((rule) => (
              <li key={rule.id}>
                <Card.Root className="rule-proof" data-rule-proof={rule.id}>
                  <div className="rule-proof-rule">
                    <RuleFigure rule={rule} label={ruleBound(rule, renderConfig)} />
                    <RuleWords rule={rule} config={config} />
                  </div>
                  <Proof proposal={proposal} rule={rule.id} views={views} config={renderConfig} onShowExample={onShowExample} />
                </Card.Root>
              </li>
            ))}
          </ul>
        </>
      )}
      {removed.length > 0 && (
        <>
          <Text.Root as="h3">
            Removes {removed.length === 1 ? "a rule" : `${removed.length} rules`}
          </Text.Root>
          <ul className="review-rules" aria-label="Rules it removes">
            {removed.map(({ id, rule }) => (
              <li key={id}>
                <Stack.Root direction="row" align="center" gap="condensed">
                  <Badge.Root tone="critical">removes</Badge.Root>
                  <Code.Root>{id}</Code.Root>
                </Stack.Root>
                {rule ? (
                  <RuleWords rule={rule} config={config} />
                ) : (
                  <Text.Root as="p" tone="muted">
                    Not in force now.
                  </Text.Root>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const FIGURED_OPS: readonly InventoryOp["op"][] = ["add-cap", "set-cap", "set-max-steps", "add-task", "add-page-type"];

/**
 * A rule's proof, right under it: the first failing example the rule must
 * flag and the first passing example, each drawn in a frame of its own at
 * one scenario and view, with core's verdict. The failing one is outlined
 * where core's finding points, with core's message quoted. The pair is two
 * examples, not a diff: nothing says they differ only by what is outlined.
 */
function Proof({ proposal, rule, views, config, onShowExample }: { readonly proposal: Proposal; readonly rule: string; readonly views: readonly ExampleView[]; readonly config: ProjectConfig; readonly onShowExample: (name: string) => void }) {
  const pair = proofPair(proposal, rule);
  const fail = views.find((view) => view.expect === "fail" && view.name === pair.fail);
  const pass = views.find((view) => view.expect === "pass" && view.name === pair.pass);
  // Both are drawn at the scenario and view the rule flags the failing one in, when it has one there.
  const flagged = fail?.findings.find((finding) => finding.rule === rule && finding.scenario !== undefined && finding.view !== undefined) ?? fail?.findings.find((finding) => finding.scenario !== undefined) ?? fail?.findings.find((finding) => finding.page !== undefined);
  if (!fail && !pass) {
    return (
      <Text.Root as="p" tone="muted" data-testid="proof-none">
        No example proves this rule. Core adopts a rule only when a failing example is flagged by it.
      </Text.Root>
    );
  }
  return (
    <div className="proof" data-testid="rule-proof">
      {pass ? <ProofExample view={pass} config={config} at={flagged} onShow={() => onShowExample(pass.name)} /> : <Text.Root as="p" tone="muted">No passing example.</Text.Root>}
      {fail ? (
        <ProofExample view={fail} config={config} at={flagged} rule={rule} onShow={() => onShowExample(fail.name)} />
      ) : (
        <Text.Root as="p" tone="muted" data-testid="proof-none">
          No failing example is flagged by this rule, so core will refuse to adopt it.
        </Text.Root>
      )}
    </div>
  );
}

function ProofExample({ view, config, at, rule, onShow }: { readonly view: ExampleView; readonly config: ProjectConfig; readonly at: Finding | undefined; readonly rule?: string; readonly onShow: () => void }) {
  const { prototype } = view.example;
  const scenario = prototype.scenarios.find((item) => item.id === at?.scenario) ?? prototype.scenarios.find((item) => item.page === at?.page) ?? prototype.scenarios[0];
  // The view core's finding is in, else the narrowest, where a page reads at close to its own size.
  const shownView = config.views.find((item) => item.name === at?.view) ?? [...config.views].sort((a, b) => a.width - b.width)[0];
  // One scenario at one view, in a session of its own: the full set is measured in the Examples section below.
  const items = useMemo(() => {
    if (!scenario || !shownView) return [];
    return [{ id: `proof:${view.name}`, config: { ...config, views: [shownView] }, prototype: { ...prototype, scenarios: [scenario] } }];
  }, [config, prototype, scenario, shownView, view.name]);
  const [measured] = useSessions(items);
  const [area, width] = useWidth();
  const frame = measured?.state.frames[0];
  const frameState = measured && frame ? (measured.state.frameStates[frame.key] ?? { state: "waiting" as const }) : undefined;
  // What core's finding points at in this frame: the same element index, since the frame draws the same page at the same view.
  const finding = rule ? (view.findings.find((item) => item.rule === rule && item.scenario === scenario?.id && item.view === shownView?.name) ?? view.findings.find((item) => item.rule === rule) ?? view.findings[0]) : undefined;
  const element = finding && finding.scenario === scenario?.id && finding.view === shownView?.name ? finding.element : undefined;
  const measuredNow = frameState?.state === "measured";
  useEffect(() => {
    if (!measured || !frame || !measuredNow) return;
    measured.session.highlight(frame.key, element ?? null);
  }, [measured?.session, frame?.key, measuredNow, element]);
  const badge = verdictBadge(view);
  const scale = shownView ? Math.min(1, Math.max(0.08, (width - 4) / shownView.width)) : 1;
  return (
    <figure className="proof-example" data-proof={view.name} data-expect={view.expect} data-verdict={view.verdict.state}>
      <figcaption className="proof-head">
        <span className="proof-mark" data-expect={view.expect} aria-hidden="true">
          {view.expect === "pass" ? <Check /> : <X />}
        </span>
        <Text.Root as="span" weight="medium">
          {exampleLabel(view.name)}
        </Text.Root>
        <Text.Root as="span" tone="muted">
          an example that must {view.expect}
        </Text.Root>
        <Badge.Root tone={badge.tone} data-testid="proof-verdict">
          {badge.text}
        </Badge.Root>
      </figcaption>
      <div className="example-frames proof-frame" ref={area}>
        {measured && frame && frameState && <FrameViewport session={measured.session} spec={frame} revision={measured.state.revision} frameState={frameState} scale={scale} hidden={false} name={`${view.name}, as proof: ${frame.scenario.id} at ${frame.view.name}`} fit />}
      </div>
      <Text.Root as="p" tone="muted" className="review-small">
        {scenario ? scenarioName(scenario) : "No scenario"}
        {shownView ? `, ${viewLabel(shownView.name).toLowerCase()}` : ""}.
      </Text.Root>
      {finding && view.verdict.state !== "not-judged" && (
        <Text.Root as="p" className="fix-message" data-testid="proof-message">
          {finding.message}
        </Text.Root>
      )}
      <div>
        <Button.Root variant="ghost" className="review-back" onClick={onShow}>
          {`Show ${exampleLabel(view.name)} in every view`}
        </Button.Root>
      </div>
    </figure>
  );
}

function DiffView({ section }: { readonly section: DiffSection }) {
  if (section.kind === "list") {
    const items = (list: readonly string[], side: "before" | "after") =>
      list.map((item) => {
        const changed = side === "after" ? section.added.includes(item) : section.removed.includes(item);
        return (
          <li key={item} data-change={changed ? (side === "after" ? "added" : "removed") : undefined}>
            <Badge.Root tone={changed ? (side === "after" ? "success" : "critical") : "neutral"}>
              {changed ? (side === "after" ? "+ " : "− ") : ""}
              {item}
            </Badge.Root>
          </li>
        );
      });
    return (
      <div className="diff-section" data-section={section.key}>
        <Text.Root as="h3">{section.title}</Text.Root>
        <div className="diff-sides">
          <div>
            <Text.Root as="p" tone="muted" className="review-small">
              Before
            </Text.Root>
            <ul className="diff-list" aria-label={`${section.title} before`}>
              {items(section.before, "before")}
            </ul>
          </div>
          <div>
            <Text.Root as="p" tone="muted" className="review-small">
              After
            </Text.Root>
            <ul className="diff-list" aria-label={`${section.title} after`}>
              {items(section.after, "after")}
            </ul>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="diff-section" data-section={section.key}>
      <Text.Root as="h3">{section.title}</Text.Root>
      <Table.Root className="project-table" aria-label={section.title}>
        <Table.Head>
          <Table.Row>
            <Table.HeaderCell>Name</Table.HeaderCell>
            <Table.HeaderCell>Before</Table.HeaderCell>
            <Table.HeaderCell>After</Table.HeaderCell>
          </Table.Row>
        </Table.Head>
        <Table.Body>
          {section.rows.map((row) => (
            <Table.Row key={row.name} data-change={row.change}>
              <Table.Cell>
                <Code.Root>{row.name}</Code.Root>
              </Table.Cell>
              <Table.Cell>{row.before ?? <Badge.Root tone="neutral">none</Badge.Root>}</Table.Cell>
              <Table.Cell>{row.after ?? <Badge.Root tone="critical">removed</Badge.Root>}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </div>
  );
}

/** Passing examples on one side, failing on the other, each in frames at the chosen scenario and views. */
function Examples({ views, config, status, focus, onFocused }: { readonly views: readonly ExampleView[]; readonly config: ProjectConfig; readonly status: Proposal["status"]; readonly focus: string | null; readonly onFocused: () => void }) {
  const scenarios = useMemo(() => [...new Set(views.flatMap((view) => view.example.prototype.scenarios.map((scenario) => scenario.id)))], [views]);
  // Every example's scenarios, to name one by its page and state where only its id is in hand.
  const known = useMemo(() => views.flatMap((view) => view.example.prototype.scenarios), [views]);
  // The scenario the first failing example is flagged in, so the page opens on what the rule catches.
  const flaggedScenario = useMemo(() => {
    for (const view of views.filter((item) => item.expect === "fail")) {
      const finding = view.findings.find((item) => item.scenario !== undefined) ?? view.findings.find((item) => item.page !== undefined);
      if (finding?.scenario) return finding.scenario;
      if (finding?.page) return view.example.prototype.scenarios.find((scenario) => scenario.page === finding.page)?.id;
    }
    return undefined;
  }, [views]);
  const [chosen, setChosen] = useState<string | null>(null);
  const scenario = chosen ?? flaggedScenario ?? scenarios[0] ?? "";
  const [viewName, setViewName] = useState<string>("all");
  const shownViews = viewName === "all" ? config.views : config.views.filter((view) => view.name === viewName);

  useEffect(() => {
    if (!focus) return;
    const view = views.find((item) => item.name === focus);
    const finding = view?.findings.find((item) => item.scenario !== undefined);
    if (finding?.scenario) setChosen(finding.scenario);
    document.querySelector(`.example[data-example="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: "start" });
    onFocused();
  }, [focus, views, onFocused]);

  const column = (expect: "pass" | "fail") => (
    <div className="review-column" data-expect={expect}>
      <Text.Root as="h3">{expect === "pass" ? "Must pass" : "Must fail, for the named rule alone"}</Text.Root>
      {views
        .filter((view) => view.expect === expect)
        .map((view) => (
          <ExampleCard key={view.name} view={view} scenario={scenario} views={shownViews} status={status} />
        ))}
    </div>
  );

  return (
    <section aria-labelledby="review-examples" className="review-section">
      <Text.Root as="h2" id="review-examples">
        Examples
      </Text.Root>
      <Text.Root as="p" tone="muted">
        Each example is a prototype, rendered and measured in its own frames{status === "adopted" ? "; its verdict is re-run on the snapshots stored when it was adopted" : ""}. A failing example is outlined where its rule flags it.
      </Text.Root>
      <Stack.Root direction="row" align="center" gap="normal" wrap className="review-pickers">
        <Stack.Root direction="row" align="center" gap="condensed">
          <Label.Root htmlFor="review-scenario">Scenario</Label.Root>
          <Field.Root id="review-scenario" className="review-picker">
            <Field.Select value={scenario} onValueChange={setChosen}>
              {scenarios.map((id) => (
                <option key={id} value={id}>
                  {scenarioNameOf(id, known)}
                  {id === flaggedScenario ? " (flagged)" : ""}
                </option>
              ))}
            </Field.Select>
          </Field.Root>
        </Stack.Root>
        <Stack.Root direction="row" align="center" gap="condensed">
          <Label.Root htmlFor="review-view">View</Label.Root>
          <Field.Root id="review-view" className="review-picker">
            <Field.Select value={viewName} onValueChange={setViewName}>
              <option value="all">Every view</option>
              {config.views.map((view) => (
                <option key={view.name} value={view.name}>
                  {viewLabel(view.name)}
                </option>
              ))}
            </Field.Select>
          </Field.Root>
        </Stack.Root>
      </Stack.Root>
      <div className="review-columns">
        {column("pass")}
        {column("fail")}
      </div>
    </section>
  );
}

function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // The content box: the frames sit inside the area's padding.
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function verdictBadge(view: ExampleView): { tone: "success" | "critical" | "info" | "warning" | "neutral"; text: string } {
  switch (view.verdict.state) {
    case "measuring":
      return { tone: "info", text: "measuring" };
    case "unmeasured":
      return { tone: "warning", text: "not measured" };
    case "ok":
      return { tone: "success", text: view.expect === "pass" ? "passes" : `fails for ${(view.example as FailingExample).flaggedBy.rule} alone` };
    case "bad":
      return { tone: "critical", text: "does not behave" };
    case "not-judged":
      return { tone: "neutral", text: "not judged" };
  }
}

function ExampleCard({ view, scenario, views, status }: { readonly view: ExampleView; readonly scenario: string; readonly views: readonly View[]; readonly status: Proposal["status"] }) {
  const { frames } = view;
  const [area, width] = useWidth();
  const shown = frames.state.frames.filter((spec) => spec.scenario.id === scenario && views.some((item) => item.name === spec.view.name));
  // Each view fits the card's width on its own, no taller than FRAME_MAX_HEIGHT, so a phone is not a sliver beside a desktop.
  const scaleOf = (view: View) => Math.min(1, Math.max(0.08, Math.min((width - 4) / view.width, FRAME_MAX_HEIGHT / view.height)));
  const badge = verdictBadge(view);
  // Point at what the rule flags, with the frame's own outline, once the frame has measured.
  const pointed = useMemo(() => {
    const out = new Map<string, number>();
    for (const finding of view.findings) {
      if (finding.scenario === undefined || finding.view === undefined || finding.element === undefined) continue;
      const key = frameKey(finding.scenario, finding.view);
      if (!out.has(key)) out.set(key, finding.element);
    }
    return out;
  }, [view.findings]);
  const pointedKey = [...pointed.entries()].map(([key, element]) => `${key}=${element}`).join(",");
  const measured = frames.state.measured;
  useEffect(() => {
    if (!measured) return;
    for (const spec of frames.state.frames) frames.session.highlight(spec.key, pointed.get(spec.key) ?? null);
    // Re-pointed when the frames are measured, the session changes or the findings do.
  }, [measured, frames.session, frames.state.revision, pointedKey]);
  const source = view.findings.find((finding) => finding.file !== undefined && finding.line !== undefined);
  const flaggedElsewhere = view.findings.length > 0 && !view.findings.some((finding) => finding.scenario === undefined || finding.scenario === scenario);
  const rule = view.expect === "fail" ? (view.example as FailingExample).flaggedBy : null;
  // A failing example's figure: what its rule measured on the scenario shown, or on the first it flags.
  const pictured = view.expect === "fail" && status !== "declined" ? (view.findings.find((finding) => finding.scenario === scenario) ?? view.findings[0]) : undefined;

  return (
    <Card.Root className="example" data-example={view.name} data-expect={view.expect} data-verdict={view.verdict.state}>
      <Card.Header className="example-head">
        <Stack.Root direction="row" align="center" gap="condensed" wrap>
          <Text.Root as="h4" className="example-name">
            {exampleLabel(view.name)}
          </Text.Root>
          <Badge.Root tone={badge.tone} data-testid="example-verdict">
            {badge.text}
          </Badge.Root>
        </Stack.Root>
        {rule && (
          <Text.Root as="p" tone="muted" className="review-small">
            Must be flagged by <Code.Root>{rule.rule}</Code.Root>
            {rule.message ? <> with a finding that says &quot;{rule.message}&quot;</> : null}, and by no other rule.
          </Text.Root>
        )}
      </Card.Header>
      <Card.Body>
        <Stack.Root gap="condensed">
          <div className="example-frames" ref={area}>
            {frames.state.frames.map((spec) => {
              const visible = shown.includes(spec);
              return (
                <FrameCard
                  key={spec.key}
                  session={frames.session}
                  spec={spec}
                  revision={frames.state.revision}
                  frameState={frames.state.frameStates[spec.key] ?? { state: "waiting" }}
                  scale={scaleOf(spec.view)}
                  focused={false}
                  hidden={!visible}
                  selected={visible && pointed.has(spec.key)}
                  label={view.name}
                  caption={exampleLabel(view.name)}
                />
              );
            })}
          </div>
          {flaggedElsewhere && (
            <Text.Root as="p" tone="muted" className="review-small">
              Flagged in another scenario: {[...new Set(view.findings.flatMap((finding) => finding.scenario ?? []))].map((id) => scenarioNameOf(id, view.example.prototype.scenarios)).join("; ")}.
            </Text.Root>
          )}
          <Text.Root as="p" className="pre review-small example-detail" data-testid="example-detail">
            {view.verdict.text}
          </Text.Root>
          {/* Only a finding whose evidence draws: any other reads whole in core's message, in the list below. */}
          {pictured && drawsFigure(pictured) && (
            <EvidenceFigure finding={pictured} findings={view.findings}>
              <Text.Root as="p" className="fix-message" data-testid="example-figure-message">
                {pictured.message}
              </Text.Root>
            </EvidenceFigure>
          )}
          {view.findings.length > 0 && status !== "declined" && (
            <ul className="findings" aria-label={`What core found in ${exampleLabel(view.name)}`}>
              {view.findings.slice(0, 4).map((finding, index) => (
                <li key={index}>
                  <FindingButton finding={finding} selected={false} onSelect={() => undefined} />
                </li>
              ))}
              {view.findings.length > 4 && (
                <li>
                  <Text.Root as="span" tone="muted" className="review-small">
                    and {view.findings.length - 4} more
                  </Text.Root>
                </li>
              )}
            </ul>
          )}
          {source && <SourceLine view={view} finding={source} />}
        </Stack.Root>
      </Card.Body>
    </Card.Root>
  );
}

/** The flagged line in the example's file, marked as the code view marks a finding's line. */
function SourceLine({ view, finding }: { readonly view: ExampleView; readonly finding: Finding }) {
  const file = finding.file ?? "";
  const text = view.example.prototype.files[file];
  if (text === undefined || finding.line === undefined) return null;
  const lines = text.split("\n");
  const from = Math.max(1, finding.line - 2);
  const to = Math.min(lines.length, finding.line + 2);
  const excerpt = lines.slice(from - 1, to).join("\n");
  const range = lineRange(excerpt, finding.line - from + 1);
  return (
    <div className="example-source">
      <Text.Root as="p" tone="muted" className="review-small">
        {file}, line {finding.line}
      </Text.Root>
      <Field.Root className="code-field example-code" aria-label={`${exampleLabel(view.name)}: ${file} around line ${finding.line}`}>
        <Field.Textarea value={excerpt} readOnly highlights={[{ ...range, kind: "finding" }]} rows={to - from + 1} spellCheck={false} className="code-text" data-testid="example-source" />
      </Field.Root>
    </div>
  );
}

/** Which of the project's prototypes would newly fail once it is adopted, with what core finds. */
/**
 * The frames that measure the project's other prototypes for the impact:
 * laid out at their views' sizes, so they measure as the board would, but
 * not shown. Without them those sessions would wait forever for frames.
 */
function OtherFrames({ items }: { readonly items: readonly Measured[] }) {
  return (
    <div className="impact-frames" aria-hidden="true" data-testid="impact-frames">
      {items.flatMap((item) =>
        item.state.frames.map((spec) => (
          <FrameCard key={`${item.key}:${spec.key}`} session={item.session} spec={spec} revision={item.state.revision} frameState={item.state.frameStates[spec.key] ?? { state: "waiting" }} scale={0.25} focused={false} hidden selected={false} label={item.id} />
        )),
      )}
    </div>
  );
}

/**
 * Core's adoption check as a grid of the project's prototypes: every one is
 * a tile, so it is plain each was checked. One that would newly fail is
 * outlined, says what fails in core's words, shows a miniature of the page
 * from its measured boxes with what core flags hatched, and opens on the
 * board. The rest carry a name and a mark.
 */
function Impact({ impact, measuring, dryRun, prototypes, existing, views, onOpenPrototype }: { readonly impact: readonly NewlyFailing[] | null; readonly measuring: boolean; readonly dryRun: ReturnType<typeof dryRunAdoption> | null; readonly prototypes: readonly PrototypeRecord[]; readonly existing: readonly ExistingPrototype[] | null; readonly views: readonly View[]; readonly onOpenPrototype: (id: string, finding?: Finding) => void }) {
  return (
    <section aria-labelledby="review-impact" className="review-section" data-testid="review-impact">
      <Text.Root as="h2" id="review-impact">
        Impact on the project
      </Text.Root>
      <Text.Root as="p" tone="muted">
        Core&apos;s adoption check against every prototype in the project, each measured in frames: the ones that would newly fail{dryRun && !dryRun.ok ? " with the proposal applied, though the dry run refuses it as it is" : ""}.
      </Text.Root>
      {impact === null || existing === null ? (
        <Text.Root as="p" tone="muted">
          {measuring ? "Measuring the project's prototypes and the examples…" : "Waiting for the examples to be measured."}
        </Text.Root>
      ) : (
        <>
          <Text.Root as="p" data-testid={impact.length === 0 ? "impact-none" : "impact-some"}>
            {impact.length === 0 ? "No prototype in the project would newly fail." : `${impact.length} of ${existing.length} ${existing.length === 1 ? "prototype" : "prototypes"} would newly fail.`}
          </Text.Root>
          <ul className="impact-grid" aria-label="The project's prototypes, with the proposal applied">
            {existing.map((item) => {
              const failing = impact.find((entry) => entry.name === item.name);
              const record = prototypes.find((entry) => entry.name === item.name);
              const flagged = failing ? flaggedIn(failing.findings, item.snapshots ?? []) : null;
              const view = flagged ? views.find((entry) => entry.name === flagged.snapshot.view) : undefined;
              return (
                <li key={item.name} data-prototype={record?.id ?? item.name} data-impact={failing ? "fails" : "holds"}>
                  <Card.Root className="impact-tile">
                    {failing && flagged && view && (
                      <figure className="impact-thumb">
                        <SnapshotThumb snapshot={flagged.snapshot} view={view} flagged={flagged.elements} />
                        <figcaption className="review-small">
                          {scenarioNameOf(flagged.snapshot.scenario, item.prototype.scenarios)}, {viewLabel(flagged.snapshot.view).toLowerCase()}, in miniature from measured boxes; what core flags is hatched.
                        </figcaption>
                      </figure>
                    )}
                    <Text.Root as="h3" className="example-name">
                      {item.name}
                    </Text.Root>
                    {failing ? (
                      <>
                        <span className="vis-verdict">
                          <span className="vis-verdict-icon" aria-hidden="true">
                            <X />
                          </span>
                          would newly fail {failing.rules.join(", ") || "with new findings"}
                        </span>
                        <ul className="findings" aria-label={`New findings in ${item.name}`}>
                          {failing.findings.map((finding, index) => (
                            <li key={index}>
                              <FindingButton finding={finding} selected={false} onSelect={() => record && onOpenPrototype(record.id, finding)} />
                            </li>
                          ))}
                        </ul>
                        {record && (
                          <div>
                            <Button.Root variant="secondary" onClick={() => onOpenPrototype(record.id)}>
                              Open on the board
                            </Button.Root>
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="vis-verdict" data-ok="">
                        <span className="vis-verdict-icon" aria-hidden="true">
                          <Check />
                        </span>
                        no new failure
                      </span>
                    )}
                  </Card.Root>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/** Every status change, revision and send-back, by whom and when, with its note; a revision opens to the version it replaced. */
function History({ proposal, config }: { readonly proposal: Proposal; readonly config: ProjectConfig }) {
  const timeline = proposalTimeline(proposal);
  return (
    <section aria-labelledby="review-history" className="review-section">
      <Text.Root as="h2" id="review-history">
        History
      </Text.Root>
      <Steps.Root variant="progress" className="review-history" aria-label="History" data-testid="review-history">
        {timeline.map((entry, index) => (
          <Steps.Item key={index} status="done" statusLabel="" data-kind={entry.kind} data-entry-status={entry.kind === "status" ? entry.status : undefined}>
            <HistoryEntry entry={entry} config={config} />
          </Steps.Item>
        ))}
        <Steps.Item status="current" statusLabel="" data-kind="now">
          <Text.Root as="span" tone="muted">
            Now: {proposal.status}
            {proposal.events?.some((event) => event.kind === "revised") ? `, version ${1 + (proposal.events?.filter((event) => event.kind === "revised").length ?? 0)} shown above` : ""}
          </Text.Root>
        </Steps.Item>
      </Steps.Root>
    </section>
  );
}

function HistoryEntry({ entry, config }: { readonly entry: TimelineEntry; readonly config: ProjectConfig }) {
  return (
    <Stack.Root gap="none" className="history-entry">
      <Text.Root as="span" weight="medium">
        {timelineTitle(entry)}
        <Text.Root as="span" tone="muted">
          {" "}
          · <time dateTime={entry.at}>{formatTime(entry.at)}</time>
        </Text.Root>
      </Text.Root>
      {entry.note && (
        <Text.Root as="p" className="pre history-note" data-testid="history-note">
          {entry.note}
        </Text.Root>
      )}
      {entry.kind === "revised" && (
        <Disclosure.Root className="history-previous">
          <Disclosure.Summary>The version before this revision</Disclosure.Summary>
          <PreviousVersion content={entry.previous} config={config} />
        </Disclosure.Root>
      )}
    </Stack.Root>
  );
}

function PreviousVersion({ content, config }: { readonly content: ProposalContent; readonly config: ProjectConfig }): ReactNode {
  return (
    <Stack.Root gap="condensed" className="history-version" data-testid="history-previous">
      <DataList.Root orientation="horizontal" className="project-facts">
        <DataList.Item>
          <DataList.Term>Title</DataList.Term>
          <DataList.Details>{content.title}</DataList.Details>
        </DataList.Item>
        <DataList.Item>
          <DataList.Term>Reason</DataList.Term>
          <DataList.Details>{content.reason}</DataList.Details>
        </DataList.Item>
        <DataList.Item>
          <DataList.Term>Inventory</DataList.Term>
          <DataList.Details>{content.inventory.map((op) => op.op).join(", ") || "no changes"}</DataList.Details>
        </DataList.Item>
        <DataList.Item>
          <DataList.Term>Rules</DataList.Term>
          <DataList.Details>
            {[...content.rules.add.map((rule) => `adds ${rule.id}: ${describeRule(rule, config)}`), ...content.rules.remove.map((id) => `removes ${id}`)].join(" ") || "none"}
          </DataList.Details>
        </DataList.Item>
        <DataList.Item>
          <DataList.Term>Examples</DataList.Term>
          <DataList.Details>
            pass: {content.examples.pass.map((example) => example.name).join(", ") || "none"}; fail: {content.examples.fail.map((example) => `${example.name} (by ${example.flaggedBy.rule})`).join(", ") || "none"}
          </DataList.Details>
        </DataList.Item>
      </DataList.Root>
      <Disclosure.Root>
        <Disclosure.Summary>As data</Disclosure.Summary>
        <pre className="project-json">{JSON.stringify({ ...content, examples: { pass: content.examples.pass.map((example) => example.name), fail: content.examples.fail.map((example) => ({ name: example.name, flaggedBy: example.flaggedBy })) } }, null, 2)}</pre>
      </Disclosure.Root>
    </Stack.Root>
  );
}
