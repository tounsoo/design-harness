import { Alert, Badge, Button, Card, Code, DataList, Disclosure, EmptyState, ErrorMessage, Field, Label, Stack, Steps, Table, Text } from "@tounsoo/todae";
import { ArrowDown, Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  applyProposal,
  checkPrototype,
  describeRule,
  dryRunAdoption,
  newlyFailingOf,
  rerunExamples,
  ruleTypeIssue,
  supersededExamples,
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
  type RuleSpec,
  type RuleTypeExample,
  type View,
} from "@design-harness/core";
import { frameKey, type Session, type SessionState } from "../runtime/session";
import type { PrototypeRecord } from "../store/project-file";
import { acceptProposal, approveProposal, declineProposal, sendBackProposal, type ExampleMeasurement } from "../review/actions";
import { inventoryDiff, type DiffSection } from "../review/diff";
import { applyExampleFix, exampleFixes, type ExampleFix } from "../review/fix-examples";
import { replacedWords } from "../review/replaced";
import { waitingWords, type MeasuredThing } from "../review/waiting";
import { ExampleFixCard } from "./ExampleFix";
import { useStalled } from "./stall";
import { formatDay, fromWords, loosensWords, plainChanges, plainRefusal, ruleSentence, standingWords, waitsForYou } from "../review/plain";
import { REVIEWER, draftedBy, formatTime, ownProposal, proposalTimeline, timelineTitle, type TimelineEntry } from "../review/timeline";
import { FrameCard, FrameViewport } from "./Board";
import { EvidenceFigure, drawsFigure } from "../visual/figures";
import { ClassScale, ProposalTrack, RuleFigure, SlotDiagram } from "../visual/project-figures";
import { proofPair, proposalPreview, ruleBound, ruleGlyph, ruleLines } from "../visual/project-model";
import { FindingButton } from "./ChecksPanel";
import { lineRange } from "./CodePanel";
import { SpecimenTile } from "./Palette";
import { PreviewFigure, RuleLineView, SnapshotThumb, flaggedIn } from "./ProposalPreview";
import { ClassBadge, RequestBadge, RuleWords, StatusBadge, classWords, classificationOf } from "./proposal-parts";
import { MeasureFrames, useProjectExisting } from "./project-measure";
import { useSessions, type Measured } from "./sessions";
import { exampleLabel, frameNameOf, humanize, scenarioName, scenarioNameOf, viewLabel } from "./words";

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
 * A proposal's review page, for a designer deciding: what changes in plain
 * sentences with example screens that would be allowed and not allowed, what
 * accepting it does to the project's prototypes, and then the decision,
 * which only the person can take. Everything core says, word for word (its
 * classification, dry run, ids, rule data, every example's verdict and the
 * history) is in one closed section at the end. Every verdict on the page is
 * core's: the page renders, measures, and passes the snapshots to core.
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
 * the page says so first, in plain words: what the rule should check, why,
 * its examples in words, why the app cannot check it yet, and the request
 * ready to copy and file. There is no Accept: core refuses to approve or
 * adopt a request, and its refusal, word for word, is in the details. Asking
 * the agent for changes and declining work as on any proposal.
 */
