import { Badge, Button, Disclosure, Field, Popover, Stack, Text, usePopover } from "@tounsoo/todae";
import { Check, CircleHelp, MessageSquareText } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import type { FrameKey, FrameSpec, Session } from "../runtime/session";
import { anchorAt, anchorOn, elementChoices, intoView, toOverlay, toPage, type FrameMeasure } from "./anchor";
import { pinElementWords } from "./describe";
import { MAX_NOTE_LENGTH, type Pin, type PinAnchor, type PinState, type PinStatus } from "./model";

/**
 * Pinned notes over one artboard, drawn by the app and outside the frame,
 * like a lens (`visual/LensLayer.tsx`): the frame's document, its sandbox
 * and what it measures are untouched. A pin sits at its point of the page,
 * mapped through the artboard's zoom and the frame's scroll, on a live frame
 * and on a parked one alike, since everything it needs is in what the frame
 * measured. In "Pin a note" mode a surface over the artboard takes the
 * click; a frame's head offers the same from a list of its elements, for a
 * keyboard. Nothing here scrolls the board: only the app's camera does.
 */

/** A note being written, before it is a pin. `list`: it was started from the frame's list of elements. */
export type PinDraft = { readonly frame: FrameKey; readonly anchor: PinAnchor; readonly list: boolean };

export type PinActions = {
  /** Keeps a new note; returns its number, or null with nothing kept. */
  readonly create: (anchor: PinAnchor, note: string) => number | null;
  readonly edit: (number: number, note: string) => void;
  readonly close: (number: number) => void;
  readonly reopen: (number: number) => void;
};

/** What the board gives every artboard's pin layer. Absent (null) where frames carry no pins, such as a proposal's examples. */
export type PinBoard = {
  readonly state: PinState;
  readonly pinning: boolean;
  readonly actions: PinActions;
  /** The open prototype's revision (`fingerprint`) and what its element tags are. */
  readonly revision: string;
  readonly kind: "source" | "key";
  /** The pin whose card is open, and the note being written. */
  readonly open: number | null;
  readonly setOpen: (number: number | null) => void;
  readonly draft: PinDraft | null;
  readonly setDraft: (draft: PinDraft | null) => void;
  /** The pin whose marker takes focus once it is drawn: one just made. */
  readonly focus: number | null;
  readonly focused: () => void;
};

export const PinContext = createContext<PinBoard | null>(null);

export const STATUS_WORDS: Readonly<Record<PinStatus, string>> = { open: "Open", addressed: "Addressed by the agent", closed: "Closed" };

/** A pin's number in its marker's colours, for a card or a list: not a control. */
export function NoteMark({ pin }: { readonly pin: Pick<Pin, "number" | "status"> & { readonly anchor?: { readonly lost?: true } } }) {
  return (
    <span className="note-mark" data-status={pin.status} data-lost={pin.anchor?.lost ? "" : undefined} aria-hidden="true">
      {pin.number}
    </span>
  );
}

export function NoteStatus({ status }: { readonly status: PinStatus }) {
  return (
    <Badge.Root tone={status === "addressed" ? "info" : "neutral"} className="note-status" data-status={status} data-testid="note-status">
      {status === "addressed" && <Check aria-hidden="true" />}
      {STATUS_WORDS[status]}
    </Badge.Root>
  );
}

/** What a lost pin says, the same words on its card and in the list. */
export const LOST_WORDS = "Moved or gone: what this note was pinned to is no longer on this page. It stays where it last was.";

/** The measurement of one frame the pins read, or null until it is measured. */
export function useMeasure(spec: FrameSpec, frameState: { readonly state: string; readonly snapshot?: FrameMeasure["snapshot"]; readonly places?: FrameMeasure["places"] }): FrameMeasure | null {
  const { snapshot, places } = frameState;
  return useMemo(() => (frameState.state === "measured" && snapshot ? { snapshot, places: places ?? [], width: spec.view.width, height: spec.view.height } : null), [frameState.state, snapshot, places, spec.view.width, spec.view.height]);
}

