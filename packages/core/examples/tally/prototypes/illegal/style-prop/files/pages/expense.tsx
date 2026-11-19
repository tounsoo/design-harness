import { Slot, type PageProps } from "@design-harness/page";
import { Button, Text, Title } from "@mantine/core";
import AmountQuestion from "../layouts/amount-question";
import ReceiptRules from "../layouts/receipt-rules";

const expense = { id: "lunch", name: "Team lunch", category: "Meals", date: "12 March", amount: "48.20" };

const rules = ["Attach a receipt for anything over 25 euros", "Name everyone at the meal"];

/** The expense page, written from pages/expense.json. */
export default function ExpensePage({ state }: PageProps) {
  return (
    <>
      <Slot name="title">
        <Title order={1}>{expense.name}</Title>
      </Slot>
      <Slot name="facts">
        <Text>{expense.category}, {expense.date}</Text>
        {state === "submitted" && <Text>Submitted for approval</Text>}
        {state === "saved" && <Text>Saved as a draft</Text>}
      </Slot>
      <Slot name="body">
        <AmountQuestion amount={expense.amount} label="Amount in euros" />
        <ReceiptRules items={rules} />
      </Slot>
      <Slot name="alternate">
        <Button color="violet" variant="outline">Save draft</Button>
      </Slot>
      <Slot name="action">
        <Button bg="grape" color="violet" variant="filled">Submit expense</Button>
      </Slot>
    </>
  );
}
