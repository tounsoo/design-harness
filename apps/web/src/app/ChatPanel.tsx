import { Alert, Badge, Button, Checkbox, Code, CodeBlock, Conversation, DataList, Disclosure, ErrorMessage, Field, Label, Loader, Message, Stack, Text } from "@tounsoo/todae";
import { ArrowUp, BookOpen, Check, CircleAlert, CircleCheck, Columns2, FileCode2, KeyRound, Lightbulb, Pencil, Sparkles, Square, TriangleAlert, X } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import type { AgentController, Turn, TurnItem } from "../agent/controller";
import { KEY_DB, keyProblem, type KeyVault } from "../agent/key-vault";
import { EFFORTS, MODELS, formatCost, isEffort, isModel, type AgentSettings } from "../agent/models";
import { evidenceLines, patternSummary, type Pattern } from "../agent/patterns";
import { fetchedUrl, sourceSummary } from "../agent/source-words";
import { formatTime } from "../review/timeline";
import { DB_NAME } from "../store/db";
import { checksSummary, toolSummary } from "./chat-words";
import { DocsDialog, type DocsProps } from "./DocsSection";

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
  proposalWords,
  onOpenVariants,
  prefill,
  onClose,
  suggestion,
  readOnly,
  docs,
}: {
  readonly controller: AgentController;
  readonly vault: KeyVault;
  readonly settings: AgentSettings;
  readonly onSettings: (next: AgentSettings) => void;
  readonly onOpenProposal: (id: string) => void;
  /** A proposal as the person reads it now, by its id: what it changes in a sentence and where it stands. Undefined once it is gone. */
  readonly proposalWords?: ProposalWords;
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
  /** The project's docs, the same list the Project view shows: the chat counts them and opens them in a dialog. Without it the chat has no docs entry. */
  readonly docs?: (DocsProps & { readonly projectId: string }) | undefined;
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
  // The docs dialog, opened from the entry beside Settings, the empty chat's hint or a reply's docs line. Closing
  // it puts focus back on whatever opened it, or on the entry when that is gone (the hint leaves once docs exist).
  const [docsOpen, setDocsOpen] = useState(false);
  const docsEntry = useRef<HTMLButtonElement>(null);
  const docsOpener = useRef<HTMLElement | null>(null);
  const openDocs = (event: { readonly currentTarget: HTMLElement }) => {
    docsOpener.current = event.currentTarget;
    setDocsOpen(true);
  };
  const closeDocs = () => setDocsOpen(false);
  const docsWereOpen = useRef(false);
  useEffect(() => {
    if (docsWereOpen.current && !docsOpen) (docsOpener.current?.isConnected ? docsOpener.current : docsEntry.current)?.focus();
    docsWereOpen.current = docsOpen;
  }, [docsOpen]);
  const docsCount = docs?.sources.length ?? 0;
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
      {(key.present || docs) && (
        <div className="chat-tools">
          {key.present && (
            <Disclosure.Root className="chat-settings">
              <Disclosure.Summary>Settings and key</Disclosure.Summary>
              <Settings vault={vault} settings={settings} model={model} onSettings={onSettings} disabled={state.running} />
            </Disclosure.Root>
          )}
          {docs && (
            <Button.Root ref={docsEntry} type="button" variant="ghost" className="chat-docs-entry" data-testid="chat-docs-entry" data-count={docsCount} aria-haspopup="dialog" aria-label={docsCount === 0 ? "Add docs for the agent to read" : `Docs the agent reads, ${docsCount}`} tooltip={false} onClick={openDocs}>
              <Button.Icon>
                <BookOpen />
              </Button.Icon>
              {docsCount === 0 ? "Add docs" : `Docs (${docsCount})`}
            </Button.Root>
          )}
        </div>
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
                  {docs && docsCount === 0 && (
                    <p className="chat-small chat-docs-line chat-docs-hint" data-testid="chat-docs-hint">
                      <Text.Root as="span" tone="muted">
                        Using a design system?
                      </Text.Root>
                      <Button.Root type="button" variant="ghost" aria-haspopup="dialog" onClick={openDocs}>
                        Give the agent its docs
                      </Button.Root>
                    </p>
                  )}
                </div>
              )
            )}
            <DocsOpenContext.Provider value={docs ? openDocs : null}>
            <ProposalWordsContext.Provider value={proposalWords ?? noWords}>
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
            </ProposalWordsContext.Provider>
            </DocsOpenContext.Provider>
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
      {docs && docsOpen && <DocsDialog {...docs} onClose={closeDocs} />}
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
          <Item key={index} item={item} finished={turn.end.status !== "running"} onOpenProposal={onOpenProposal} onOpenVariants={onOpenVariants} />
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

/** A proposal by its id, as the person reads it: what it changes in one sentence, and where it stands when it no longer waits. */
export type ProposalWords = (id: string) => { readonly sentence: string; readonly standing?: string } | undefined;
const noWords: ProposalWords = () => undefined;
const ProposalWordsContext = createContext<ProposalWords>(noWords);
/** Opens the project's docs from a line in a reply; null when the chat has no docs entry. */
const DocsOpenContext = createContext<((event: { readonly currentTarget: HTMLElement }) => void) | null>(null);

/** The line that says which docs a message went with, and the way to them. */
function DocsNotice({ text }: { readonly text: string }) {
  const open = useContext(DocsOpenContext);
  return (
    <p className="chat-small chat-docs-line chat-docs-sent" data-testid="chat-docs-sent">
      <Text.Root as="span" tone="muted" className="chat-notice">
        {text}
      </Text.Root>
      {open && (
        <Button.Root type="button" variant="ghost" aria-haspopup="dialog" aria-label="See or change the docs the agent reads" tooltip={false} onClick={open}>
          See docs
        </Button.Root>
      )}
    </p>
  );
}