export function PinLayer({ session, spec, scale, measure, name }: { readonly session: Session; readonly spec: FrameSpec; readonly scale: number; readonly measure: FrameMeasure | null; /** The frame's name in words. */ readonly name: string }) {
  const board = useContext(PinContext);
  const scroll = useSyncExternalStore(session.subscribeScroll, () => session.scrollOf(spec.key));
  if (!board) return null;
  const mine = board.state.pins.filter((pin) => pin.anchor.scenario === spec.scenario.id && pin.anchor.view === spec.view.name);
  const draft = board.draft?.frame === spec.key ? board.draft : null;
  if (!board.pinning && mine.length === 0 && !draft) return null;
  const { width, height, scheme } = spec.view;
  const place = (anchor: PinAnchor) => intoView(toOverlay(anchor.point, scale, scroll), spec.view, scale);
  const capture = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const point = toPage({ x: event.clientX - box.left, y: event.clientY - box.top }, scale, scroll);
    board.setOpen(null);
    board.setDraft({ frame: spec.key, anchor: anchorAt(measure, { scenario: spec.scenario.id, view: spec.view.name }, point, board.revision, board.kind), list: false });
  };
  return (
    <div className="pin-layer" data-scheme={scheme} data-pinning={board.pinning ? "" : undefined} style={{ width: width * scale, height: height * scale }} data-testid="pin-layer">
      {/* The click is taken here, by the app: the frame under it never hears it. Not a control: a keyboard pins from the frame's list instead. */}
      {board.pinning && measure && <div className="pin-capture" onClick={capture} data-testid="pin-capture" />}
      {mine.map((pin) => {
        const at = place(pin.anchor);
        return (
          <Marker
            key={pin.number}
            at={at}
            number={pin.number}
            status={pin.status}
            lost={pin.anchor.lost === true}
            label={`Your note ${pin.number}, ${STATUS_WORDS[pin.status].toLowerCase()}${pin.anchor.lost ? ", moved or gone" : ""}: ${short(pin.note)}. On ${name}`}
            title={`Your note ${pin.number}`}
            open={board.open === pin.number}
            onOpenChange={(next) => board.setOpen(next ? pin.number : board.open === pin.number ? null : board.open)}
            focus={board.focus === pin.number}
            onFocused={board.focused}
          >
            <PinCard pin={pin} frame={name} actions={board.actions} onDone={() => board.setOpen(null)} />
          </Marker>
        );
      })}
      {draft && (
        <Marker at={place(draft.anchor)} number={board.state.next} status="open" lost={false} draft label={`A new note on ${name}`} title="A new note" open onOpenChange={(next) => !next && board.setDraft(null)} focus={false} onFocused={board.focused}>
          <DraftCard
            draft={draft}
            measure={measure}
            frame={name}
            onMove={(index) => {
              const anchor = measure ? anchorOn(measure, { scenario: spec.scenario.id, view: spec.view.name }, index, board.revision, board.kind) : null;
              if (anchor) board.setDraft({ ...draft, anchor });
            }}
            onCancel={() => board.setDraft(null)}
            onSave={(note) => {
              const number = board.actions.create(draft.anchor, note);
              if (number !== null) board.setDraft(null);
              return number !== null;
            }}
          />
        </Marker>
      )}
    </div>
  );
}

const short = (text: string) => (text.length > 80 ? `${text.slice(0, 77)}...` : text);

