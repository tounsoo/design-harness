import { Slot } from "@design-harness/page";
import { Text } from "@tounsoo/todae";
import { RoomCards } from "../layouts";

/** The rooms page: a collection, so it chooses a room and holds no primary action. */
export default function RoomsPage() {
  return (
    <>
      <Slot name="title">
        <Text.Root as="h1">Rooms</Text.Root>
      </Slot>
      <Slot name="intro">
        <Text.Root as="strong">Pick a free room to book or hold.</Text.Root>
      </Slot>
      <Slot name="body">
        <RoomCards />
      </Slot>
    </>
  );
}
