import { useId } from "react";
import { Field, Label, Stack } from "@tounsoo/todae";

type Choice = { readonly value: string; readonly label: string };

/** One question answered by picking one of a few choices. The label names the field, so a screen reader announces the question. */
export default function SelectQuestion({ label, choices }: { label: string; choices: readonly Choice[] }) {
  const fieldId = useId();
  return (
    <Stack.Root gap="condensed">
      <Label.Root htmlFor={fieldId}>{label}</Label.Root>
      <Field.Root id={fieldId}>
        <Field.Select onFocus={(event) => event.target}>
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </Field.Select>
      </Field.Root>
    </Stack.Root>
  );
}
