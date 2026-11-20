import { Alert, ErrorMessage, Text } from "@tounsoo/todae";
import { useMemo, useState } from "react";
import type { Task } from "@design-harness/core";
import { budgetLimit, budgetWaiting, budgetWaitingWords, previewBudget, taskName } from "../review/budget-change";
import { chooseExamples, impactOf, stepBudgetRules } from "../review/rule-change";
import { BudgetFigure } from "../visual/project-figures";
import type { BudgetMeter } from "../visual/project-model";
import { RuleWords } from "./proposal-parts";
import { Classified, FlowShell, LimitField, Moves, type FlowContext, type FlowSubject } from "./RuleChange";

/** The task whose step budget a flow is open on. */
export type BudgetFlow = { readonly kind: "budget"; readonly task: string };

type Props = Omit<FlowContext, "onAsk"> & {
  /** The budget in words with what the open prototype's longest route takes today, as the Project view shows it. */
  readonly meter: BudgetMeter;
};

/**
 * Changing a task's step budget starts here, from the task in the Project
 * view, and ends as an open proposal by the person on its review page, as
 * a rule's limit does (`RuleChange.tsx`, whose shell and parts this is
 * built from): the budget stays as it is until they accept it
 * there. The dialog shows the budget and the rule that reads it, takes the
 * new number, says it before and after with core's class and reason, and
 * says what core reads in every prototype's routes with it applied.
 */
export function BudgetFlowDialog({ flow, config, ...rest }: Props & { readonly flow: BudgetFlow }) {
  const task = config.inputs.tasks.find((item) => item.id === flow.task);
  return task ? <BudgetChange config={config} task={task} {...rest} /> : null;
}

function BudgetChange({ config, task, meter, existing, progress, agent, onClose, onPropose, onOpenProposal }: Props & { readonly task: Task }) {
  const [value, setValue] = useState<number | null>(task.maxSteps);
  const [why, setWhy] = useState("");
  const limit = useMemo(() => budgetLimit(task), [task]);
  const preview = useMemo(() => previewBudget(config, task, value, ""), [config, task, value]);
  const draft = preview.state === "changed" ? preview.draft : null;
  const rules = useMemo(() => stepBudgetRules(config), [config]);
  const said = rules.length === 1 ? `the rule ${rules[0]?.id ?? ""}` : "the rules that read step budgets";
  const impact = useMemo(() => (existing && draft ? impactOf(config, draft, existing, rules.map((rule) => rule.id), said) : null), [config, draft, existing, rules, said]);
  const examples = useMemo(() => (existing && draft ? chooseExamples(config, draft, existing) : null), [config, draft, existing]);
  const stricter = preview.state === "changed" && preview.move.direction === "stricter";
  const subject: FlowSubject = {
    noun: "step budget",
    lead: (
      <section className="rule-flow-section" aria-label="The task and its step budget" data-testid="budget-subject">
        <Text.Root as="p" weight="medium" className="rule-flow-lead">
          {taskName(task)}
        </Text.Root>
        <BudgetFigure meter={meter} />
        {rules.length === 0 ? (
          <Alert.Root tone="info" data-testid="budget-unread">
            <Alert.Description>No rule in force reads step budgets, so moving this one changes no report. The built-in rule step-budget was removed from {config.name}.</Alert.Description>
          </Alert.Root>
        ) : (
          rules.map((rule) => (
            <div key={rule.id}>
              <Text.Root as="p" tone="muted" className="review-small">
                The rule that reads it:
              </Text.Root>
              <RuleWords rule={rule} config={config} />
            </div>
          ))
        )}
      </section>
    ),
    waitingWords: (proposal) => budgetWaitingWords(proposal, task.id),
    examplesNeed: stricter && rules.length > 0 ? ", and one whose route goes over the new budget and breaks no other rule" : ", and one that a rule still in force stops",
    brokenAdvice: "Keep the budget within what they prove.",
    data: { "data-task": task.id },
  };
  return (
    <FlowShell
      name="Change its step budget"
      testId="budget-flow"
      config={config}
      subject={subject}
      draft={draft}
      why={why}
      onWhy={setWhy}
      whyHint="You read this first when you decide, and it is kept with the proposal."
      impact={impact}
      examples={examples}
      progress={progress}
      agent={agent}
      waiting={budgetWaiting(config, task.id)}
      submit="Open the proposal"
      onClose={onClose}
      onPropose={onPropose}
      onOpenProposal={onOpenProposal}
    >
      <section className="rule-flow-section" aria-labelledby="budget-flow-limit">
        <Text.Root as="h3" id="budget-flow-limit">
          Its budget
        </Text.Root>
        <div className="rule-limits">
          <LimitField limit={limit} config={config} value={value} min={1} onChange={setValue} />
        </div>
        <div className="rule-flow-preview" aria-live="polite" data-testid="rule-preview" data-state={preview.state} {...(preview.state === "changed" ? { "data-class": preview.class } : {})}>
          {preview.state === "unchanged" && (
            <Text.Root as="p" tone="muted">
              Change the number to see the budget before and after.
            </Text.Root>
          )}
          {preview.state === "invalid" && <ErrorMessage.Root role="alert">{preview.problem}</ErrorMessage.Root>}
          {preview.state === "changed" && (
            <>
              <Moves moves={[preview.move]} />
              <Classified value={preview.class} changes={preview.changes} />
            </>
          )}
        </div>
      </section>
    </FlowShell>
  );
}
