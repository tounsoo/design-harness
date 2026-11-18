import { Badge, EmptyState, Field, Stack, Text } from "@tounsoo/todae";

/**
 * The place the agent's chat will take. Nothing here talks to a model or
 * asks for a key: until the agent arrives, the code view stands in for it.
 */
export function ChatPanel() {
  return (
    <aside className="chat" aria-label="Agent chat (not available yet)">
      <Stack.Root direction="row" align="center" gap="condensed" className="chat-head">
        <Text.Root as="h2" className="chat-title">
          Agent
        </Text.Root>
        <Badge.Root tone="neutral">Not available yet</Badge.Root>
      </Stack.Root>
      <EmptyState.Root className="chat-empty">
        <EmptyState.Title as="h3">The agent comes next</EmptyState.Title>
        <EmptyState.Description>Here you will ask an agent to change the prototype, and watch the canvas and the checks follow. For now, edit the prototype's files in the Code panel.</EmptyState.Description>
      </EmptyState.Root>
      <Field.Root disabled className="chat-input" aria-label="Message the agent (not available yet)">
        <Field.Textarea value="" rows={3} placeholder="Chat is not available yet" />
      </Field.Root>
    </aside>
  );
}
