import { Button } from "@tounsoo/todae";

const Strong = Button.Root;

export default function Confirm({ label }: { label: string }) {
  return <Strong variant="primary">{label}</Strong>;
}
