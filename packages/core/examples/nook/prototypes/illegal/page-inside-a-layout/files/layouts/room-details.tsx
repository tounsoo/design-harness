import { Disclosure, Stack, Text } from "@tounsoo/todae";
import RoomsPage from "../pages/rooms";

/** What a room has, closed behind the one disclosure, whose summary is the disclosed section's name. */
export function RoomDetails({ items }: { items: readonly string[] }) {
  return (
    <Disclosure.Root>
      <Disclosure.Summary>Room details</Disclosure.Summary>
      <Stack.Root gap="condensed">
        {items.map((item) => (
          <Text.Root as="p" key={item}>
            {item}
          </Text.Root>
        ))}
      </Stack.Root>
      <RoomsPage />
    </Disclosure.Root>
  );
}
