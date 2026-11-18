import { Alert, Badge, Button, Checkbox, CodeBlock, Conversation, Disclosure, ErrorMessage, Field, Label, Loader, Message, Stack, Text } from "@tounsoo/todae";
import { useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from "react";
import type { AgentController, Turn, TurnItem } from "../agent/controller";
import { KEY_DB, keyProblem, type KeyVault } from "../agent/key-vault";
import { EFFORTS, MODELS, formatCost, isEffort, isModel, type AgentSettings } from "../agent/models";
import { DB_NAME } from "../store/db";

/**
 * The agent chat. The person's key is entered here and held by the app (see
 * KeyVault); messages stream in as they arrive, each tool call is one
 * compact line that opens to its input and result, the checks the app ran
 * show their verdict, and each turn shows its tokens, an approximate cost,
 * and an Undo for its changes. Nothing here decides pass or fail.
 */
export function ChatPanel({ controller, vault, settings, onSettings }: { readonly controller: AgentController; readonly vault: KeyVault; readonly settings: AgentSettings; readonly onSettings: (next: AgentSettings) => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const key = useSyncExternalStore(vault.subscribe, vault.getState);
  const [draft, setDraft] = useState("");
  const undoable = controller.undoable();
  const model = MODELS.find((item) => item.id === settings.model)?.name ?? settings.model;

  const send = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || state.running || !key.present || !state.loaded) return;
    setDraft("");
    void controller.send(text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) send(event as unknown as FormEvent);
  };

  return (
    <aside className="chat" aria-label="Agent chat">
      <Stack.Root direction="row" align="center" gap="condensed" className="chat-head">
        <Text.Root as="h2" className="chat-title">
          Agent
        </Text.Root>
        <Badge.Root tone="neutral">
          {model} · {settings.effort}
        </Badge.Root>
        {state.running && <Loader.Root aria-label="The agent is working" className="chat-busy" />}
      </Stack.Root>

      {!key.present ? (
        <KeyForm vault={vault} />
      ) : (
        <Disclosure.Root className="chat-settings">
          <Disclosure.Summary>Settings and key</Disclosure.Summary>
          <Settings vault={vault} settings={settings} onSettings={onSettings} disabled={state.running} />
        </Disclosure.Root>
      )}

      {state.problem && (
        <Alert.Root tone="warning">
          <Alert.Description>{state.problem}</Alert.Description>
        </Alert.Root>
      )}

      <Conversation.Root className="chat-conversation">
        <Conversation.Viewport aria-label="Conversation with the agent" className="chat-viewport">
          <Conversation.Content className="chat-content">
            {state.turns.length === 0 && (
              <Text.Root as="p" tone="muted" className="chat-hint">
                Ask the agent to build or change the prototype. It reads the project, edits files, and the frames and checks follow. When the checks fail it gets their report and fixes what they say; when the work needs something outside the inventories, it drafts a proposal for you.
              </Text.Root>
            )}
            {state.turns.map((turn, index) => (
              <TurnView
                key={turn.id}
                turn={turn}
                running={state.running && index === state.turns.length - 1}
                canUndo={undoable?.id === turn.id}
                onUndo={() => void controller.undo(turn.id)}
                onRetry={() => void controller.retry()}
              />
            ))}
          </Conversation.Content>
        </Conversation.Viewport>
        <Conversation.ScrollButton />
      </Conversation.Root>

      <form className="chat-composer" onSubmit={send}>
        <Field.Root aria-label="Message the agent" disabled={!key.present} className="chat-input">
          <Field.Textarea value={draft} onValueChange={setDraft} onKeyDown={onKeyDown} rows={3} maxRows={8} autoGrow placeholder={key.present ? "Ask for a change. Enter sends, Shift+Enter is a new line." : "Enter your API key first"} />
        </Field.Root>
        <Stack.Root direction="row" align="center" justify="end" gap="condensed">
          {state.running ? (
            <Button.Root type="button" variant="secondary" onClick={() => controller.stop()}>
              Stop
            </Button.Root>
          ) : (
            <Button.Root type="submit" variant="primary" disabled={!key.present || draft.trim() === ""}>
              Send
            </Button.Root>
          )}
        </Stack.Root>
      </form>
    </aside>
  );
}

