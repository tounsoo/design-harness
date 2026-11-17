import { Button, Card, Stack, Text } from "@tounsoo/todae";
import { rooms } from "../data/rooms";

/** One card per room, each opening that room's booking page. */
export function RoomCards() {
  return (
    <Stack.Root gap="normal">
      {rooms.map((room) => (
        <Card.Root key={room.id}>
          <Text.Root as="h2">{room.name}</Text.Root>
          <Text.Root as="p">{room.seats} seats</Text.Root>
          <Button.Root variant="secondary">Open {room.name}</Button.Root>
        </Card.Root>
      ))}
    </Stack.Root>
  );
}
