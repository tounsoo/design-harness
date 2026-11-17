import { useRef } from "react";
import { Disclosure, Stack, Text } from "@tounsoo/todae";

/** What a room has, closed behind the one disclosure, whose summary is the disclosed section's name. */
export function RoomDetails({ items }: { items: readonly string[] }) {
  // A handle on the rendered node, from which the frame's document is one step away.
  const node = useRef<HTMLDetailsElement>(null);
  return (
    <Disclosure.Root ref={node}>
      <Disclosure.Summary>Room details</Disclosure.Summary>
      <Stack.Root gap="condensed">
        {items.map((item) => (
          <Text.Root as="p" key={item}>
            {item}
          </Text.Root>
        ))}
      </Stack.Root>
    </Disclosure.Root>
  );
}
