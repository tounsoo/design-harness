import { Alert, Badge, Button, Dialog, ErrorMessage, Field, Label, Loader, Stack, Text, VisuallyHidden } from "@tounsoo/todae";
import { ArrowRight, Check, Minus, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { onlyRemovesRules, type ExistingPrototype, type ProjectConfig, type ProposalDraft, type Refusal, type RuleSpec } from "@design-harness/core";
import {
  changeMessage,
  chooseExamples,
  examplesMessage,
  impactOf,
  limitsOf,
  otherReaders,
  previewChange,
  proposeByPerson,
  removalDraft,
  waitingOn,
  waitingWords,
  type ExampleChoice,
  type ImpactView,
  type Limit,
  type LimitEdit,
  type LimitMove,
} from "../review/rule-change";
import { ClassBadge, RuleWords } from "./proposal-parts";
import type { ChangeClass, ClassifiedChange, Proposal } from "@design-harness/core";
import { exampleLabel } from "./words";

/** Which rule a flow is open on, and which flow. */
export type RuleFlow = { readonly kind: "remove" | "change"; readonly rule: string };

/** What every flow that ends in a person's proposal is given: the project, core's reading of its prototypes, and the ways out. */
export type FlowContext = {
  readonly config: ProjectConfig;
  /** Every prototype in the project with its measured snapshots; null while they are being measured. */
  readonly existing: readonly ExistingPrototype[] | null;
  readonly progress: { readonly answered: number; readonly total: number };
  readonly agent: { readonly ready: boolean; readonly why: string };
  readonly onClose: () => void;
  /** Saves the config with the new open proposal and opens its review page; `ask` is a message put in the chat for the person to send. */
  readonly onPropose: (next: ProjectConfig, id: string, ask?: string) => void;
  /** Puts a message in the chat for the person to edit and send. */
  readonly onAsk: (message: string) => void;
  readonly onOpenProposal: (id: string) => void;
};

type FlowProps = FlowContext & { readonly rule: RuleSpec };

const now = () => new Date().toISOString();

/**
 * Removing or changing a rule starts here, from the rule's card, and ends
 * as an open proposal by the person on its review page: the rule stays in
 * force until they approve and adopt it there. The dialog shows the rule in
 * core's words, asks why, and says what core reads in every prototype of the
 * project with the change applied. A change edits the rule's numeric limits
 * in place; a limit that reads a cap moves the cap; anything else is asked
 * of the agent, since it needs examples written for it.
 */
export function RuleFlowDialog({ flow, config, ...rest }: Omit<FlowProps, "rule"> & { readonly flow: RuleFlow }) {
  const rule = config.rules.find((item) => item.id === flow.rule);
  if (!rule) return null;
  return flow.kind === "remove" ? <RemoveFlow config={config} rule={rule} {...rest} /> : <ChangeFlow config={config} rule={rule} {...rest} />;
}

function RemoveFlow({ config, rule, existing, progress, agent, onClose, onPropose, onOpenProposal }: FlowProps) {
  const [why, setWhy] = useState("");
  const draft = useMemo(() => removalDraft(config, rule, ""), [config, rule]);
  const impact = useMemo(() => (existing ? impactOf(config, draft, existing, [rule.id]) : null), [config, draft, existing, rule.id]);
  const examples = useMemo(() => (existing ? chooseExamples(config, draft, existing) : null), [config, draft, existing]);
  return (
    <FlowShell
      name="Remove this rule"
      testId="rule-remove"
      config={config}
      rule={rule}
      draft={draft}
      why={why}
      onWhy={setWhy}
      whyHint="A reviewer reads this first, and the proposal's history keeps it."
      impact={impact}
      examples={examples}
      progress={progress}
      agent={agent}
      waiting={waitingOn(config, { rule: rule.id })}
      submit="Open the proposal"
      onClose={onClose}
      onPropose={onPropose}
      onOpenProposal={onOpenProposal}
    >
      <Text.Root as="p" tone="muted">
        Once it is adopted, nothing checks this any more, on any prototype in {config.name}.
      </Text.Root>
    </FlowShell>
  );
}

function ChangeFlow({ config, rule, existing, progress, agent, onClose, onPropose, onAsk, onOpenProposal }: FlowProps) {
  const limits = useMemo(() => limitsOf(rule, config), [rule, config]);
  const [edit, setEdit] = useState<LimitEdit>({ limits: {} });
  const [why, setWhy] = useState("");
  const [wish, setWish] = useState("");
  const preview = useMemo(() => previewChange(config, rule, edit, ""), [config, rule, edit]);
  const draft = preview.state === "changed" ? preview.draft : null;
  const about = useMemo(() => [rule.id, ...(preview.state === "changed" ? preview.caps.flatMap((cap) => cap.others.map((other) => other.id)) : [])], [rule.id, preview]);
  const impact = useMemo(() => (existing && draft ? impactOf(config, draft, existing, about) : null), [config, draft, existing, about]);
  const examples = useMemo(() => (existing && draft ? chooseExamples(config, draft, existing) : null), [config, draft, existing]);
  const ruleChanges = preview.state === "changed" && preview.draft.rules.add.length > 0;
  const ask = (
    <section className="rule-flow-section" aria-labelledby="rule-flow-else" data-testid="rule-ask">
      <Text.Root as="h3" id="rule-flow-else">
        {limits.length === 0 ? "Ask the agent to change it" : "Something else about this rule"}
      </Text.Root>
      <Text.Root as="p" tone="muted">
        {limits.length === 0 ? "This rule has no number to change here. " : ""}What it selects, where it looks, or its type is a different rule, and it needs examples that pass and fail, which the agent writes. Say what should change; the message waits in the chat for you to send.
      </Text.Root>
      <Stack.Root gap="condensed">
        <Label.Root htmlFor="rule-flow-wish">What should change</Label.Root>
        <Field.Root id="rule-flow-wish">
          <Field.Textarea value={wish} onValueChange={setWish} rows={2} autoGrow maxRows={6} />
        </Field.Root>
      </Stack.Root>
      {!agent.ready && (
        <Text.Root as="p" tone="muted" className="review-small">
          {agent.why}
        </Text.Root>
      )}
      <div>
        <Button.Root
          variant="secondary"
          onClick={() => {
            onAsk(changeMessage(rule, config, wish));
            onClose();
          }}
        >
          Ask the agent to draft this change
        </Button.Root>
      </div>
    </section>
  );
  return (
    <FlowShell
      name="Change this rule"
      testId="rule-change"
      config={config}
      rule={rule}
      draft={draft}
      why={why}
      onWhy={setWhy}
      whyHint="A reviewer reads this first, and the proposal's history keeps it."
      impact={impact}
      examples={examples}
      progress={progress}
      agent={agent}
      waiting={waitingOn(config, { rule: rule.id, caps: limits.flatMap((limit) => (limit.cap !== undefined ? [limit.cap] : [])) })}
      submit="Open the proposal"
      after={ask}
      hideProposal={limits.length === 0}
      onClose={onClose}
      onPropose={onPropose}
      onOpenProposal={onOpenProposal}
    >
      {limits.length > 0 && (
        <section className="rule-flow-section" aria-labelledby="rule-flow-limits">
          <Text.Root as="h3" id="rule-flow-limits">
            {limits.length === 1 ? "Its limit" : "Its limits"}
          </Text.Root>
          <div className="rule-limits">
            {limits.map((limit) => (
              <LimitField key={limit.key} limit={limit} rule={rule} config={config} value={limit.key in edit.limits ? (edit.limits[limit.key] ?? null) : (limit.value ?? null)} onChange={(value) => setEdit((current) => ({ ...current, limits: { ...current.limits, [limit.key]: value } }))} />
            ))}
          </div>
          <div className="rule-flow-preview" aria-live="polite" data-testid="rule-preview" data-state={preview.state} {...(preview.state === "changed" ? { "data-class": preview.class } : {})}>
            {preview.state === "unchanged" && (
              <Text.Root as="p" tone="muted">
                Change a number to see the rule before and after.
              </Text.Root>
            )}
            {preview.state === "invalid" && <ErrorMessage.Root role="alert">{preview.problem}</ErrorMessage.Root>}
            {preview.state === "changed" && (
              <>
                <Moves moves={preview.moves} />
                <dl className="rule-before-after">
                  <dt>Now</dt>
                  <dd data-testid="rule-words-before">{preview.words.before}</dd>
                  <dt>After</dt>
                  <dd data-testid="rule-words-after">{preview.words.after}</dd>
                </dl>
                <Classified value={preview.class} changes={preview.changes} />
              </>
            )}
          </div>
          {ruleChanges && rule.description !== undefined && (
            <Stack.Root gap="condensed">
              <Label.Root htmlFor="rule-flow-description">The rule&apos;s own sentence (optional)</Label.Root>
              <Field.Root id="rule-flow-description">
                <Field.TextInput value={edit.description ?? ""} onValueChange={(description) => setEdit((current) => ({ ...current, description }))} />
              </Field.Root>
              <Text.Root as="p" tone="muted" className="review-small">
                It was “{rule.description}”, which may name the old limit, so it is not carried over. Left empty, the card leads with core&apos;s words above.
              </Text.Root>
            </Stack.Root>
          )}
        </section>
      )}
    </FlowShell>
  );
}

/** Each limit that moves, before and after, with a badge for the way it moved. */
export function Moves({ moves }: { readonly moves: readonly LimitMove[] }) {
  return (
    <ul className="rule-moves" aria-label="What moves">
      {moves.map((move) => (
        <li key={move.key} className="rule-move" data-testid="rule-move" data-direction={move.direction}>
          <span className="rule-move-words">
            <span data-testid="rule-move-before">{move.before}</span>
            <ArrowRight aria-hidden="true" />
            <VisuallyHidden.Root> becomes </VisuallyHidden.Root>
            <strong data-testid="rule-move-after">{move.after}</strong>
          </span>
          <Badge.Root tone={move.direction === "stricter" ? "info" : "warning"}>{move.direction === "unknown" ? "not provably stricter" : move.direction}</Badge.Root>
        </li>
      ))}
    </ul>
  );
}

/** Core's class for the draft, and its reason for each change. */
export function Classified({ value, changes }: { readonly value: ChangeClass; readonly changes: readonly ClassifiedChange[] }) {
  return (
    <>
      <Stack.Root direction="row" align="center" gap="condensed" wrap>
        <Text.Root as="span" tone="muted">
          Core classifies it:
        </Text.Root>
        <ClassBadge value={value} />
      </Stack.Root>
      <Text.Root as="p" tone="muted" className="review-small" data-testid="rule-class-reason">
        {changes.map((change) => change.reason).join("; ")}.
      </Text.Root>
    </>
  );
}

/** One limit's number. A limit that reads a cap says so, and whose rules move with it. `rule` is the rule whose limit it is, when it is a rule's; `min` is the least the number can be. */
export function LimitField({ limit, rule, config, value, onChange, min = 0 }: { readonly limit: Limit; readonly rule?: RuleSpec; readonly config: ProjectConfig; readonly value: number | null; readonly onChange: (value: number | null) => void; readonly min?: number }) {
  const id = `rule-limit-${limit.key}`;
  const others = limit.cap !== undefined ? otherReaders(config, limit.cap, rule?.id ?? "") : [];
  return (
    <div className="rule-limit" data-limit={limit.key} {...(limit.cap !== undefined ? { "data-cap": limit.cap } : {})}>
      <Label.Root htmlFor={id}>
        {limit.label}
        {limit.unit ? ` (${limit.unit})` : ""}
      </Label.Root>
      <Field.Root id={id} className="rule-limit-field" aria-describedby={`${id}-hint`}>
        <Field.Decrement />
        <Field.NumberInput value={value} min={min} step={1} placeholder={limit.required || limit.cap !== undefined ? "" : "no limit"} onValueChange={onChange} />
        <Field.Increment />
      </Field.Root>
      <Text.Root as="p" tone="muted" className="review-small" id={`${id}-hint`} data-testid={limit.cap !== undefined ? "rule-cap-note" : "rule-limit-note"}>
        {limit.cap !== undefined
          ? `This limit reads the cap ${limit.cap}, now ${limit.value ?? "not set"}. Changing it moves the cap, not this rule: ${others.length === 0 ? "no other rule reads it." : `${others.length === 1 ? "one other rule reads it" : `${others.length} other rules read it`} and moves with it: ${others.map((item) => item.id).join(", ")}.`}`
          : limit.value === undefined
            ? `Not set. Stricter when ${limit.stricter}.`
            : `Now ${limit.value}. Stricter when ${limit.stricter}.${limit.required ? "" : " Clear it to take the limit away."}`}
      </Text.Root>
    </div>
  );
}

/**
 * What a flow is about when it is not a rule itself: a number the rules
 * read, such as a task's step budget. It stands where the rule's words do,
 * and gives the shell its own words for what a rule flow says of "this rule".
 */
export type FlowSubject = {
  /** What it is, after "this" or "the": "step budget". */
  readonly noun: string;
  /** Shown where a rule flow shows the rule in core's words. */
  readonly lead: ReactNode;
  /** What a waiting proposal does to it, in a few words. */
  readonly waitingWords: (proposal: Proposal) => string;
  /** Which examples core's adoption needs for it, after "one that passes". */
  readonly examplesNeed: string;
  /** What to do when the change breaks an example an adopted proposal keeps. */
  readonly brokenAdvice: string;
  /** Attributes on the dialog, such as the task it is open on. */
  readonly data?: Readonly<Record<`data-${string}`, string>>;
};

type ShellProps = {
  readonly name: string;
  readonly testId: string;
  readonly config: ProjectConfig;
  /** The rule the flow is about; a flow about something else gives `subject`. */
  readonly rule?: RuleSpec;
  readonly subject?: FlowSubject;
  /** The draft as it stands, without its reason; null while there is nothing to propose yet. */
  readonly draft: ProposalDraft | null;
  readonly why: string;
  readonly onWhy: (value: string) => void;
  readonly whyHint: string;
  readonly impact: ImpactView | null;
  readonly examples: ExampleChoice | null;
  readonly progress: FlowProps["progress"];
  readonly agent: FlowProps["agent"];
  readonly waiting: ReturnType<typeof waitingOn>;
  readonly submit: string;
  /** What follows the proposal's own sections: another way to the same end. */
  readonly after?: ReactNode;
  /** True when the rule offers nothing to propose from here, so only `after` shows. */
  readonly hideProposal?: boolean;
  readonly children?: ReactNode;
  readonly onClose: () => void;
  readonly onPropose: FlowProps["onPropose"];
  readonly onOpenProposal: FlowProps["onOpenProposal"];
};

/** What every flow shares: the rule or what else it is about, what waits on it already, why, core's reading of the project, the examples, and the way out. */
export function FlowShell({ name, testId, config, rule, subject, draft, why, onWhy, whyHint, impact, examples, progress, agent, waiting, submit, after, hideProposal, children, onClose, onPropose, onOpenProposal }: ShellProps) {
  const [problem, setProblem] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const measuring = draft !== null && (impact === null || examples === null);
  // The card's own sentence leads; core's words follow it without repeating it as an author's note.
  const { description: _lead, ...bare } = rule ?? ({} as Partial<RuleSpec>);
  void _lead;
  const noun = subject?.noun ?? "rule";
  const open = (ask: boolean) => {
    if (!draft || !examples) return;
    if (why.trim() === "") return setProblem("Say why: a proposal needs its reason.");
    setProblem(null);
    const full = { ...draft, reason: why.trim() };
    const result = proposeByPerson(config, full, examples.examples, now());
    if (!result.ok) return setRefusal(result.error);
    onPropose(result.value, draft.id, ask ? examplesMessage(full, examples.needs) : undefined);
  };
  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()} aria-label={name} className="rule-flow" data-testid={testId} {...(rule ? { "data-rule": rule.id } : {})} {...subject?.data}>
      <Dialog.Header>
        <Dialog.Title>{name}</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <div className="rule-flow-body">
          {subject?.lead}
          {rule && (
            <section className="rule-flow-section" aria-label="The rule">
              {rule.description && (
                <Text.Root as="p" weight="medium" className="rule-flow-lead">
                  {rule.description}
                </Text.Root>
              )}
              <RuleWords rule={bare as RuleSpec} config={config} />
            </section>
          )}

          {waiting.length > 0 && (
            <Alert.Root tone="info" data-testid="rule-waiting">
              <Alert.Title>{waiting.length === 1 ? `A proposal already waits on this ${noun}` : `${waiting.length} proposals already wait on this ${noun}`}</Alert.Title>
              <Alert.Description>
                <ul className="rule-waiting">
                  {waiting.map((proposal) => (
                    <li key={proposal.id}>
                      “{proposal.title}” is {proposal.status} and {subject ? subject.waitingWords(proposal) : waitingWords(proposal, rule?.id ?? "")}.{" "}
                      <Button.Root type="button" variant="ghost" onClick={() => onOpenProposal(proposal.id)}>
                        Open it
                      </Button.Root>
                    </li>
                  ))}
                </ul>
              </Alert.Description>
            </Alert.Root>
          )}

          {children}

          {!hideProposal && (
            <>
              <Stack.Root gap="condensed" className="rule-flow-section">
                <Label.Root htmlFor="rule-flow-why">Why</Label.Root>
                <Field.Root id="rule-flow-why" invalid={problem !== null} {...(problem ? { "aria-describedby": "rule-flow-why-problem" } : {})}>
                  <Field.Textarea
                    value={why}
                    onValueChange={(value) => {
                      // The reason was missing; once it is being written, the field is no longer in error.
                      if (value.trim() !== "") setProblem(null);
                      onWhy(value);
                    }}
                    rows={2}
                    autoGrow
                    maxRows={6}
                  />
                </Field.Root>
                {problem && (
                  <ErrorMessage.Root id="rule-flow-why-problem" role="alert">
                    {problem}
                  </ErrorMessage.Root>
                )}
                <Text.Root as="p" tone="muted" className="review-small">
                  {whyHint}
                </Text.Root>
              </Stack.Root>

              {draft !== null && (
                <section className="rule-flow-section" aria-labelledby="rule-flow-impact" data-testid="rule-impact" aria-live="polite">
                  <Text.Root as="h3" id="rule-flow-impact">
                    What it would do
                  </Text.Root>
                  {measuring ? (
                    <Stack.Root direction="row" align="center" gap="condensed" data-testid="rule-measuring">
                      <Loader.Root aria-hidden="true" />
                      <Text.Root as="span" tone="muted">
                        Measuring the project&apos;s prototypes, {progress.answered} of {progress.total} frames, so core reads each as it is drawn.
                      </Text.Root>
                    </Stack.Root>
                  ) : impact && !impact.ok ? (
                    <Alert.Root tone="warning">
                      <Alert.Description>
                        Core cannot apply it to the project as it is: [{impact.refusal.code}] {impact.refusal.message}
                      </Alert.Description>
                    </Alert.Root>
                  ) : impact?.ok ? (
                    <>
                      <Text.Root as="p" data-testid="rule-impact-summary">
                        {impact.summary}
                      </Text.Root>
                      <ul className="rule-impact" aria-label="Each prototype in the project">
                        {impact.rows.map((row) => (
                          <li key={row.name} data-prototype={row.name} data-effect={row.effect}>
                            <span className="rule-impact-mark" aria-hidden="true">
                              {row.effect === "clears" ? <Check /> : row.effect === "fails" ? <X /> : <Minus />}
                            </span>
                            <span>
                              <Text.Root as="span" weight="medium">
                                {row.name}
                              </Text.Root>{" "}
                              <Text.Root as="span" tone="muted">
                                {row.text}
                              </Text.Root>
                            </span>
                          </li>
                        ))}
                      </ul>
                      {impact.retired.length > 0 && (
                        <Text.Root as="p" data-testid="rule-retired">
                          It retires {impact.retired.length === 1 ? "a failing example an adopted proposal keeps as a test" : `${impact.retired.length} failing examples adopted proposals keep as tests`}: {impact.retired.join("; ")}. With the rule gone {impact.retired.length === 1 ? "it has" : "they have"} nothing left to prove.
                        </Text.Root>
                      )}
                      {impact.broken.length > 0 && (
                        <Alert.Root tone="warning" data-testid="rule-broken">
                          <Alert.Title>Core would refuse to adopt it as it is</Alert.Title>
                          <Alert.Description>
                            An adopted proposal keeps its examples as tests, and this breaks {impact.broken.length === 1 ? "one" : impact.broken.length}: {impact.broken.join("; ")}. {subject?.brokenAdvice ?? "Remove the rule instead, which retires them, or keep the limit within what they prove."}
                          </Alert.Description>
                        </Alert.Root>
                      )}
                    </>
                  ) : null}
                </section>
              )}

              {draft !== null && examples && (
                <section className="rule-flow-section" aria-labelledby="rule-flow-examples" data-testid="rule-examples">
                  <Text.Root as="h3" id="rule-flow-examples">
                    Its examples
                  </Text.Root>
                  {onlyRemovesRules(draft) ? (
                    <Text.Root as="p" tone="muted" data-testid="rule-no-examples">
                      A removal needs none: it adds nothing an example could show firing. What it does is the list above.
                    </Text.Root>
                  ) : (
                    <Text.Root as="p" tone="muted">
                      Core adopts a proposal only on examples: one that passes{subject ? subject.examplesNeed : draft.rules.add.length > 0 ? ", and one the changed rule flags and no other rule does" : ", and one that a rule still in force flags"}. These are taken from the project as it is, never written for you.
                    </Text.Root>
                  )}
                  {examples.picked.length > 0 && (
                    <ul className="rule-examples" aria-label="Examples from the project">
                      {examples.picked.map((item) => (
                        <li key={item.name} data-example={item.name} data-expect={item.expect}>
                          <span className="rule-impact-mark" aria-hidden="true">
                            {item.expect === "pass" ? <Check /> : <X />}
                          </span>
                          <span>
                            <Text.Root as="span" weight="medium">
                              {exampleLabel(item.name)}
                            </Text.Root>{" "}
                            <Text.Root as="span" tone="muted">
                              {item.expect === "pass" ? "must pass" : `must fail, flagged by ${item.rule}`}: {item.from}, as it is now.
                            </Text.Root>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {examples.needs.length > 0 && (
                    <Alert.Root tone="warning" data-testid="rule-needs">
                      <Alert.Title>It cannot be adopted until it has {examples.needs.length === 1 ? "one more example" : "more examples"}</Alert.Title>
                      <Alert.Description>
                        The project has none of: {examples.needs.join("; ")}. You can open the proposal now and ask the agent to write {examples.needs.length === 1 ? "it" : "them"}; the message waits in the chat for you to send.{agent.ready ? "" : ` ${agent.why}`}
                      </Alert.Description>
                      <Alert.Actions>
                        <Button.Root type="button" variant="secondary" onClick={() => open(true)}>
                          Open it and ask the agent for examples
                        </Button.Root>
                      </Alert.Actions>
                    </Alert.Root>
                  )}
                </section>
              )}

              {refusal && (
                <Alert.Root tone="critical" data-testid="rule-refusal">
                  <Alert.Title>Core refused the proposal</Alert.Title>
                  <Alert.Description>
                    [{refusal.code}] {refusal.message}
                  </Alert.Description>
                </Alert.Root>
              )}
              <Text.Root as="p" tone="muted" className="review-small">
                This opens a proposal by you. The {noun} stays as it is until you approve and adopt the proposal on its review page.
              </Text.Root>
            </>
          )}

          {after}
        </div>
      </Dialog.Body>
      <Dialog.Footer>
        <Dialog.Close>Cancel</Dialog.Close>
        {!hideProposal && (
          <Button.Root type="button" variant="primary" disabled={draft === null || examples === null} onClick={() => open(false)}>
            {submit}
          </Button.Root>
        )}
      </Dialog.Footer>
    </Dialog.Root>
  );
}
