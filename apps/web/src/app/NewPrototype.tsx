import { Button, Dialog, Field, Label, RadioGroup, Stack, Text } from "@tounsoo/todae";
import { useState } from "react";
import { specCatalog, type ProjectConfig } from "@design-harness/core";
import { defaultFormat, type PrototypeFormat } from "./new-prototype";

/**
 * New prototype: a name and a format, json-render spec by default. TSX is
 * one choice away; the prototypes already in the project keep the format
 * they were made in.
 */
export function NewPrototype({ config, onCreate }: { readonly config: ProjectConfig; readonly onCreate: (name: string, format: PrototypeFormat) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const specs = specCatalog(config) !== null;
  const [format, setFormat] = useState<PrototypeFormat>(defaultFormat(config));
  const create = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed, format);
    setOpen(false);
    setName("");
    setFormat(defaultFormat(config));
  };
  return (
    <>
      <Button.Root variant="ghost" onClick={() => setOpen(true)}>
        New prototype
      </Button.Root>
      <Dialog.Root open={open} onOpenChange={(next) => setOpen(next)} aria-label="New prototype" className="new-prototype">
        <Dialog.Header>
          <Dialog.Title>New prototype</Dialog.Title>
        </Dialog.Header>
        <Dialog.Body>
          <form
            id="new-prototype-form"
            onSubmit={(event) => {
              event.preventDefault();
              create();
            }}
          >
            <Stack.Root gap="normal">
              <Dialog.Description>An empty prototype in {config.name}, for the agent or the code view to build.</Dialog.Description>
              <Stack.Root gap="condensed">
                <Label.Root htmlFor="new-prototype-name">Name</Label.Root>
                <Field.Root id="new-prototype-name">
                  <Field.TextInput value={name} onValueChange={setName} placeholder="Checkout" />
                </Field.Root>
              </Stack.Root>
              <Stack.Root gap="condensed">
                <Text.Root as="span" weight="medium" id="new-prototype-format">
                  Format
                </Text.Root>
                <RadioGroup.Root aria-labelledby="new-prototype-format" value={format} onValueChange={(value) => setFormat(value === "tsx" ? "tsx" : "spec")}>
                  <RadioGroup.Item value="spec" disabled={!specs}>
                    json-render spec (default): pages and layouts as data, checked against the catalog before they apply
                  </RadioGroup.Item>
                  <RadioGroup.Item value="tsx">TSX: pages and layouts as React code</RadioGroup.Item>
                </RadioGroup.Root>
                {!specs && (
                  <Text.Root as="p" tone="muted">
                    The project's library has no part description, so a spec prototype cannot be checked here.
                  </Text.Root>
                )}
              </Stack.Root>
            </Stack.Root>
          </form>
        </Dialog.Body>
        <Dialog.Footer>
          <Dialog.Close>Cancel</Dialog.Close>
          <Button.Root type="submit" form="new-prototype-form" variant="primary" disabled={name.trim() === ""}>
            Create
          </Button.Root>
        </Dialog.Footer>
      </Dialog.Root>
    </>
  );
}