/** One pin on the artboard: a numbered button at its point, and its card in a popover beside it. */
function Marker({
  at,
  number,
  status,
  lost,
  draft,
  label,
  title,
  open,
  onOpenChange,
  focus,
  onFocused,
  children,
}: {
  readonly at: { readonly x: number; readonly y: number; readonly off: boolean };
  readonly number: number;
  readonly status: PinStatus;
  readonly lost: boolean;
  readonly draft?: boolean;
  readonly label: string;
  readonly title: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly focus: boolean;
  readonly onFocused: () => void;
  readonly children: ReactNode;
}) {
  const button = useRef<HTMLButtonElement | null>(null);
  const popover = usePopover({ open, onOpenChange: (next) => onOpenChange(next) });
  useEffect(() => {
    if (!focus) return;
    // Never a scroll: only the app's camera moves the board.
    button.current?.focus({ preventScroll: true });
    onFocused();
  }, [focus, onFocused]);
  return (
    <>
      <button
        type="button"
        className="pin"
        data-status={status}
        data-lost={lost ? "" : undefined}
        data-off={at.off ? "" : undefined}
        data-draft={draft ? "" : undefined}
        data-pin={draft ? "draft" : number}
        data-testid="pin"
        aria-label={label}
        {...popover.getTriggerProps({ ref: button, style: { insetInlineStart: at.x, insetBlockStart: at.y } })}
      >
        <span className="pin-dot" aria-hidden="true">
          {number}
          {(lost || status === "addressed") && <span className="pin-badge">{lost ? <CircleHelp /> : <Check />}</span>}
        </span>
      </button>
      <Popover.Root {...popover.getPopoverProps()} role="dialog" aria-label={title} className="pin-card" data-testid="pin-card">
        {open && children}
      </Popover.Root>
    </>
  );
}

/** Where a note is, for its card: the element, then the frame. */
function OnLine({ anchor, frame }: { readonly anchor: PinAnchor; readonly frame: string }) {
  const element = pinElementWords(anchor);
  return (
    <Text.Root as="p" tone="muted" className="pin-card-on" data-testid="pin-on">
      {element ? `On ${element}` : "On the page"} · {frame}
    </Text.Root>
  );
}

function NoteField({ value, onChange, label, onSubmit }: { readonly value: string; readonly onChange: (next: string) => void; readonly label: string; readonly onSubmit: () => void }) {
  return (
    <Field.Root aria-label={label} className="pin-card-field">
      <Field.Textarea
        value={value}
        onValueChange={onChange}
        rows={3}
        maxRows={8}
        autoGrow
        maxLength={MAX_NOTE_LENGTH}
        placeholder="What should change here?"
        data-testid="pin-text"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
    </Field.Root>
  );
}

/** A new note: where it goes (picked from the frame's elements, when it was started from the list) and its words. */
function DraftCard({ draft, measure, frame, onMove, onCancel, onSave }: { readonly draft: PinDraft; readonly measure: FrameMeasure | null; readonly frame: string; readonly onMove: (index: number) => void; readonly onCancel: () => void; readonly onSave: (note: string) => boolean }) {
  const [note, setNote] = useState("");
  const choices = useMemo(() => (draft.list && measure ? elementChoices(measure) : []), [draft.list, measure]);
  const [choice, setChoice] = useState(() => String(choices[0]?.index ?? ""));
  const save = () => {
    if (note.trim() !== "") onSave(note);
  };
  return (
    <Stack.Root gap="condensed" className="pin-card-body">
      <div className="pin-card-head">
        <span className="pin-card-glyph" aria-hidden="true">
          <MessageSquareText />
        </span>
        <Text.Root as="h3" weight="medium" className="pin-card-title">
          New note
        </Text.Root>
      </div>
      {draft.list && choices.length > 0 && (
        <Field.Root aria-label={`Element of ${frame} to pin the note to`} className="pin-card-field">
          <Field.Select
            value={choice}
            onValueChange={(value) => {
              setChoice(value);
              onMove(Number(value));
            }}
            data-testid="pin-element"
          >
            {choices.map((item) => (
              <option key={item.index} value={String(item.index)}>
                {item.label}
              </option>
            ))}
          </Field.Select>
        </Field.Root>
      )}
      <OnLine anchor={draft.anchor} frame={frame} />
      <NoteField value={note} onChange={setNote} label="Your note" onSubmit={save} />
      <Stack.Root direction="row" gap="condensed" className="pin-card-actions">
        <Button.Root variant="primary" onClick={save} disabled={note.trim() === ""} data-testid="pin-save">
          Pin note
        </Button.Root>
        <Button.Root variant="ghost" onClick={onCancel}>
          Cancel
        </Button.Root>
      </Stack.Root>
    </Stack.Root>
  );
}

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
function when(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : WHEN.format(date);
}

