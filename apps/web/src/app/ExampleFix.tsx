import { Alert, Button, Stack, Text } from "@tounsoo/todae";
import { useState } from "react";
import type { ExampleFix, ExampleFixes } from "../review/fix-examples";
import { exampleLabel } from "./words";

/**
 * Fixing a proposal's examples yourself, when they are why it can't be
 * accepted: take out an example that isn't needed, or put one of the
 * project's own prototypes in its place. Only prototypes core's check says
 * would do the job are offered; each choice is a revision of the proposal by
 * you, kept in its history, and core judges the examples again after it.
 */
export function ExampleFixCard({ fixes, onFix }: { readonly fixes: ExampleFixes; readonly onFix: (fix: ExampleFix) => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const side = fixes.side === "pass" ? "Allowed" : "Not allowed";
  const target = fixes.target;
  const run = async (fix: ExampleFix) => {
    setBusy(true);
    const refused = await onFix(fix);
    setBusy(false);
    setProblem(refused);
  };
  const lead = target
    ? fixes.choices.length > 0
      ? `You can fix this yourself: put one of your prototypes in place of the “${side}” example “${exampleLabel(target.name)}”${fixes.canRemove ? ", or take that example out, since the proposal has enough without it" : ""}.`
      : fixes.canRemove
        ? `You can fix this yourself: the proposal has enough examples without “${exampleLabel(target.name)}”, so you can take it out.`
        : `None of your prototypes would do as the “${side}” example in place of “${exampleLabel(target.name)}”${fixes.side === "fail" ? ": none is caught by this rule and by no other" : ": none passes every rule with this change"}. Ask the agent for another example, or decline it.`
    : fixes.choices.length > 0
      ? `You can fix this yourself: add one of your prototypes as its “${side}” example.`
      : `None of your prototypes would do as its “${side}” example. Ask the agent for one, or decline it.`;
  return (
    <div className="review-fix" data-testid="example-fix" data-side={fixes.side} data-example={target?.name}>
      <Stack.Root gap="condensed">
        <Text.Root as="p" data-testid="example-fix-lead">
          {lead}
        </Text.Root>
        {fixes.choices.length > 0 && (
          <ul className="review-fix-choices" aria-label={`Your prototypes that would do as the “${side}” example`}>
            {fixes.choices.map((choice) => (
              <li key={choice.name} data-prototype={choice.name}>
                <Button.Root
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void run({ kind: "use", prototype: choice.name, side: fixes.side, ...(fixes.rule !== undefined ? { rule: fixes.rule } : {}), ...(target ? { replaces: target } : {}) })}
                >
                  {target ? `Use “${choice.name}” instead` : `Add “${choice.name}”`}
                </Button.Root>
              </li>
            ))}
          </ul>
        )}
        {fixes.choices.length > 0 && (
          <Text.Root as="p" tone="muted" className="review-small">
            {fixes.side === "fail" ? "Each of these is caught by the rule and by no other, with this change in place." : "Each of these passes every rule, with this change in place."} It is used as it is now; your choice is kept in the proposal&apos;s history.
          </Text.Root>
        )}
        {target && fixes.canRemove && (
          <div>
            <Button.Root variant="ghost" disabled={busy} onClick={() => void run({ kind: "remove", example: target })}>
              {`Take out “${exampleLabel(target.name)}”`}
            </Button.Root>
          </div>
        )}
        {problem && (
          <Alert.Root tone="warning" data-testid="example-fix-refused">
            <Alert.Description>It wasn&apos;t changed: {problem}</Alert.Description>
          </Alert.Root>
        )}
      </Stack.Root>
    </div>
  );
}