/**
 * A proposal the agent drafted or revised, as a card in the chat: its title,
 * what it changes in one plain sentence, and the way to its review page,
 * where the person decides. Core's dry run, word for word, is in the tool
 * call's details above the card and on the review page.
 */
function ProposalItem({ item, onOpenProposal }: { readonly item: Extract<TurnItem, { kind: "proposal" }>; readonly onOpenProposal: (id: string) => void }) {
  const words = useContext(ProposalWordsContext)(item.id);
  const revised = item.action === "revised";
  const notReady = !item.adoptable && !item.needsMeasurement && !item.request;
  return (
    <div className="chat-proposal" data-proposal={item.id} data-action={item.action ?? "drafted"} data-request={item.request ? "" : undefined} data-tone={notReady ? "warning" : "info"}>
      <Stack.Root gap="condensed">
        <Stack.Root direction="row" align="center" gap="condensed" wrap>
          <span className="chat-step-icon" aria-hidden="true">
            {item.request ? <FileCode2 /> : <Pencil />}
          </span>
          <Text.Root as="span" variant="label">
            {item.request ? (revised ? "Updated its request for a new kind of rule" : "Asked for a new kind of rule") : revised ? "Updated its suggestion" : "Suggested a change to the project"}
          </Text.Root>
        </Stack.Root>
        <Text.Root as="p" weight="medium" className="chat-proposal-title">
          {item.title}
        </Text.Root>
        {words && (
          <Text.Root as="p" className="chat-small" data-testid="chat-proposal-plain">
            {words.sentence}
          </Text.Root>
        )}
        {words?.standing ? (
          <Text.Root as="p" tone="muted" className="chat-small" data-testid="chat-proposal-standing">
            {words.standing}
          </Text.Root>
        ) : (
          notReady && (
            <Text.Root as="p" tone="muted" className="chat-small" data-testid="chat-proposal-not-ready">
              It isn&apos;t ready to accept yet. Its review page says why.
            </Text.Root>
          )
        )}
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
}

/**
 * The agent reading the project's docs: a page it fetched or a docs
 * server's tool it called, both run at Anthropic. One line in plain words,
 * opening to where it went, what it asked and the start of what came back.
 */
function SourceStep({ item, finished }: { readonly item: Extract<TurnItem, { kind: "source" }>; readonly finished: boolean }) {
  const unanswered = item.status === "running" && finished;
  const status = item.status === "running" ? (finished ? "problem" : "working") : item.status === "error" ? "problem" : "done";
  const url = item.via === "web" ? fetchedUrl(item) : null;
  return (
    <Step className="chat-source" data-source={item.via} data-status={unanswered ? "unanswered" : item.status} icon={<StepIcon status={status} />} summary={<span className="chat-tool-title">{sourceSummary(item, finished)}</span>}>
      <DataList.Root orientation="vertical" className="chat-step-data">
        <DataList.Item>
          <DataList.Term>{item.via === "web" ? "Read by" : "Docs server"}</DataList.Term>
          <DataList.Details>
            {item.via === "web" ? (
              "Anthropic's web fetch tool, for the agent"
            ) : (
              <>
                <Code.Root>{item.server ?? ""}</Code.Root> <span className="chat-tool-name">through Anthropic&apos;s MCP connector, tool {item.name}</span>
              </>
            )}
          </DataList.Details>
        </DataList.Item>
        {url && (
          <DataList.Item>
            <DataList.Term>Address</DataList.Term>
            <DataList.Details className="chat-source-url">{url}</DataList.Details>
          </DataList.Item>
        )}
        {item.via === "mcp" && (
          <DataList.Item>
            <DataList.Term>Input</DataList.Term>
            <DataList.Details>
              <CodeBlock.Root className="chat-pre" tabIndex={0} role="region" aria-label={`${item.name} input`}>
                {item.input || "{}"}
              </CodeBlock.Root>
            </DataList.Details>
          </DataList.Item>
        )}
        {(item.problem || unanswered) && (
          <DataList.Item>
            <DataList.Term>What went wrong</DataList.Term>
            <DataList.Details data-testid="source-problem">{item.problem ?? "No answer came back before the turn ended."}</DataList.Details>
          </DataList.Item>
        )}
        {item.result !== undefined && item.result !== "" && (
          <DataList.Item>
            <DataList.Term>{item.via === "web" ? "The page begins" : "The answer begins"}</DataList.Term>
            <DataList.Details>
              <CodeBlock.Root className="chat-pre" tabIndex={0} role="region" aria-label={item.via === "web" ? "The page" : `${item.name} answer`}>
                {item.result}
              </CodeBlock.Root>
            </DataList.Details>
          </DataList.Item>
        )}
      </DataList.Root>
    </Step>
  );
}

function Item({ item, finished, onOpenProposal, onOpenVariants }: { readonly item: TurnItem; readonly finished: boolean; readonly onOpenProposal: (id: string) => void; readonly onOpenVariants: () => void }) {
  switch (item.kind) {
    case "source":
      return <SourceStep item={item} finished={finished} />;
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
      return <ProposalItem item={item} onOpenProposal={onOpenProposal} />;
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
      if (item.about === "docs") return <DocsNotice text={item.text} />;
      return (
        <Text.Root as="p" tone="muted" className="chat-small chat-notice">
          {item.text}
        </Text.Root>
      );
  }
}