/** What happened to a pin, oldest first, in words. */
export function PinHistory({ pin }: { readonly pin: Pin }) {
  return (
    <Disclosure.Root className="pin-history" data-testid="pin-history">
      <Disclosure.Summary>{`History: ${pin.history.length} ${pin.history.length === 1 ? "entry" : "entries"}`}</Disclosure.Summary>
      <ol className="pin-history-list">
        {pin.history.map((event, index) => (
          <li key={index}>
            <Text.Root as="span" tone="muted">
              {when(event.at)} ·{" "}
            </Text.Root>
            {event.kind === "created" ? `You wrote: ${event.note}` : event.kind === "edited" ? `You changed it to: ${event.note}` : event.kind === "addressed" ? `The agent replied: ${event.reply}` : event.kind === "closed" ? "You closed it" : "You reopened it"}
          </li>
        ))}
      </ol>
    </Disclosure.Root>
  );
}

/** A pin's card: its words, its state, the agent's reply, and what the person can do: edit, close, reopen. */
function PinCard({ pin, frame, actions, onDone }: { readonly pin: Pin; readonly frame: string; readonly actions: PinActions; readonly onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(pin.note);
  const save = () => {
    if (text.trim() === "") return;
    actions.edit(pin.number, text);
    setEditing(false);
  };
  return (
    <Stack.Root gap="condensed" className="pin-card-body" data-pin={pin.number} data-status={pin.status}>
      <div className="pin-card-head">
        <NoteMark pin={pin} />
        <Text.Root as="h3" weight="medium" className="pin-card-title">
          Your note
        </Text.Root>
        <NoteStatus status={pin.status} />
      </div>
      <OnLine anchor={pin.anchor} frame={frame} />
      {pin.anchor.lost && (
        <Text.Root as="p" className="pin-lost" data-testid="pin-lost">
          <CircleHelp aria-hidden="true" />
          <span>{LOST_WORDS}</span>
        </Text.Root>
      )}
      {editing ? (
        <>
          <NoteField value={text} onChange={setText} label={`Your note ${pin.number}`} onSubmit={save} />
          <Stack.Root direction="row" gap="condensed" className="pin-card-actions">
            <Button.Root variant="primary" onClick={save} disabled={text.trim() === ""} data-testid="pin-save">
              Save
            </Button.Root>
            <Button.Root
              variant="ghost"
              onClick={() => {
                setText(pin.note);
                setEditing(false);
              }}
            >
              Cancel
            </Button.Root>
          </Stack.Root>
        </>
      ) : (
        <>
          <Text.Root as="p" className="pin-note" data-testid="pin-note">
            {pin.note}
          </Text.Root>
          {pin.reply !== undefined && pin.status !== "open" && (
            <div className="pin-reply" data-testid="pin-reply">
              <Text.Root as="span" variant="label" tone="muted">
                The agent replied
              </Text.Root>
              <Text.Root as="p">{pin.reply}</Text.Root>
            </div>
          )}
          <Stack.Root direction="row" gap="condensed" wrap className="pin-card-actions">
            {pin.status !== "closed" && (
              <Button.Root
                variant="secondary"
                onClick={() => {
                  actions.close(pin.number);
                  onDone();
                }}
                data-testid="pin-close"
              >
                Close note
              </Button.Root>
            )}
            {pin.status !== "open" && (
              <Button.Root variant={pin.status === "closed" ? "secondary" : "ghost"} onClick={() => actions.reopen(pin.number)} data-testid="pin-reopen">
                Reopen
              </Button.Root>
            )}
            {pin.status !== "closed" && (
              <Button.Root variant="ghost" onClick={() => setEditing(true)} data-testid="pin-edit">
                Edit
              </Button.Root>
            )}
          </Stack.Root>
          <PinHistory pin={pin} />
        </>
      )}
    </Stack.Root>
  );
}
