import { Button, Dialog, Field, Label, Stack, Text } from "@tounsoo/todae";
import { Plus } from "lucide-react";
import { useState } from "react";
import type { ProjectConfig } from "@design-harness/core";
import { cannotCreate } from "./new-prototype";

/**
 * New prototype: a name. A prototype is a json-render spec, pages and
 * layouts as data; there is no other format to choose. A project whose
 * library has no part description cannot check a spec, so the dialog says
 * so and makes nothing. It draws its own button unless `dialog` is given:
 * then the caller opens it, from a menu item say, and owns whether it is open.
 */
export function NewPrototype({ config, onCreate, dialog }: { readonly config: ProjectConfig; readonly onCreate: (name: string) => void; readonly dialog?: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void } }) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = dialog ? dialog.open : ownOpen;
  const setOpen = dialog ? dialog.onOpenChange : setOwnOpen;
  const [name, setName] = useState("");
  const why = cannotCreate(config);
  const create = () => {
    const trimmed = name.trim();
    if (!trimmed || why !== null) return;
    onCreate(trimmed);
    setOpen(false);
    setName("");
  };
  return (
    <>
      {!dialog && (
        <Button.Root variant="ghost" onClick={() => setOpen(true)}>
          <Button.Icon>
            <Plus />
          </Button.Icon>
          New prototype
        </Button.Root>
      )}
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
              <Dialog.Description>Start an empty prototype in {config.name}. Then describe it to the agent, and it builds it on the canvas.</Dialog.Description>
              <Stack.Root gap="condensed">
                <Label.Root htmlFor="new-prototype-name">Name</Label.Root>
                <Field.Root id="new-prototype-name">
                  <Field.TextInput value={name} onValueChange={setName} placeholder="Checkout" />
                </Field.Root>
              </Stack.Root>
              {why !== null && (
                <Text.Root as="p" tone="muted" data-testid="new-prototype-unavailable">
                  {why}
                </Text.Root>
              )}
            </Stack.Root>
          </form>
        </Dialog.Body>
        <Dialog.Footer>
          <Dialog.Close>Cancel</Dialog.Close>
          <Button.Root type="submit" form="new-prototype-form" variant="primary" disabled={name.trim() === "" || why !== null}>
            Create
          </Button.Root>
        </Dialog.Footer>
      </Dialog.Root>
    </>
  );
}
