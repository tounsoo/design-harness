import { Field, Label, Stack } from "@tounsoo/todae";
import * as UI from "@tounsoo/todae";

type Choice = { readonly value: string; readonly label: string };

/** One question answered by picking one of a few choices. */
export default function SelectQuestion({ label, choices }: { label: string; choices: readonly Choice[] }) {
  return (
    <Stack.Root gap="condensed">
      <Label.Root>{label}</Label.Root>
      <Field.Root>
        <Field.Select>
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </Field.Select>
      </Field.Root>
      <UI.Button.Root variant="primary">Book room</UI.Button.Root>
    </Stack.Root>
  );
}
