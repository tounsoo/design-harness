import { Disclosure, Stack, Text } from "@tounsoo/todae";

/** What a room has, and how to reach it, each behind its own disclosure. */
export function RoomDetails({ items }: { items: readonly string[] }) {
  return (
    <Stack.Root gap="normal">
      <Disclosure.Root>
        <Disclosure.Summary>Room details</Disclosure.Summary>
        {items.map((item) => (
          <Text.Root as="p" key={item}>
            {item}
          </Text.Root>
        ))}
      </Disclosure.Root>
      <Disclosure.Root>
        <Disclosure.Summary>Getting there</Disclosure.Summary>
        <Text.Root as="p">Second floor, past the kitchen</Text.Root>
      </Disclosure.Root>
    </Stack.Root>
  );
}