function RequestReview({ config, proposal, agent, onBack, onSave, onSendBack }: Props & { readonly proposal: Proposal }) {
  const request = proposal.needsRuleType;
  const issue = ruleTypeIssue(proposal);
  const id = proposal.id;
  const [refusal, setRefusal] = useState<{ readonly action: string; readonly refusal: Refusal } | null>(null);
  const [copied, setCopied] = useState<Copied>({ state: "idle" });
  const [details, setDetails] = useState(false);
  if (!request || !issue) return null;
  const text = `# ${issue.title}\n\n${issue.body}\n`;
  // Core's own answer to approving it, shown so the page never claims more than core says.
  const approval = approveProposal(config, id, "dry run");
  const refused = approval.ok ? null : approval.error;
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
        <ReviewHead proposal={proposal} onBack={onBack} />

        <Alert.Root tone="warning" data-testid="rule-type-request">
          <Alert.Title>This can&apos;t be accepted here: it needs a code change first</Alert.Title>
          <Alert.Description>
            <Stack.Root gap="condensed">
              <Text.Root as="p">
                The app has no way to check a rule like this yet, so accepting it would do nothing. Someone has to add that kind of rule to the app&apos;s code. Copy the request below and send it to whoever looks after the app; once the app can check it, the agent can suggest the rule again for you to accept.
              </Text.Root>
              <Stack.Root direction="row" align="center" gap="condensed" wrap>
                <Button.Root variant="primary" onClick={() => void copy()}>
                  Copy the request to file
                </Button.Root>
                <Text.Root as="span" className="review-small" aria-live="polite" data-testid="request-copied" data-state={copied.state}>
                  {copied.state === "copied" ? "Copied: a title and a description, ready to file." : copied.state === "failed" ? `Could not copy (${copied.message}); select the request in the details below instead.` : ""}
                </Text.Root>
              </Stack.Root>
            </Stack.Root>
          </Alert.Description>
        </Alert.Root>

        <section aria-labelledby="request-checks" className="review-section">
          <Text.Root as="h2" id="request-checks">
            What the rule should check
          </Text.Root>
          <Text.Root as="p" className="pre" data-testid="request-checks">
            {request.checks}
          </Text.Root>
          <Text.Root as="h3">Why</Text.Root>
          <Text.Root as="p" className="pre" data-testid="proposal-reason">
            {proposal.reason}
          </Text.Root>
        </section>
        <section aria-labelledby="request-examples" className="review-section">
          <Text.Root as="h2" id="request-examples">
            Examples, in words
          </Text.Root>
          <div className="review-columns">
            <WordExamples title="Allowed" examples={request.pass} expect="pass" />
            <WordExamples title="Not allowed" examples={request.fail} expect="fail" />
          </div>
        </section>
        <section aria-labelledby="request-why-not" className="review-section">
          <Text.Root as="h2" id="request-why-not">
            Why the app can&apos;t check it yet
          </Text.Root>
          <Text.Root as="p" className="pre" data-testid="request-why-not">
            {request.whyNot}
          </Text.Root>
        </section>

        {proposal.status === "declined" && <Closed proposal={proposal} />}
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
        {refusal && <CantAlert action={refusal.action} refusal={refusal.refusal} />}

        <EngineerDetails open={details} onToggle={setDetails}>
          <Facts proposal={proposal} request />
          {refused && (
            <Text.Root as="p" tone="muted" className="review-small" data-testid="request-refusal" data-code={refused.code}>
              Core on approving it: {refused.message}
            </Text.Root>
          )}
          <section aria-labelledby="request-text-title" className="review-section">
            <Text.Root as="h3" id="request-text-title">
              The request as it is copied
            </Text.Root>
            <Field.Root id="request-text" aria-label="The request as it is copied">
              <Field.Textarea value={text} readOnly rows={12} autoGrow maxRows={24} data-testid="request-text" />
            </Field.Root>
          </section>
          <History proposal={proposal} config={config} />
        </EngineerDetails>
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
                {exampleLabel(example.name)}
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

/** A request's actions: ask the agent for changes or decline it, each with its note. Accept is not offered: core refuses to approve or adopt a request. */
function RequestActions({ proposal, agent, onDecline, onSendBack }: { readonly proposal: Proposal; readonly agent: { readonly ready: boolean; readonly why: string }; readonly onDecline: (note: string) => Promise<void> | void; readonly onSendBack: (note: string) => Promise<void> | void }) {
  const [form, setForm] = useState<"decline" | "send-back" | null>(null);
  if (proposal.status !== "open") return null;
  return (
    <section aria-labelledby="review-decide" className="review-section" id="review-decide-section">
      <Text.Root as="h2" id="review-decide">
        Decide
      </Text.Root>
      <Card.Root className="review-actions" data-testid="review-actions">
        <Card.Body>
          <Stack.Root gap="condensed">
            <Text.Root as="p">
              There is nothing to accept. Once you have filed the request, decline it here with a note saying where. If you think the app&apos;s existing rules can cover it after all, ask the agent to try again.
            </Text.Root>
            <Stack.Root direction="row" align="center" gap="condensed" wrap>
              <Button.Root variant="secondary" onClick={() => setForm(form === "send-back" ? null : "send-back")} aria-expanded={form === "send-back"}>
                {SEND_BACK}
              </Button.Root>
              <Button.Root variant="ghost" onClick={() => setForm(form === "decline" ? null : "decline")} aria-expanded={form === "decline"}>
                Decline
              </Button.Root>
            </Stack.Root>
            {form === "decline" && <NoteForm key="decline" label="Why decline it?" hint="Declining is final. Your note is kept with the request." submit="Decline proposal" required="Say why you decline it." onCancel={() => setForm(null)} onSubmit={async (note) => {
              await onDecline(note);
              setForm(null);
            }} />}
            {form === "send-back" &&
              (agent.ready ? (
                <NoteForm key="send-back" label="What should the agent change?" hint="Your note goes to the agent as a chat message. The request stays open until you decide." submit="Send to the agent" required="Say what the agent should change." onCancel={() => setForm(null)} onSubmit={async (note) => {
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
    </section>
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
  // "Check again" measures an example again from scratch: a new attempt is a new session.
  const [attempts, setAttempts] = useState<Readonly<Record<string, number>>>({});
  const exampleItems = useMemo(() => all.map(({ example }) => ({ id: example.name, config: renderConfig, prototype: example.prototype, attempt: attempts[example.name] ?? 0 })), [all, renderConfig, attempts]);
  const exampleFrames = useSessions(exampleItems);

  // Every prototype in the project, measured, for the impact. The open one is the board's.
  const { existing, frames: otherFrames, items: projectItems, checkAgain: checkProjectAgain } = useProjectExisting({ config, prototypes, openPrototypeId, board, live });

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

  // What drawing still waits for, and whether it has stopped moving: said plainly beside "Check again", never left as an endless "checking".
  const things: MeasuredThing[] = [
    ...exampleFrames.map((item): MeasuredThing => ({ kind: "example", name: item.id, measurement: item.measurement })),
    ...projectItems.map((item): MeasuredThing => ({ kind: item.board ? "board" : "prototype", name: item.name, measurement: item.measurement })),
  ];
  const waits = waitingWords(things);
  const progressKey = JSON.stringify(things.map((thing) => (thing.measurement.state === "measuring" ? [thing.measurement.answered, thing.measurement.total] : thing.measurement.state)));
  const stalled = useStalled(progressKey, live && (exampleMeasurement === null || existing === null) && waits.waiting.length > 0);
  const checkAgain = () => {
    setAttempts((was) => Object.fromEntries([...Object.entries(was), ...exampleFrames.filter((item) => item.measurement.state !== "measured").map((item) => [item.id, (was[item.id] ?? 0) + 1] as const)]));
    checkProjectAgain();
  };
  // Earlier adopted examples this change replaces: core retires them on adoption, and the page says so before anyone accepts.
  const superseded = useMemo(() => {
    if (!live) return [];
    const listed = supersededExamples(config, id);
    return listed.ok ? listed.value : [];
  }, [live, config, id]);

  const [refusal, setRefusal] = useState<{ readonly action: string; readonly refusal: Refusal } | null>(null);
  const [adoption, setAdoption] = useState<Adoption | null>(null);
  const [focusExample, setFocusExample] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const refusalRef = useRef<HTMLDivElement>(null);
  const decideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (refusal) refusalRef.current?.scrollIntoView({ block: "start" });
  }, [refusal]);
  // An example's full card is in the details: open them, then bring the card into view.
  const showExample = (name: string) => {
    setDetails(true);
    setFocusExample(name);
  };
  const showTechnical = () => {
    setDetails(true);
    requestAnimationFrame(() => document.querySelector(".review-details")?.scrollIntoView({ block: "start" }));
  };

  const act = async (action: string, run: () => ReturnType<typeof approveProposal>) => {
    const result = run();
    if (!result.ok) return setRefusal({ action, refusal: result.error });
    setRefusal(null);
    await onSave(result.value);
  };
  // Accept is core's approve and then its adopt, in one click. A refusal saves nothing: the proposal stays as it was.
  const accept = async () => {
    if (!exampleMeasurement || !existing) return;
    const result = acceptProposal(config, id, exampleMeasurement, existing, now());
    if (!result.ok) return setRefusal({ action: "accept", refusal: result.error });
    setRefusal(null);
    setAdoption(result.value);
    await onSave(result.value.config);
  };

  const classification = classificationOf(proposal, config);
  const none = all.length === 0;
  const examplesMeasured = none || (measuring.total > 0 && measuring.answered === measuring.total && measuring.failed === 0);
  const ready = exampleMeasurement !== null && existing !== null;
  // What core says would stop it, before anyone clicks: it could not judge the examples, or its dry run of adopting refuses.
  const blocked: Refusal | null = judged && "refusal" in judged ? judged.refusal : dryRun && !dryRun.ok ? dryRun.error : null;
  const canAccept = ready && dryRun?.ok === true;
  const readiness: { readonly state: "blocked" | "unmeasured" | "stalled" | "checking" | "ready"; readonly text: string } = blocked
    ? { state: "blocked", text: "It can't be accepted as it is. The reason is under Decide." }
    : !examplesMeasured && measuring.failed > 0
      ? { state: "unmeasured", text: `${measuring.failed === 1 ? "An example" : `${measuring.failed} examples`} couldn't be drawn in every view, so this can't be accepted as it is. You can check again under Decide.` }
      : stalled
        ? { state: "stalled", text: "Drawing has stopped making progress, so this can't be checked yet. What it still waits for, and Check again, are under Decide." }
        : !examplesMeasured
        ? { state: "checking", text: `Checking its examples: ${measuring.answered} of ${measuring.total} drawn. You can accept once they are checked.` }
        : !canAccept
          ? { state: "checking", text: "Checking your prototypes against it. You can accept in a moment." }
          : { state: "ready", text: "Checked and ready for your decision." };
  // What the current step waits for, from the measurement and core's dry run, for the lifecycle in the details.
  const trackNote =
    proposal.status === "open" || proposal.status === "approved"
      ? !ready
        ? measuring.failed > 0
          ? "an example could not be measured"
          : proposal.status === "open"
            ? "waiting for you"
            : `measuring, ${measuring.answered} of ${measuring.total} frames`
        : dryRun && !dryRun.ok
          ? "core's dry run refuses it"
          : proposal.status === "open"
            ? "waiting for you"
            : "ready for you to adopt"
      : proposal.status === "adopted"
        ? "in force"
        : undefined;
  const verdict = blocked && judged && "refusal" in judged
    ? { tone: "critical" as const, text: `Core cannot judge the examples: [${blocked.code}] ${blocked.message}` }
    : !dryRun
      ? null
      : dryRun.ok
        ? { tone: "success" as const, text: `Core's adoption dry run: it would be adopted, classified ${classWords(dryRun.value.classification.class)}, and ${dryRun.value.newlyFailing.length === 0 ? "no prototype would newly fail" : `${dryRun.value.newlyFailing.length} ${dryRun.value.newlyFailing.length === 1 ? "prototype" : "prototypes"} would newly fail`}.` }
        : { tone: "warning" as const, text: `Core's adoption dry run refuses it: [${dryRun.error.code}] ${dryRun.error.message}` };
  const classSection = (
    <section aria-labelledby="review-class" className="review-section" data-testid="review-class">
      <Text.Root as="h3" id="review-class">
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
  const shownRefusal = refusal ?? (blocked ? { action: "accept", refusal: blocked } : null);
  // When the proposal's own examples are why, the person can fix them here, with core's revise, by them.
  const acceptRefusal = shownRefusal?.action === "accept" ? shownRefusal.refusal : null;
  const fixes = live && acceptRefusal ? exampleFixes(config, proposal, acceptRefusal, existing) : null;
  const fixExamples = async (fix: ExampleFix): Promise<string | null> => {
    if (!existing) return "your prototypes are still being checked.";
    const revised = applyExampleFix(config, id, fix, existing, now());
    if (!revised.ok) return revised.error.message;
    setRefusal(null);
    await onSave(revised.value);
    return null;
  };
  const from = acceptRefusal?.proposal !== undefined ? config.proposals.find((item) => item.id === acceptRefusal.proposal)?.title : undefined;
  const askDraft = acceptRefusal ? `${plainRefusal(acceptRefusal)}${acceptRefusal.example ? ` The example is “${exampleLabel(acceptRefusal.example)}”${from ? `, kept from “${from}”` : ""}.` : ""} Please change the proposal so it can be accepted.` : undefined;
  const showWaiting = live && (measuring.failed > 0 || stalled);

  return (
    <div className="review" data-proposal={id} data-status={proposal.status}>
      <Stack.Root gap="spacious">
        <ReviewHead proposal={proposal} onBack={onBack} />

        {live && (
          <Card.Root className="review-summary" data-testid="review-summary" data-state={readiness.state}>
            <div className="review-summary-words">
              <Text.Root as="p" weight="medium">
                You decide whether this goes into the project. Nothing changes until you accept it.
              </Text.Root>
              <Text.Root as="p" tone="muted" className="review-small" data-testid="review-ready" data-state={readiness.state}>
                {readiness.text}
              </Text.Root>
            </div>
            <Button.Root variant="secondary" onClick={() => decideRef.current?.scrollIntoView({ block: "start" })}>
              Go to the decision
              <Button.Icon>
                <ArrowDown />
              </Button.Icon>
            </Button.Root>
          </Card.Root>
        )}
        {proposal.status === "adopted" && <InForce proposal={proposal} config={config} adoption={adoption} onOpenPrototype={onOpenPrototype} prototypes={prototypes} />}
        {proposal.status === "declined" && <Closed proposal={proposal} />}

        <WhatChanges proposal={proposal} config={config} renderConfig={renderConfig} views={views} onShowExample={showExample} />

        {live && <Impact proposal={proposal} config={config} renderConfig={renderConfig} impact={impact} measuring={existing === null} prototypes={prototypes} existing={existing} views={config.views} replaced={replacedWords(config, superseded)} onOpenPrototype={onOpenPrototype} />}
        {live && <MeasureFrames items={otherFrames} />}

        {live && (
          <section aria-labelledby="review-decide" className="review-section" ref={decideRef}>
            <Text.Root as="h2" id="review-decide">
              Decide
            </Text.Root>
            <Decide
              proposal={proposal}
              agent={agent}
              canAccept={canAccept}
              readiness={readiness}
              measured={examplesMeasured}
              refusal={
                shownRefusal && (
                  <div ref={refusalRef} className="review-refusal">
                    <CantAlert action={shownRefusal.action} refusal={shownRefusal.refusal} from={from} onShowTechnical={showTechnical} />
                  </div>
                )
              }
              fix={fixes && <ExampleFixCard key={JSON.stringify(proposal.examples.fail.map((item) => item.name).concat(proposal.examples.pass.map((item) => item.name)))} fixes={fixes} onFix={fixExamples} />}
              canFix={fixes !== null && (fixes.canRemove || fixes.choices.length > 0)}
              askDraft={askDraft}
              waiting={
                showWaiting && (
                  <div className="review-waiting" data-testid="review-waiting" data-state={measuring.failed > 0 ? "failed" : "stalled"} role="status">
                    <Text.Root as="p" weight="medium">
                      {measuring.failed > 0 ? "Some of it couldn't be drawn, so core can't check it yet." : "Drawing has stopped making progress, so core can't check it yet."}
                    </Text.Root>
                    <ul aria-label="What is still waiting">
                      {[...waits.failed, ...(stalled ? waits.waiting : [])].map((line, index) => (
                        <li key={index}>
                          <Text.Root as="span" className="review-small">
                            {line}
                          </Text.Root>
                        </li>
                      ))}
                    </ul>
                    <Text.Root as="p" tone="muted" className="review-small">
                      Check again draws {waits.failed.length + (stalled ? waits.waiting.length : 0) === 1 ? "it" : "them"} from scratch. If it keeps happening, ask the agent for changes, or decline it.
                    </Text.Root>
                    <div>
                      <Button.Root variant="secondary" onClick={checkAgain}>
                        Check again
                      </Button.Root>
                    </div>
                  </div>
                )
              }
              onAccept={accept}
              onDecline={(note) => act("decline", () => declineProposal(config, id, note, now()))}
              onSendBack={async (note) => {
                const sent = sendBackProposal(config, id, note, now());
                if (!sent.ok) return setRefusal({ action: "send back", refusal: sent.error });
                setRefusal(null);
                await onSave(sent.value.config);
                onSendBack(sent.value.message);
              }}
            />
          </section>
        )}

        <EngineerDetails open={details} onToggle={setDetails}>
          <Facts proposal={proposal} note={trackNote} />
          {live && (
            <section aria-labelledby="review-core" className="review-section">
              <Text.Root as="h3" id="review-core">
                What core says about adopting it
              </Text.Root>
              <Text.Root as="p" tone="muted" className="review-small" data-testid="review-measuring" data-measured={examplesMeasured ? "" : undefined}>
                {none ? "No examples to measure: it only removes rules." : examplesMeasured ? `Every example measured: ${measuring.total} frames.` : measuring.failed > 0 ? `${measuring.failed === 1 ? "An example" : `${measuring.failed} examples`} could not be measured in every frame, so it cannot be adopted as it is.` : `Measuring the examples: ${measuring.answered} of ${measuring.total} frames answered.`}
                {!ready ? (none ? " Adoption waits until every prototype in the project is measured." : " Adoption waits until every example, and every prototype in the project, is measured.") : ""}
              </Text.Root>
              {verdict && (
                <Text.Root as="p" className="review-small review-verdict" data-tone={verdict.tone} data-testid="review-verdict">
                  {verdict.text}
                </Text.Root>
              )}
              {superseded.length > 0 && (
                <ul className="findings" aria-label="Earlier examples core would retire" data-testid="review-superseded">
                  {superseded.map((entry) => (
                    <li key={`${entry.proposal}/${entry.expect}/${entry.example}`}>
                      <Text.Root as="span" className="review-small">
                        Core retires {entry.expect === "pass" ? "passing" : "failing"} example <Code.Root>{entry.example}</Code.Root> of adopted proposal <Code.Root>{entry.proposal}</Code.Root>, superseded on {entry.rules.map((rule) => `"${rule}"`).join(", ")}: {entry.detail}
                      </Text.Root>
                    </li>
                  ))}
                </ul>
              )}
              {shownRefusal && <RefusalAlert action={shownRefusal.action} refusal={shownRefusal.refusal} onShowExample={showExample} onOpenProposal={onOpenProposal} />}
            </section>
          )}
          {classSection}
          <Changes proposal={proposal} config={config} renderConfig={renderConfig} />
          <Examples views={views} config={renderConfig} status={proposal.status} focus={focusExample} onFocused={() => setFocusExample(null)} />
          <History proposal={proposal} config={config} />
        </EngineerDetails>
      </Stack.Root>
    </div>
  );
}

/** What the action that sends the agent a note is called, on every proposal: both are core's `sendBack`. */
const SEND_BACK = "Ask the agent for changes";

/** The top of a review page: the way back, the title, and where the proposal stands in words. Its id and core's status are in the details. */
function ReviewHead({ proposal, onBack }: { readonly proposal: Proposal; readonly onBack: () => void }) {
  const last = proposal.history.at(-1);
  const standing = proposal.status === "declined" ? `Declined${last?.at ? ` ${formatDay(last.at)}` : ""}` : standingWords(proposal);
  return (
    <Stack.Root gap="condensed">
      <div>
        <Button.Root variant="ghost" onClick={onBack} className="review-back">
          ← All proposals
        </Button.Root>
      </div>
      <Text.Root as="h1" className="review-title">
        {proposal.title}
      </Text.Root>
      <Text.Root as="p" tone="muted" className="review-standing" data-testid="review-standing">
        <span className="standing" data-standing={waitsForYou(proposal) ? "waiting" : proposal.status}>
          {standing}
        </span>
        {` · ${fromWords(proposal)}`}
      </Text.Root>
    </Stack.Root>
  );
}

/** A declined proposal, said once at the top: who declined it, when, and their note. */
function Closed({ proposal }: { readonly proposal: Proposal }) {
  const last = proposal.history.at(-1);
  return (
    <Alert.Root tone="info" data-testid="review-declined">
      <Alert.Title>
        Declined{last?.by ? ` by ${last.by}` : ""}, <time dateTime={last?.at}>{formatTime(last?.at ?? "")}</time>
      </Alert.Title>
      <Alert.Description>
        <Text.Root as="p" className="pre">
          {last?.note ? `“${last.note}”` : "No note was left."} Nothing in the project changed, and a declined proposal can&apos;t be reopened.
        </Text.Root>
      </Alert.Description>
    </Alert.Root>
  );
}

/** The proposal as core keeps it: its status, its id, who drafted it and when, and the steps of core's lifecycle. */
function Facts({ proposal, note, request = false }: { readonly proposal: Proposal; readonly note?: string | undefined; readonly request?: boolean }) {
  const drafted = draftedBy(proposal);
  return (
    <Stack.Root gap="condensed">
      <Stack.Root direction="row" align="center" gap="condensed" wrap>
        <StatusBadge status={proposal.status} />
        {request && <RequestBadge />}
        <Code.Root>{proposal.id}</Code.Root>
        <Text.Root as="span" tone="muted">
          Drafted by {drafted.by}, <time dateTime={drafted.at}>{formatTime(drafted.at)}</time>
        </Text.Root>
      </Stack.Root>
      <ProposalTrack proposal={proposal} note={request && proposal.status === "open" ? "it cannot be approved: it needs a code change" : note} />
      {!request && (
        <Text.Root as="p" tone="muted" className="review-small">
          Accept records both of core&apos;s steps at once: approved, then adopted.
        </Text.Root>
      )}
    </Stack.Root>
  );
}

/**
 * Everything an engineer checks, behind one toggle: core's classification
 * and dry run, ids, the rule data, every example with its findings and
 * source, and the history. Closed, it is out of sight and out of reach but
 * still laid out, because the examples' frames inside it are the ones core's
 * verdict is measured on.
 */
function EngineerDetails({ open, onToggle, children }: { readonly open: boolean; readonly onToggle: (open: boolean) => void; readonly children: ReactNode }) {
  const id = useId();
  return (
    <section className="review-details" data-testid="review-details" data-open={open ? "" : undefined} aria-label="Details for engineers">
      <Button.Root variant="ghost" className="review-details-toggle" aria-expanded={open} aria-controls={id} onClick={() => onToggle(!open)}>
        <Button.Icon>{open ? <ChevronDown /> : <ChevronRight />}</Button.Icon>
        Details for engineers
      </Button.Root>
      {!open && (
        <Text.Root as="p" tone="muted" className="review-small">
          How it was checked, the exact rule data, every example in every view, and the full history.
        </Text.Root>
      )}
      <div id={id} className="review-details-panel" inert={!open}>
        <Stack.Root gap="spacious">{children}</Stack.Root>
      </div>
    </section>
  );
}

type DecideProps = {
  readonly proposal: Proposal;
  readonly agent: { readonly ready: boolean; readonly why: string };
  readonly canAccept: boolean;
  readonly readiness: { readonly state: string; readonly text: string };
  /** Every example has been drawn and measured. */
  readonly measured: boolean;
  /** Why it cannot be accepted, when core says so. */
  readonly refusal: ReactNode;
  /** The person's own fix for the examples, when they are why. */
  readonly fix: ReactNode;
  /** Whether that fix offers something to do. */
  readonly canFix: boolean;
  /** What the note to the agent starts as when it can't be accepted: the reason, and the example. */
  readonly askDraft: string | undefined;
  /** What drawing still waits for, with Check again. */
  readonly waiting: ReactNode;
  readonly onAccept: () => void;
  readonly onDecline: (note: string) => Promise<void> | void;
  readonly onSendBack: (note: string) => Promise<void> | void;
};

/**
 * The person's decision, after everything it rests on: one Accept, which
 * approves and adopts, asking the agent for changes, and declining. Each is
 * a deliberate click, and none is reachable from the agent's tools. Accept
 * waits until the examples and the project's prototypes are checked, and is
 * unavailable while core would refuse it; the reason is said beside it.
 */
function Decide({ proposal, agent, canAccept, readiness, measured, refusal, fix, canFix, askDraft, waiting, onAccept, onDecline, onSendBack }: DecideProps) {
  const [form, setForm] = useState<"decline" | "send-back" | null>(null);
  const { status } = proposal;
  return (
    <Card.Root className="review-actions" data-testid="review-actions">
      <Card.Body>
        <Stack.Root gap="normal">
          {refusal}
          {fix}
          {waiting}
          <Stack.Root direction="row" align="center" gap="condensed" wrap>
            <Button.Root variant="primary" onClick={onAccept} disabled={!canAccept} aria-describedby="review-accept-note">
              Accept
            </Button.Root>
            {status === "open" && (
              <Button.Root variant="secondary" onClick={() => setForm(form === "send-back" ? null : "send-back")} aria-expanded={form === "send-back"}>
                {SEND_BACK}
              </Button.Root>
            )}
            <Button.Root variant="ghost" onClick={() => setForm(form === "decline" ? null : "decline")} aria-expanded={form === "decline"}>
              Decline
            </Button.Root>
          </Stack.Root>
          <Text.Root as="p" tone="muted" id="review-accept-note" className="review-small" aria-live="polite" data-testid="review-accept-note" data-state={readiness.state} data-measured={measured ? "" : undefined}>
            {canAccept ? "Accepting puts it in force for every prototype in this project, straight away. Only you can accept or decline; the agent can't." : readiness.state === "blocked" ? (canFix ? "Accept is unavailable until that is fixed. You can fix the example here, ask the agent for changes, or decline." : "Accept is unavailable until that is fixed. You can ask the agent for changes, or decline.") : `Accept is unavailable for now. ${readiness.text}`}
          </Text.Root>
          {form === "decline" && <NoteForm key="decline" label="Why decline it?" hint="Declining is final. Your note is kept with the proposal." submit="Decline proposal" required="Say why you decline it." onCancel={() => setForm(null)} onSubmit={async (note) => {
            await onDecline(note);
            setForm(null);
          }} />}
          {form === "send-back" &&
            (agent.ready ? (
              <NoteForm key="send-back" label="What should the agent change?" hint="Your note goes to the agent as a chat message. The proposal stays open until you decide." submit="Send to the agent" required="Say what the agent should change." initial={askDraft} onCancel={() => setForm(null)} onSubmit={async (note) => {
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
function NoteForm({ label, hint, submit, required, initial, onSubmit, onCancel }: { readonly label: string; readonly hint: string; readonly submit: string; readonly required: string; /** What the note starts as, for the person to change. */ readonly initial?: string | undefined; readonly onSubmit: (note: string) => Promise<void> | void; readonly onCancel: () => void }) {
  const [note, setNote] = useState(initial ?? "");
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

/** Why something could not be done, as a designer reads it. Core's own words for it are in the details. */
function CantAlert({ action, refusal, from, onShowTechnical }: { readonly action: string; readonly refusal: Refusal; /** The title of the earlier proposal whose example the refusal names. */ readonly from?: string | undefined; readonly onShowTechnical?: () => void }) {
  const accepting = action === "accept";
  return (
    <Alert.Root tone="warning" data-testid="review-refusal" data-code={refusal.code} data-action={action}>
      <Alert.Title>{accepting ? "This can't be accepted yet" : action === "decline" ? "It wasn't declined" : "It wasn't sent to the agent"}</Alert.Title>
      <Alert.Description>
        <Stack.Root gap="condensed">
          <Text.Root as="p" data-testid="review-refusal-plain">
            {accepting ? plainRefusal(refusal) : refusal.message}
            {accepting && refusal.example && !refusal.proposal ? ` The example is “${exampleLabel(refusal.example)}”.` : ""}
            {accepting && refusal.example && refusal.proposal ? ` The example is “${exampleLabel(refusal.example)}”, kept from “${from ?? refusal.proposal}”.` : ""}
            {accepting ? " Nothing has changed. Ask the agent for changes, or decline it." : ""}
          </Text.Root>
          {accepting && onShowTechnical && (
            <div>
              <Button.Root variant="ghost" className="review-back" onClick={onShowTechnical}>
                See the technical reason
              </Button.Root>
            </div>
          )}
        </Stack.Root>
      </Alert.Description>
    </Alert.Root>
  );
}

/** A refusal from core, precisely: what was refused, core's words, the example and the earlier proposal it names, and its findings. */
function RefusalAlert({ action, refusal, onShowExample, onOpenProposal }: { readonly action: string; readonly refusal: Refusal; readonly onShowExample: (name: string) => void; readonly onOpenProposal: (id: string) => void }) {
  return (
    <Alert.Root tone="critical" data-testid="review-refusal-technical" data-code={refusal.code}>
      <Alert.Title>Not {action === "accept" ? "adopted" : action === "decline" ? "declined" : "sent back"}: core refuses it</Alert.Title>
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

/** Once accepted: said once at the top, with what is checked now and what the re-check of every prototype found. */
function InForce({ proposal, config, adoption, prototypes, onOpenPrototype }: { readonly proposal: Proposal; readonly config: ProjectConfig; readonly adoption: Adoption | null; readonly prototypes: readonly PrototypeRecord[]; readonly onOpenPrototype: (id: string, finding?: Finding) => void }) {
  const adopted = proposal.history.at(-1);
  const inForce = proposal.rules.add.filter((rule) => config.rules.some((item) => item.id === rule.id));
  return (
    <Alert.Root tone="success" data-testid="review-in-force">
      <Alert.Title>
        Accepted{adopted?.by ? ` by ${adopted.by}` : ""}, <time dateTime={adopted?.at}>{formatTime(adopted?.at ?? "")}</time>
      </Alert.Title>
      <Alert.Description>
        <Stack.Root gap="condensed">
          {inForce.length > 0 ? (
            <Text.Root as="p">
              It is part of the project now. Checked on every prototype: {inForce.map((rule) => ruleSentence(rule, config)).join(" ")} The Checks panel shows how the open prototype does.
            </Text.Root>
          ) : (
            <Text.Root as="p">It is part of the project now{proposal.rules.remove.length > 0 ? `, and ${proposal.rules.remove.length === 1 ? "the check it removed no longer runs" : "the checks it removed no longer run"}` : ""}.</Text.Root>
          )}
          {proposal.supersedes && proposal.supersedes.length > 0 && (
            <Text.Root as="p" data-testid="review-replaced">
              {replacedWords(config, proposal.supersedes, true)}
            </Text.Root>
          )}
          {adoption && (
            <Text.Root as="p" data-testid="review-rechecked">
              Every prototype was checked again: {adoption.newlyFailing.length === 0 ? "all still fine." : `${adoption.newlyFailing.map((item) => item.name).join(", ")} ${adoption.newlyFailing.length === 1 ? "needs" : "need"} fixing.`}
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

/** A rule with two example screens for it: one the rule allows and one it does not. */
type Pair = { readonly rule: string; readonly spec: RuleSpec | undefined; readonly pass: ExampleView | undefined; readonly fail: ExampleView | undefined };

/**
 * What changes, as a designer reads it: each change in one plain sentence,
 * why, and then what it looks like. A part it adds is drawn by the project's
 * library; each rule it adds, changes or leans on is shown as two example
 * screens, one allowed and one not, drawn in frames at the scenario and view
 * where the rule catches the second. They are the proposal's own examples:
 * nothing says they differ only by what is outlined.
 */
function WhatChanges({ proposal, config, renderConfig, views, onShowExample }: { readonly proposal: Proposal; readonly config: ProjectConfig; /** The project with the proposal applied. */ readonly renderConfig: ProjectConfig; readonly views: readonly ExampleView[]; readonly onShowExample: (name: string) => void }) {
  const changes = plainChanges(proposal, config);
  const added = proposal.inventory.flatMap((op) => (op.op === "add-component" ? [op.name] : []));
  const dropped = proposal.inventory.flatMap((op) => (op.op === "remove-component" ? [op.name] : []));
  const pageTypes = proposal.inventory.flatMap((op) => (op.op === "add-page-type" ? [op.pageType] : []));
  // One pair for each rule it adds or changes, then one for each other rule a "not allowed" example is there to show.
  const ruleIds = [...new Set([...proposal.rules.add.map((rule) => rule.id), ...proposal.examples.fail.map((example) => example.flaggedBy.rule)])];
  const firstPass = views.find((view) => view.expect === "pass");
  const pairs: Pair[] = ruleIds.map((rule) => {
    const pair = proofPair(proposal, rule);
    return { rule, spec: proposal.rules.add.find((item) => item.id === rule) ?? renderConfig.rules.find((item) => item.id === rule), pass: views.find((view) => view.expect === "pass" && view.name === pair.pass), fail: views.find((view) => view.expect === "fail" && view.name === pair.fail) };
  });
  if (pairs.length === 0 && firstPass) pairs.push({ rule: "", spec: undefined, pass: firstPass, fail: undefined });
  return (
    <section aria-labelledby="review-changes" className="review-section">
      <Text.Root as="h2" id="review-changes">
        What changes
      </Text.Root>
      {changes.length === 1 ? (
        <Text.Root as="p" className="review-lead" data-testid="review-plain">
          {changes[0]?.sentence}
        </Text.Root>
      ) : (
        <ol className="review-lead-list" data-testid="review-plain" aria-label="What changes">
          {changes.map((change, index) => (
            <li key={index} className="review-lead" data-change={change.kind}>
              {change.sentence}
            </li>
          ))}
        </ol>
      )}
      <div className="review-why">
        <Text.Root as="h3">Why</Text.Root>
        <Text.Root as="p" className="pre" data-testid="proposal-reason">
          {proposal.reason}
        </Text.Root>
        {proposal.states.length > 0 && (
          <ul className="review-states" data-testid="proposal-states" aria-label="What each state shows">
            {proposal.states.map((state, index) => (
              <li key={index}>
                <Text.Root as="span" weight="medium">
                  {humanize(state.state)}
                </Text.Root>
                {`: ${state.note}`}
              </li>
            ))}
          </ul>
        )}
      </div>
      {(added.length > 0 || dropped.length > 0) && (
        <div className="palette-after" data-testid="palette-after">
          <Text.Root as="h3">{added.length > 0 ? (added.length === 1 ? "The new part" : "The new parts") : dropped.length === 1 ? "The part it takes away" : "The parts it takes away"}</Text.Root>
          <ul className="palette" aria-label="Parts it adds or takes away">
            {added.map((name) => (
              <li key={name}>
                <SpecimenTile config={renderConfig} component={name} mark="new">
                  <Text.Root as="p" tone="muted">
                    {proposal.status === "adopted" ? "Added by this proposal." : "Screens can't use it today."}
                  </Text.Root>
                </SpecimenTile>
              </li>
            ))}
            {dropped.map((name) => (
              <li key={name}>
                <SpecimenTile config={config} component={name} mark="removed">
                  <Text.Root as="p" tone="muted">
                    {proposal.status === "adopted" ? "Removed by this proposal." : "Screens could no longer use it."}
                  </Text.Root>
                </SpecimenTile>
              </li>
            ))}
          </ul>
        </div>
      )}
      {pageTypes.length > 0 && (
        <div className="palette-after">
          <Text.Root as="h3">{pageTypes.length === 1 ? "The new kind of page" : "The new kinds of page"}</Text.Root>
          <ul className="review-rules op-figures" aria-label="New kinds of page">
            {pageTypes.map((type) => (
              <li key={type.id} className="op-figure preview">
                <SlotDiagram type={type} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {pairs.length > 0 && (
        <div className="review-after" data-testid="review-after">
          <div className="section-head">
            <Text.Root as="h3">How screens look after</Text.Root>
            <Text.Root as="p" tone="muted">
              {pairs.some((pair) => pair.fail) ? "Two examples: one that would be allowed, and one that would not. " : "An example that would be allowed. "}
              {proposal.status === "declined" ? "It was declined, so neither applies." : ""}
            </Text.Root>
          </div>
          <ul className="review-rules" aria-label="Example screens">
            {pairs.map((pair) => (
              <li key={pair.rule}>
                <Card.Root className="rule-proof" data-rule-proof={pair.rule || undefined}>
                  {pair.spec && ruleGlyph(pair.spec) && (
                    <div className="rule-proof-rule">
                      <RuleFigure rule={pair.spec} label={ruleBound(pair.spec, renderConfig)} />
                      <Text.Root as="p" weight="medium" data-testid="pair-rule">
                        {ruleSentence(pair.spec, renderConfig)}
                      </Text.Root>
                    </div>
                  )}
                  <div className="proof" data-testid="rule-proof" data-flow={pair.spec?.type === "flow" ? "" : undefined}>
                    {pair.pass ? <ProofExample view={pair.pass} config={renderConfig} at={flaggedAt(pair.fail, pair.rule)} drawn={pair.spec?.type !== "flow"} onShow={() => onShowExample(pair.pass?.name ?? "")} /> : <Text.Root as="p" tone="muted">No example of what is allowed.</Text.Root>}
                    {pair.fail ? (
                      <ProofExample view={pair.fail} config={renderConfig} at={flaggedAt(pair.fail, pair.rule)} rule={pair.rule} drawn={pair.spec?.type !== "flow"} {...(pair.spec && pair.spec.type !== "flow" && !ruleGlyph(pair.spec) ? { why: ruleSentence(pair.spec, renderConfig) } : {})} onShow={() => onShowExample(pair.fail?.name ?? "")} />
                    ) : pair.rule ? (
                      <Text.Root as="p" tone="muted" data-testid="proof-none">
                        No example shows what this rule stops, so it can&apos;t be accepted as it is.
                      </Text.Root>
                    ) : null}
                  </div>
                </Card.Root>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Where a rule catches its "not allowed" example: both screens of a pair are drawn at that scenario and view. */
function flaggedAt(fail: ExampleView | undefined, rule: string): Finding | undefined {
  return fail?.findings.find((finding) => finding.rule === rule && finding.scenario !== undefined && finding.view !== undefined) ?? fail?.findings.find((finding) => finding.scenario !== undefined) ?? fail?.findings.find((finding) => finding.page !== undefined);
}

/** Core's record of what it changes, for an engineer: the inventories and rule inputs before and after, each limit it moves, and each rule in core's words with its data. */
function Changes({ proposal, config, renderConfig }: { readonly proposal: Proposal; readonly config: ProjectConfig; /** The project with the proposal applied. */ readonly renderConfig: ProjectConfig }) {
  const diff = proposal.status === "adopted" ? null : inventoryDiff(config, proposal);
  // The rule inputs it moves, each as its figure: a cap, a step budget, a page type's slots.
  const figured = proposal.inventory.filter((op) => FIGURED_OPS.includes(op.op));
  // A rule removed and added again under its id is a changed rule: one line, with core's words before and after.
  const lines = ruleLines(proposal, config);
  const changedIds = new Set(lines.filter((line) => line.kind === "changes").map((line) => line.rule));
  const addedRules = proposal.rules.add.filter((rule) => !changedIds.has(rule.id));
  const changedRules = proposal.rules.add.filter((rule) => changedIds.has(rule.id));
  const removed = lines.filter((line) => line.kind === "removes").map((line) => ({ line, rule: proposal.status === "adopted" ? undefined : config.rules.find((rule) => rule.id === line.rule) }));
  return (
    <section aria-labelledby="review-data" className="review-section">
      <Text.Root as="h3" id="review-data">
        What it changes, as data
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
      {figured.length > 0 && (
        <ul className="review-rules op-figures" aria-label="The limits it moves, drawn" data-testid="op-figures">
          {figured.map((op, index) => (
            <li key={index} className="op-figure preview" data-op={op.op}>
              <PreviewFigure preview={proposalPreview({ ...proposal, inventory: [op] }, config)} config={config} />
            </li>
          ))}
        </ul>
      )}
      {changedRules.length > 0 && (
        <ul className="review-rules" aria-label="Rules it changes">
          {changedRules.map((rule) => {
            const line = lines.find((item) => item.rule === rule.id);
            return (
              <li key={rule.id}>
                <Card.Root className="figure-card" data-testid="rule-changed" data-rule-data={rule.id}>
                  {line && <RuleLineView line={line} />}
                  <RuleWords rule={rule} config={renderConfig} />
                </Card.Root>
              </li>
            );
          })}
        </ul>
      )}
      {addedRules.length > 0 && (
        <ul className="review-rules" aria-label="Rules it adds">
          {addedRules.map((rule) => (
            <li key={rule.id}>
              <Card.Root className="figure-card" data-rule-data={rule.id}>
                <Text.Root as="p" weight="medium">
                  Adds rule <Code.Root>{rule.id}</Code.Root>
                </Text.Root>
                <RuleWords rule={rule} config={config} />
              </Card.Root>
            </li>
          ))}
        </ul>
      )}
      {removed.length > 0 && (
        <ul className="review-rules" aria-label="Rules it removes">
          {removed.map(({ line, rule }) => (
            <li key={line.rule}>
              <Card.Root className="figure-card" data-testid="rule-removed">
                {/* In force, the rule is said by core now, with its data; once adopted, by the words core kept. */}
                <RuleLineView line={line} withoutWas={rule !== undefined} />
                {rule ? (
                  <RuleWords rule={rule} config={config} />
                ) : line.was === undefined ? (
                  <Text.Root as="p" tone="muted">
                    {proposal.status === "adopted" ? "It is no longer in force." : "It is not in force now, so this proposal cannot apply."}
                  </Text.Root>
                ) : null}
              </Card.Root>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const FIGURED_OPS: readonly InventoryOp["op"][] = ["add-cap", "set-cap", "set-max-steps", "add-task", "add-page-type"];

/** One example screen of a pair, in a frame of its own at one scenario and view, with the part its rule catches outlined. */
function ProofExample({ view, config, at, rule, why, drawn = true, onShow }: { readonly view: ExampleView; readonly config: ProjectConfig; readonly at: Finding | undefined; readonly rule?: string; /** The rule this screen goes against, in a sentence, where it is not said beside the pair. */ readonly why?: string; /** False for a rule about a whole flow: no one screen shows it, so no screen is drawn, and the route core walked is. */ readonly drawn?: boolean; readonly onShow: () => void }) {
  const { prototype } = view.example;
  const scenario = prototype.scenarios.find((item) => item.id === at?.scenario) ?? prototype.scenarios.find((item) => item.page === at?.page) ?? prototype.scenarios[0];
  // The view core's finding is in, else the narrowest, where a page reads at close to its own size.
  const shownView = config.views.find((item) => item.name === at?.view) ?? [...config.views].sort((a, b) => a.width - b.width)[0];
  // One scenario at one view, in a session of its own: the full set is measured in the Examples section below.
  const items = useMemo(() => {
    if (!drawn || !scenario || !shownView) return [];
    return [{ id: `proof:${view.name}`, config: { ...config, views: [shownView] }, prototype: { ...prototype, scenarios: [scenario] } }];
  }, [drawn, config, prototype, scenario, shownView, view.name]);
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
  const state = view.verdict.state;
  // The picture's own word on whether it shows what it says: quiet when it does, plain when it does not.
  const badge: { readonly tone: "success" | "critical" | "info" | "warning"; readonly text: string } | null =
    state === "ok" ? { tone: "success", text: "Checked" } : state === "measuring" ? { tone: "info", text: "Checking…" } : state === "unmeasured" ? { tone: "warning", text: "Couldn't be drawn" } : state === "bad" ? { tone: "critical", text: view.expect === "pass" ? "Breaks a rule as it is" : "Nothing stops this yet" } : null;
  const scale = shownView ? Math.min(1, Math.max(0.08, (width - 4) / shownView.width)) : 1;
  return (
    <figure className="proof-example" data-proof={view.name} data-expect={view.expect} data-verdict={view.verdict.state}>
      <figcaption className="proof-head">
        <span className="proof-mark" data-expect={view.expect} aria-hidden="true">
          {view.expect === "pass" ? <Check /> : <X />}
        </span>
        <Text.Root as="span" weight="bold" data-testid="proof-kind">
          {view.expect === "pass" ? "Allowed" : "Not allowed"}
        </Text.Root>
        <Text.Root as="span" tone="muted">
          {exampleLabel(view.name)}
        </Text.Root>
        {badge && (
          <Badge.Root tone={badge.tone} data-testid="proof-verdict">
            {badge.text}
          </Badge.Root>
        )}
      </figcaption>
      {drawn ? (
        <>
          <div className="example-frames proof-frame" ref={area}>
            {measured && frame && frameState && <FrameViewport session={measured.session} spec={frame} revision={measured.state.revision} frameState={frameState} scale={scale} hidden={false} name={`${view.name}, as proof: ${frame.scenario.id} at ${frame.view.name}`} fit />}
          </div>
          <Text.Root as="p" tone="muted" className="review-small">
            {scenario ? scenarioName(scenario) : "No scenario"}
            {shownView ? `, ${viewLabel(shownView.name).toLowerCase()}` : ""}.{element !== undefined && state === "ok" ? " The outlined part is what isn't allowed." : ""}
          </Text.Root>
        </>
      ) : (
        finding &&
        state !== "not-judged" && (
          <EvidenceFigure finding={finding} findings={view.findings}>
            <Text.Root as="p" className="fix-message" data-testid="proof-message">
              {finding.message}
            </Text.Root>
          </EvidenceFigure>
        )
      )}
      {why !== undefined && (
        <Text.Root as="p" className="review-small" data-testid="proof-why">
          The rule: {why}
        </Text.Root>
      )}
      <div>
        <Button.Root variant="ghost" className="review-back" onClick={onShow}>
          {`See ${exampleLabel(view.name)} in every view`}
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

/**
 * What accepting it does to the project's prototypes, from core's adoption
 * check: every prototype is a tile, so it is plain each was checked. One
 * that would need fixing is outlined, shows a miniature of the page from its
 * measured boxes with what core flags hatched, says what core found, and
 * opens on the board. A proposal that removes a check or loosens a limit
 * says so first: no prototype breaks, and something stops being caught.
 */
function Impact({ proposal, config, renderConfig, impact, measuring, prototypes, existing, views, replaced, onOpenPrototype }: { readonly proposal: Proposal; readonly config: ProjectConfig; /** The project with the proposal applied. */ readonly renderConfig: ProjectConfig; readonly impact: readonly NewlyFailing[] | null; readonly measuring: boolean; readonly prototypes: readonly PrototypeRecord[]; readonly existing: readonly ExistingPrototype[] | null; readonly views: readonly View[]; /** The earlier examples it replaces, in a sentence; empty for none. */ readonly replaced: string; readonly onOpenPrototype: (id: string, finding?: Finding) => void }) {
  const looser = loosensWords(proposal, config);
  // The rules a prototype would newly break, each in a sentence: the proposal's own, or one in force that a moved limit makes stricter.
  const broken = (failing: NewlyFailing) => failing.rules.flatMap((id) => proposal.rules.add.find((rule) => rule.id === id) ?? config.rules.find((rule) => rule.id === id) ?? []).map((rule) => ruleSentence(rule, renderConfig));
  return (
    <section aria-labelledby="review-impact" className="review-section" data-testid="review-impact">
      <Text.Root as="h2" id="review-impact">
        What it affects
      </Text.Root>
      {looser.length > 0 && (
        <ul className="review-rules review-looser" data-testid="review-looser" aria-label="What stops being caught">
          {looser.map((line, index) => (
            <li key={index}>
              <Text.Root as="p" className="review-lead">
                {line}
              </Text.Root>
            </li>
          ))}
        </ul>
      )}
      {replaced !== "" && (
        <Text.Root as="p" className="review-lead" data-testid="review-replaced">
          {replaced}
        </Text.Root>
      )}
      {impact === null || existing === null ? (
        <Text.Root as="p" tone="muted" data-testid="impact-checking">
          {measuring ? "Checking your prototypes against it…" : "Checking its examples first…"}
        </Text.Root>
      ) : (
        <>
          <Text.Root as="p" className={looser.length > 0 ? undefined : "review-lead"} data-testid={impact.length === 0 ? "impact-none" : "impact-some"}>
            {impact.length === 0 ? "Nothing that works today would stop working." : `${impact.length === existing.length ? "" : `${impact.length} of `}${existing.length} ${existing.length === 1 ? "prototype" : "prototypes"} would need fixing.`}
          </Text.Root>
          <ul className="impact-grid" aria-label="Your prototypes, if you accept it">
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
                          {scenarioNameOf(flagged.snapshot.scenario, item.prototype.scenarios)}, {viewLabel(flagged.snapshot.view).toLowerCase()}, as a sketch. The hatched part is what would need fixing.
                        </figcaption>
                      </figure>
                    )}
                    <Text.Root as="h3" className="example-name">
                      {item.name}
                    </Text.Root>
                    {failing ? (
                      <>
                        <span className="vis-verdict" data-rules={failing.rules.join(" ")}>
                          <span className="vis-verdict-icon" aria-hidden="true">
                            <X />
                          </span>
                          Would need fixing
                        </span>
                        {broken(failing).length > 0 && (
                          <Text.Root as="p" data-testid="impact-why">
                            It goes against: {broken(failing).join(" ")}
                          </Text.Root>
                        )}
                        <Disclosure.Root className="impact-found">
                          <Disclosure.Summary>What was found, exactly</Disclosure.Summary>
                          <ul className="findings" aria-label={`What would need fixing in ${item.name}`}>
                            {failing.findings.map((finding, index) => (
                              <li key={index}>
                                <FindingButton finding={finding} selected={false} onSelect={() => record && onOpenPrototype(record.id, finding)} />
                              </li>
                            ))}
                          </ul>
                        </Disclosure.Root>
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
                        Still fine
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
            <HistoryEntry entry={entry} config={config} own={ownProposal(proposal)} />
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

function HistoryEntry({ entry, config, own }: { readonly entry: TimelineEntry; readonly config: ProjectConfig; readonly own: boolean }) {
  return (
    <Stack.Root gap="none" className="history-entry">
      <Text.Root as="span" weight="medium">
        {timelineTitle(entry, own)}
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
