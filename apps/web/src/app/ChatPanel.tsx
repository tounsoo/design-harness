import { Alert, Badge, Button, Checkbox, Code, CodeBlock, Conversation, DataList, Disclosure, ErrorMessage, Field, Label, Loader, Message, Stack, Text } from "@tounsoo/todae";
import { ArrowUp, Check, CircleAlert, CircleCheck, Columns2, FileCode2, KeyRound, Lightbulb, Pencil, Sparkles, Square, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import type { AgentController, Turn, TurnItem } from "../agent/controller";
import { KEY_DB, keyProblem, type KeyVault } from "../agent/key-vault";
import { EFFORTS, MODELS, formatCost, isEffort, isModel, type AgentSettings } from "../agent/models";
import { evidenceLines, patternSummary, type Pattern } from "../agent/patterns";
import { formatTime } from "../review/timeline";
import { DB_NAME } from "../store/db";
import { checksSummary, toolSummary } from "./chat-words";

/** Starting points shown before the first message: each fills the box, for the person to change before sending. */
const SUGGESTIONS = ["Make the rooms page friendlier to scan", "Add a way to cancel a held room", "Fix what the checks found"] as const;

/**
 * The agent chat, built from Todae's Conversation and Message with the
 * message-parts, tool-call, reasoning, message-actions and suggestions
 * recipes. The person's key is entered here and held by the app (see
 * KeyVault). Messages read as a conversation: each tool call is one short
 * line in plain words that opens to its tool, input and result; the checks
 * the app ran show their verdict the same way; thinking, tokens and cost sit
 * under each reply's details. Nothing here decides pass or fail.
 */
export function ChatPanel({
  controller,
  vault,
  settings,
  onSettings,
  onOpenProposal,
  onOpenVariants,
  prefill,
  onClose,
  suggestion,
  readOnly,
}: {
  readonly controller: AgentController;
  readonly vault: KeyVault;
  readonly settings: AgentSettings;
  readonly onSettings: (next: AgentSettings) => void;
  readonly onOpenProposal: (id: string) => void;
  /** Opens the Variants view, where the person compares and picks. */
  readonly onOpenVariants: () => void;
  /** A message put into the box for the person to edit and send, never sent on its own. */
  readonly prefill: { readonly text: string; readonly nonce: number } | null;
  /** Hides the chat panel. */
  readonly onClose?: () => void;
  /** Something that keeps coming up, offered quietly: accepting sends the agent the evidence; nothing happens unless the person presses. */
  readonly suggestion?: { readonly pattern: Pattern; readonly onAccept: () => void; readonly onDismiss: () => void };
  /** Why the agent cannot work on the open prototype (a TSX one is read-only): the box is disabled and this is said instead. */
  readonly readOnly?: string;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const key = useSyncExternalStore(vault.subscribe, vault.getState);
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const keyField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!prefill) return;
    setDraft(prefill.text);
    // Without a key the box is disabled, so the key comes first.
    (field.current && !field.current.disabled ? field.current : keyField.current)?.focus();
  }, [prefill]);
  const undoable = controller.undoable();
  const model = MODELS.find((item) => item.id === settings.model)?.name ?? settings.model;

  const send = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || state.running || !key.present || !state.loaded || readOnly !== undefined) return;
    setDraft("");
    void controller.send(text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) send(event as unknown as FormEvent);
  };
  const pick = (text: string) => {
    setDraft(text);
    field.current?.focus();
  };

  return (
    <aside className="chat" aria-label="Agent chat">
      <div className="panel-head chat-head">
        <Text.Root as="h2" className="panel-title">
          Agent
        </Text.Root>
        {state.running && <Loader.Root variant="dots" aria-label="The agent is working" className="chat-busy" />}
        {onClose && (
          <Button.Root variant="ghost" aria-label="Hide the chat" onClick={onClose} className="panel-close">
            <Button.Icon>
              <X />
            </Button.Icon>
          </Button.Root>
        )}
      </div>
      {key.present && (
        <Disclosure.Root className="chat-settings">
          <Disclosure.Summary>Settings and key</Disclosure.Summary>
          <Settings vault={vault} settings={settings} model={model} onSettings={onSettings} disabled={state.running} />
        </Disclosure.Root>
      )}

      {readOnly !== undefined && (
        <Alert.Root tone="info" className="chat-problem" data-testid="chat-read-only">
          <Alert.Description>{readOnly}</Alert.Description>
        </Alert.Root>
      )}
      {state.problem && (
        <Alert.Root tone="warning" className="chat-problem">
          <Alert.Description>{state.problem}</Alert.Description>
        </Alert.Root>
      )}

      <Conversation.Root className="chat-conversation">
        <Conversation.Viewport aria-label="Conversation with the agent" className="chat-viewport">
          <Conversation.Content className="chat-content">
            {!key.present ? (
              <KeyForm vault={vault} inputRef={keyField} />
            ) : (
              state.turns.length === 0 && (
                <div className="chat-empty">
                  <span className="chat-empty-icon" aria-hidden="true">
                    <Sparkles />
                  </span>
                  <Text.Root as="h3" className="chat-empty-title">
                    What should we make?
                  </Text.Root>
                  <Text.Root as="p" tone="muted" className="chat-hint">
                    Describe a change and the agent builds it on the canvas. It follows the project&apos;s rules, fixes what the checks find, and asks you with a proposal when it needs something new.
                  </Text.Root>
                  <Stack.Root as="ul" gap="condensed" className="chat-suggestions" aria-label="Suggestions">
                    {SUGGESTIONS.map((text) => (
                      <li key={text}>
                        <Button.Root variant="secondary" onClick={() => pick(text)}>
                          {text}
                        </Button.Root>
                      </li>
                    ))}
                  </Stack.Root>
                </div>
              )
            )}
            {state.turns.map((turn, index) => (
              <TurnView
                key={turn.id}
                turn={turn}
                onOpenProposal={onOpenProposal}
                onOpenVariants={onOpenVariants}
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

      {suggestion && key.present && readOnly === undefined && <LoopSuggestion {...suggestion} />}

      <form className="chat-composer" onSubmit={send}>
        <Field.Root aria-label="Message the agent" disabled={!key.present || readOnly !== undefined} className="chat-input">
          <Field.Textarea ref={field} value={draft} onValueChange={setDraft} onKeyDown={onKeyDown} rows={2} maxRows={8} autoGrow placeholder={readOnly !== undefined ? "This prototype is read-only" : key.present ? "Describe a change…" : "Add your API key above to start"} />
          <Field.Row className="chat-composer-row">
            <Text.Root as="span" tone="muted" className="chat-composer-hint">
              {key.present ? `${model} · Enter to send` : ""}
            </Text.Root>
            {state.running ? (
              <Button.Root type="button" variant="secondary" onClick={() => controller.stop()}>
                <Button.Icon>
                  <Square />
                </Button.Icon>
                Stop
              </Button.Root>
            ) : (
              <Button.Root type="submit" variant="primary" aria-label="Send" disabled={!key.present || readOnly !== undefined || draft.trim() === ""}>
                <Button.Icon>
                  <ArrowUp />
                </Button.Icon>
              </Button.Root>
            )}
          </Field.Row>
        </Field.Root>
      </form>
    </aside>
  );
}

/** The loop's quiet suggestion: what keeps coming up, its evidence one click away, and the person's two answers. */
function LoopSuggestion({ pattern, onAccept, onDismiss }: { readonly pattern: Pattern; readonly onAccept: () => void; readonly onDismiss: () => void }) {
  return (
    <section className="chat-proposal chat-pattern" data-tone="info" data-testid="loop-suggestion" data-pattern={pattern.key} aria-label="Suggestion" aria-live="polite">
      <Stack.Root gap="condensed">
        <Stack.Root direction="row" align="center" gap="condensed">
          <span className="chat-step-icon" aria-hidden="true">
            <Lightbulb />
          </span>
          <Text.Root as="p" weight="medium" className="chat-proposal-title">
            This keeps coming up. Ask the agent to propose a rule?
          </Text.Root>
        </Stack.Root>
        <Text.Root as="p" tone="muted" className="chat-small" data-testid="loop-summary">
          {patternSummary(pattern)}
        </Text.Root>
        <Disclosure.Root className="chat-pattern-evidence">
          <Disclosure.Summary>The evidence</Disclosure.Summary>
          <ul className="chat-small chat-pattern-list" data-testid="loop-evidence">
            {evidenceLines(pattern, formatTime).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Disclosure.Root>
        <Stack.Root direction="row" gap="condensed" wrap>
          <Button.Root type="button" variant="secondary" onClick={onAccept}>
            Ask the agent to propose a rule
          </Button.Root>
          <Button.Root type="button" variant="ghost" onClick={onDismiss}>
            Not now
          </Button.Root>
        </Stack.Root>
      </Stack.Root>
    </section>
  );
}

function KeyForm({ vault, inputRef }: { readonly vault: KeyVault; readonly inputRef: Ref<HTMLInputElement> }) {
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
    <form className="chat-key" onSubmit={(event) => void submit(event)} aria-labelledby="agent-key-title">
      <Stack.Root gap="normal">
        <span className="chat-empty-icon" aria-hidden="true">
          <KeyRound />
        </span>
        <Stack.Root gap="condensed">
          <Text.Root as="h3" id="agent-key-title" className="chat-empty-title">
            Connect the agent
          </Text.Root>
          <Text.Root as="p" tone="muted">
            The agent runs on your own Anthropic account. Paste an API key to start designing with it.
          </Text.Root>
        </Stack.Root>
        <Stack.Root gap="condensed">
          <Label.Root htmlFor="agent-key">Your Anthropic API key</Label.Root>
          <Field.Root id="agent-key" invalid={problem !== null} {...(problem ? { "aria-describedby": "agent-key-problem" } : {})}>
            <Field.TextInput ref={inputRef} type="password" value={value} onValueChange={setValue} autoComplete="off" spellCheck={false} placeholder="sk-ant-…" />
          </Field.Root>
          {problem && (
            <ErrorMessage.Root id="agent-key-problem" role="alert">
              {problem}
            </ErrorMessage.Root>
          )}
          <Checkbox.Root checked={remember} onCheckedChange={setRemember}>
            Remember on this device
          </Checkbox.Root>
        </Stack.Root>
        <Button.Root type="submit" variant="primary">
          Use this key
        </Button.Root>
        <Disclosure.Root className="chat-key-privacy">
          <Disclosure.Summary>How your key is kept</Disclosure.Summary>
          <Text.Root as="p" tone="muted" className="chat-small">
            Kept in this tab&apos;s memory and sent only to api.anthropic.com. Remember also stores it in this browser&apos;s IndexedDB on this device, until you forget it. It never goes into a prototype, an export or a frame.
          </Text.Root>
        </Disclosure.Root>
      </Stack.Root>
    </form>
  );
}

function Settings({ vault, settings, model, onSettings, disabled }: { readonly vault: KeyVault; readonly settings: AgentSettings; readonly model: string; readonly onSettings: (next: AgentSettings) => void; readonly disabled: boolean }) {
  const key = useSyncExternalStore(vault.subscribe, vault.getState);
  return (
    <Stack.Root gap="condensed" className="chat-settings-body">
      <Text.Root as="p" tone="muted" className="chat-small">
        {model}, {settings.effort} effort
      </Text.Root>
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
        This prototype&apos;s chat is stored in IndexedDB database &quot;{DB_NAME}&quot;, store &quot;chats&quot;, without the key. Model and effort are in localStorage.
      </Text.Root>
      <div>
        <Button.Root type="button" variant="secondary" onClick={() => void vault.forget()} disabled={disabled}>
          Forget the key
        </Button.Root>
      </div>
    </Stack.Root>
  );
}

function usageText(turn: Turn): string {
  const { usage } = turn;
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  const cached = usage.cacheRead > 0 ? `, ${usage.cacheRead.toLocaleString()} from cache` : "";
  return `${input.toLocaleString()} in${cached} · ${usage.output.toLocaleString()} out · about ${formatCost(turn.cost)}`;
}

function TurnView({ turn, running, canUndo, onUndo, onRetry, onOpenProposal, onOpenVariants }: { readonly turn: Turn; readonly running: boolean; readonly canUndo: boolean; readonly onUndo: () => void; readonly onRetry: () => void; readonly onOpenProposal: (id: string) => void; readonly onOpenVariants: () => void }) {
  const thinking = turn.items.filter((item): item is Extract<TurnItem, { kind: "thinking" }> => item.kind === "thinking" && item.text !== "");
  return (
    <>
      <Message.Root from="user" data-turn={turn.id} aria-label="You">
        <Message.Content>
          <Text.Root as="p" className="pre">
            {turn.text}
          </Text.Root>
        </Message.Content>
      </Message.Root>
      <Message.Root streaming={running} data-turn={turn.id} data-end={turn.end.status} className="chat-reply" aria-label="Agent">
        {turn.items.map((item, index) => (
          <Item key={index} item={item} onOpenProposal={onOpenProposal} onOpenVariants={onOpenVariants} />
        ))}
        {running && turn.items.every((item) => item.kind === "thinking") && (
          <Stack.Root direction="row" align="center" gap="condensed" className="chat-thinking-now">
            <Loader.Root variant="dots" aria-hidden="true" />
            <Text.Root as="span" tone="muted">
              Thinking
            </Text.Root>
          </Stack.Root>
        )}
        <End turn={turn} onRetry={onRetry} />
        {turn.end.status !== "running" && (
          <Message.Actions className="chat-actions">
            {turn.before !== null &&
              (turn.undone ? (
                <Badge.Root tone="neutral">Undone</Badge.Root>
              ) : canUndo ? (
                <Button.Root type="button" variant="ghost" onClick={onUndo}>
                  Undo this turn
                </Button.Root>
              ) : null)}
            <Disclosure.Root className="chat-turn-details">
              <Disclosure.Summary>Details</Disclosure.Summary>
              <Stack.Root gap="condensed">
                <Text.Root as="p" tone="muted" className="chat-small" data-testid="turn-usage">
                  {usageText(turn)}
                </Text.Root>
                {thinking.map((item, index) => (
                  <Stack.Root key={index} gap="none" className="chat-thinking">
                    <Text.Root as="span" variant="label">
                      Thinking
                    </Text.Root>
                    <Text.Root as="p" tone="muted" className="pre chat-small">
                      {item.text}
                    </Text.Root>
                  </Stack.Root>
                ))}
              </Stack.Root>
            </Disclosure.Root>
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
        <Text.Root as="p" tone="muted" className="chat-small chat-end">
          Stopped.
        </Text.Root>
      );
    default:
      return null;
  }
}

/** A step's icon: a quiet mark of how it went. */
function StepIcon({ status }: { readonly status: "working" | "done" | "fixing" | "problem" }) {
  return (
    <span className="chat-step-icon" data-status={status} aria-hidden="true">
      {status === "working" ? <Loader.Root variant="dots" aria-hidden="true" /> : status === "done" ? <Check /> : status === "fixing" ? <CircleAlert /> : <TriangleAlert />}
    </span>
  );
}

/** A tool call or a check as one line that opens to what ran: the tool-call recipe, with a plain summary in front. */
function Step({ className, icon, summary, children, ...data }: { readonly className: string; readonly icon: ReactNode; readonly summary: ReactNode; readonly children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <Disclosure.Root className={`chat-step ${className}`} {...data}>
      <Disclosure.Summary>
        <span className="chat-step-head">
          {icon}
          {summary}
        </span>
      </Disclosure.Summary>
      <div className="chat-step-body">{children}</div>
    </Disclosure.Root>
  );
}

function Item({ item, onOpenProposal, onOpenVariants }: { readonly item: TurnItem; readonly onOpenProposal: (id: string) => void; readonly onOpenVariants: () => void }) {
  switch (item.kind) {
    case "text":
      return item.text ? (
        <Message.Content>
          <Text.Root as="p" className="pre chat-text">
            {item.text}
          </Text.Root>
        </Message.Content>
      ) : null;
    case "thinking":
      // Thinking sits in the reply's details, after it ends.
      return null;
    case "tool": {
      const working = item.status === "streaming" || item.status === "running";
      return (
        <Step className="chat-tool" data-tool={item.name} data-status={item.status} icon={<StepIcon status={working ? "working" : item.status === "error" ? "problem" : "done"} />} summary={<span className="chat-tool-title">{toolSummary(item)}</span>}>
          <DataList.Root orientation="vertical" className="chat-step-data">
            <DataList.Item>
              <DataList.Term>Tool</DataList.Term>
              <DataList.Details>
                <Code.Root>{item.name}</Code.Root> <span className="chat-tool-name">{item.status === "streaming" ? `${item.title} (${item.input.length} characters)` : item.title}</span>
              </DataList.Details>
            </DataList.Item>
            <DataList.Item>
              <DataList.Term>Input</DataList.Term>
              <DataList.Details>
                <CodeBlock.Root className="chat-pre" tabIndex={0} role="region" aria-label={`${item.name} input`}>
                  {item.input || "{}"}
                </CodeBlock.Root>
              </DataList.Details>
            </DataList.Item>
            {item.result !== undefined && (
              <DataList.Item>
                <DataList.Term>Result</DataList.Term>
                <DataList.Details>
                  <CodeBlock.Root className="chat-pre" tabIndex={0} role="region" aria-label={`${item.name} result`}>
                    {item.result}
                  </CodeBlock.Root>
                </DataList.Details>
              </DataList.Item>
            )}
          </DataList.Root>
        </Step>
      );
    }
    case "checks":
      return (
        <Step className="chat-checks" data-status={item.status} icon={<StepIcon status={item.status === "pass" ? "done" : item.status === "fail" ? "fixing" : "problem"} />} summary={<span className="chat-tool-title">{checksSummary(item)}</span>}>
          <Text.Root as="p" tone="muted" className="chat-small">
            {item.title}, revision {item.revision}
          </Text.Root>
          <CodeBlock.Root className="chat-pre" tabIndex={0} role="region" aria-label={`Checks for revision ${item.revision}`}>
            {item.text}
          </CodeBlock.Root>
        </Step>
      );
    case "proposal":
      return (
        <div className="chat-proposal" data-proposal={item.id} data-action={item.action ?? "drafted"} data-request={item.request ? "" : undefined} data-tone={item.adoptable || item.needsMeasurement || item.request ? "info" : "warning"}>
          <Stack.Root gap="condensed">
            <Stack.Root direction="row" align="center" gap="condensed" wrap>
              <span className="chat-step-icon" aria-hidden="true">
                {item.request ? <FileCode2 /> : <Pencil />}
              </span>
              <Text.Root as="span" variant="label">
                {item.request ? `Request for a new rule type ${item.action ?? "drafted"}` : `Proposal ${item.action ?? "drafted"}`}
              </Text.Root>
            </Stack.Root>
            <Text.Root as="p" weight="medium" className="chat-proposal-title">
              {item.title}
            </Text.Root>
            <Text.Root as="p" tone="muted" className="chat-small">
              {item.request ? "Needs a new rule type: this is a code change. Its review page copies a request ready to file; it never becomes a check here." : `${item.verdict} Only you can approve, decline or adopt it.`}
            </Text.Root>
            <div>
              <Button.Root type="button" variant="secondary" onClick={() => onOpenProposal(item.id)}>
                <Button.Icon>
                  <CircleCheck />
                </Button.Icon>
                {item.request ? "Review the request" : "Review the proposal"}
              </Button.Root>
            </div>
          </Stack.Root>
        </div>
      );
    case "variants":
      return (
        <div className="chat-proposal chat-variants" data-variants={item.ids.join(" ")} data-tone="info">
          <Stack.Root gap="condensed">
            <Stack.Root direction="row" align="center" gap="condensed" wrap>
              <span className="chat-step-icon" aria-hidden="true">
                <Columns2 />
              </span>
              <Text.Root as="span" variant="label">
                {item.action === "revised" ? "Variant revised" : `${item.ids.length} variants offered`}
              </Text.Root>
            </Stack.Root>
            <Text.Root as="p" weight="medium" className="chat-proposal-title">
              {`For the ${item.page} page: ${item.ids.map((id) => id.toUpperCase()).join(", ")}`}
            </Text.Root>
            <Text.Root as="p" tone="muted" className="chat-small">
              Kept beside the prototype, which is unchanged. Compare them with their checks and pick slot by slot; only you can apply a pick.
            </Text.Root>
            <div>
              <Button.Root type="button" variant="secondary" onClick={onOpenVariants}>
                Compare variants
              </Button.Root>
            </div>
          </Stack.Root>
        </div>
      );
    case "notice":
      return (
        <Text.Root as="p" tone="muted" className="chat-small chat-notice">
          {item.text}
        </Text.Root>
      );
  }
}
