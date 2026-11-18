import { Slot } from "@design-harness/page";
import { Button, Text } from "@tounsoo/todae";
import { RoomCards } from "../layouts";

/** The rooms page: a collection, so it chooses a room and holds no primary action. */
export default function RoomsPage() {
  return (
    <>
      <Slot name="title">
        <Text.Root as="h1">Rooms</Text.Root>
      </Slot>
      <Slot name="intro">
        <Text.Root as="p">Pick a free room to book or hold.</Text.Root>
        <Button.Root variant="primary">Book room</Button.Root>
      </Slot>
      <Slot name="body">
        <RoomCards />
      </Slot>
    </>
  );
}