function KeyForm({ vault }: { readonly vault: KeyVault }) {
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const key = value.trim();
    const why = keyProblem(key);
    if (why) return setProblem(why);
    try {
      await vault.set(key, remember);
      setValue("");
      setProblem(null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <form className="chat-key" onSubmit={(event) => void submit(event)}>
      <Stack.Root gap="condensed">
        <Label.Root htmlFor="agent-key">Your Anthropic API key</Label.Root>
        <Field.Root id="agent-key" invalid={problem !== null} {...(problem ? { "aria-describedby": "agent-key-problem" } : {})}>
          <Field.TextInput type="password" value={value} onValueChange={setValue} autoComplete="off" spellCheck={false} placeholder="sk-ant-..." />
        </Field.Root>
        {problem && (
          <ErrorMessage.Root id="agent-key-problem" role="alert">
            {problem}
          </ErrorMessage.Root>
        )}
        <Checkbox.Root checked={remember} onCheckedChange={setRemember}>
          Remember on this device
        </Checkbox.Root>
        <Text.Root as="p" tone="muted" className="chat-small">
          Kept in this tab's memory and sent only to api.anthropic.com. Remember also stores it in this browser's IndexedDB on this device, until you forget it. It never goes into a prototype, an export or a frame.
        </Text.Root>
        <Button.Root type="submit" variant="primary">
          Use this key
        </Button.Root>
      </Stack.Root>
    </form>
  );
}

function Settings({ vault, settings, onSettings, disabled }: { readonly vault: KeyVault; readonly settings: AgentSettings; readonly onSettings: (next: AgentSettings) => void; readonly disabled: boolean }) {
  const key = useSyncExternalStore(vault.subscribe, vault.getState);
  return (
    <Stack.Root gap="condensed" className="chat-settings-body">
      <Stack.Root direction="row" gap="condensed">
        <Stack.Root gap="condensed" className="chat-setting">
          <Label.Root htmlFor="agent-model">Model</Label.Root>
          <Field.Root id="agent-model" disabled={disabled}>
            <Field.Select value={settings.model} onValueChange={(value) => isModel(value) && onSettings({ ...settings, model: value })}>
              {MODELS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Field.Select>
          </Field.Root>
        </Stack.Root>
        <Stack.Root gap="condensed" className="chat-setting">
          <Label.Root htmlFor="agent-effort">Effort</Label.Root>
          <Field.Root id="agent-effort" disabled={disabled}>
            <Field.Select value={settings.effort} onValueChange={(value) => isEffort(value) && onSettings({ ...settings, effort: value })}>
              {EFFORTS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Field.Select>
          </Field.Root>
        </Stack.Root>
      </Stack.Root>
      <Text.Root as="p" className="chat-small" data-testid="key-status">
        Key {key.hint}: {key.remembered ? `in this tab's memory, and stored on this device in IndexedDB database "${KEY_DB}" for ${window.location.origin}.` : "in this tab's memory for this session only; it is gone when the tab closes."}
      </Text.Root>
      <Text.Root as="p" tone="muted" className="chat-small">
        This prototype's chat is stored in IndexedDB database "{DB_NAME}", store "chats", without the key. Model and effort are in localStorage.
      </Text.Root>
      <Stack.Root direction="row" gap="condensed">
        <Button.Root type="button" variant="secondary" onClick={() => void vault.forget()} disabled={disabled}>
          Forget the key
        </Button.Root>
      </Stack.Root>
    </Stack.Root>
  );
}

function usageText(turn: Turn): string {
  const { usage } = turn;
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  const cached = usage.cacheRead > 0 ? `, ${usage.cacheRead.toLocaleString()} from cache` : "";
  return `${input.toLocaleString()} in${cached} · ${usage.output.toLocaleString()} out · about ${formatCost(turn.cost)}`;
}

function TurnView({ turn, running, canUndo, onUndo, onRetry }: { readonly turn: Turn; readonly running: boolean; readonly canUndo: boolean; readonly onUndo: () => void; readonly onRetry: () => void }) {
  return (
    <>
      <Message.Root from="user" data-turn={turn.id}>
        <Message.Content>
          <Text.Root as="p" className="pre">
            {turn.text}
          </Text.Root>
        </Message.Content>
      </Message.Root>
      <Message.Root from="assistant" streaming={running} data-turn={turn.id} data-end={turn.end.status} className="chat-reply">
        <Message.Content className="chat-items">
          {turn.items.map((item, index) => (
            <Item key={index} item={item} />
          ))}
          {running && turn.items.length === 0 && (
            <Text.Root as="p" tone="muted">
              Thinking…
            </Text.Root>
          )}
          <End turn={turn} onRetry={onRetry} />
        </Message.Content>
        {turn.end.status !== "running" && (
          <Message.Actions className="chat-actions">
            <Text.Root as="span" tone="muted" className="chat-small" data-testid="turn-usage">
              {usageText(turn)}
            </Text.Root>
            {turn.before !== null &&
              (turn.undone ? (
                <Badge.Root tone="neutral">Undone</Badge.Root>
              ) : canUndo ? (
                <Button.Root type="button" variant="ghost" onClick={onUndo}>
                  Undo this turn
                </Button.Root>
              ) : null)}
          </Message.Actions>
        )}
      </Message.Root>
    </>
  );
}

function End({ turn, onRetry }: { readonly turn: Turn; readonly onRetry: () => void }) {
  const end = turn.end;
  switch (end.status) {
    case "error":
      return (
        <Alert.Root tone="critical" className="chat-end">
          <Alert.Title>{end.title}</Alert.Title>
          <Alert.Description>{end.detail}</Alert.Description>
          {end.retry && (
            <Alert.Actions>
              <Button.Root type="button" variant="secondary" onClick={onRetry}>
                Retry
              </Button.Root>
            </Alert.Actions>
          )}
        </Alert.Root>
      );
    case "refused":
      return (
        <Alert.Root tone="warning" className="chat-end">
          <Alert.Title>The model declined this request</Alert.Title>
          <Alert.Description>
            {end.explanation ?? "No explanation was given."}
            {end.category ? ` (category: ${end.category})` : ""} Nothing it started was kept or run.
          </Alert.Description>
        </Alert.Root>
      );
    case "limit":
      return (
        <Alert.Root tone="info" className="chat-end">
          <Alert.Description>The agent stopped after {end.rounds} rounds of tool calls for this message. Send another message to let it go on.</Alert.Description>
        </Alert.Root>
      );
    case "cut-off":
      return (
        <Alert.Root tone="warning" className="chat-end">
          <Alert.Description>The reply reached its length limit in the middle of a tool call, so nothing ran. Ask for a smaller step.</Alert.Description>
        </Alert.Root>
      );
    case "stopped":
      return (
        <Text.Root as="p" tone="muted" className="chat-small">
          Stopped.
        </Text.Root>
      );
    default:
      return null;
  }
}

function toolTone(status: string): "neutral" | "info" | "success" | "critical" {
  return status === "error" ? "critical" : status === "done" ? "success" : "info";
}

function Item({ item }: { readonly item: TurnItem }) {
  switch (item.kind) {
    case "text":
      return item.text ? (
        <Text.Root as="p" className="pre chat-text">
          {item.text}
        </Text.Root>
      ) : null;
    case "thinking":
      return item.text ? (
        <Disclosure.Root className="chat-thinking">
          <Disclosure.Summary>Thinking</Disclosure.Summary>
          <Text.Root as="p" tone="muted" className="pre chat-small">
            {item.text}
          </Text.Root>
        </Disclosure.Root>
      ) : null;
    case "tool":
      return (
        <Disclosure.Root className="chat-tool" data-tool={item.name} data-status={item.status}>
          <Disclosure.Summary>
            <span className="chat-tool-head">
              <Badge.Root tone={toolTone(item.status)}>{item.status === "streaming" ? "writing" : item.status === "running" ? "running" : item.status === "error" ? "refused" : "done"}</Badge.Root>
              <span className="chat-tool-title">{item.status === "streaming" ? `${item.title} (${item.input.length} characters)` : item.title}</span>
            </span>
          </Disclosure.Summary>
          <Text.Root as="p" tone="muted" className="chat-small">
            {item.name} input
          </Text.Root>
          <CodeBlock.Root className="chat-pre">{item.input || "{}"}</CodeBlock.Root>
          {item.result !== undefined && (
            <>
              <Text.Root as="p" tone="muted" className="chat-small">
                Result
              </Text.Root>
              <CodeBlock.Root className="chat-pre">{item.result}</CodeBlock.Root>
            </>
          )}
        </Disclosure.Root>
      );
    case "checks":
      return (
        <Disclosure.Root className="chat-checks" data-status={item.status}>
          <Disclosure.Summary>
            <span className="chat-tool-head">
              <Badge.Root tone={item.status === "pass" ? "success" : item.status === "fail" ? "critical" : "neutral"}>{item.status}</Badge.Root>
              <span className="chat-tool-title">
                {item.title}, revision {item.revision}
              </span>
            </span>
          </Disclosure.Summary>
          <CodeBlock.Root className="chat-pre">{item.text}</CodeBlock.Root>
        </Disclosure.Root>
      );
    case "proposal":
      return (
        <Alert.Root tone={item.adoptable ? "info" : "warning"} className="chat-proposal" data-proposal={item.id}>
          <Alert.Title>
            Proposal drafted: {item.title} ({item.id}), open
          </Alert.Title>
          <Alert.Description>
            {item.verdict} Only you can approve or adopt it; it is listed in the Project view.
          </Alert.Description>
        </Alert.Root>
      );
    case "notice":
      return (
        <Text.Root as="p" tone="muted" className="chat-small">
          {item.text}
        </Text.Root>
      );
  }
}
