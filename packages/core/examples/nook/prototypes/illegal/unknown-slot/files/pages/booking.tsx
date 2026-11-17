import { Slot } from "@design-harness/page";
import { Button, Text } from "@tounsoo/todae";
import { RoomDetails, SelectQuestion } from "../layouts";
import { lantern } from "../data/rooms";

const durations = [
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
];

/** One room being booked: Book room is the one primary action, Hold room the secondary. */
export function BookingPage() {
  return (
    <>
      <Slot name="title">
        <Text.Root as="h1">{lantern.name}</Text.Root>
      </Slot>
      <Slot name="facts">
        <Text.Root as="p">
          {lantern.seats} seats, {lantern.floor}
        </Text.Root>
      </Slot>
      <Slot name="body">
        <SelectQuestion label="How long?" choices={durations} />
        <RoomDetails items={lantern.details} />
      </Slot>
      <Slot name="alternate">
        <Button.Root variant="secondary">Hold room</Button.Root>
      </Slot>
      <Slot name="footer">
        <Text.Root as="p">Questions? Ask reception.</Text.Root>
      </Slot>
      <Slot name="action">
        <Button.Root variant="primary">Book room</Button.Root>
      </Slot>
    </>
  );
}
