import { Badge, Button, Disclosure, Field, Menu, Popover, Stack, Text, useHotkey, usePopover } from "@tounsoo/todae";
import { Check, CircleHelp, Layers, MessageSquareText } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode, type RefObject } from "react";
import { variantLabel } from "@design-harness/core";
import type { FrameKey, FrameSpec, Session } from "../runtime/session";
import { SHORTCUTS } from "../app/shortcuts";
import { anchorAt, anchorOn, elementChoices, intoView, onSurface, spots, toOverlay, toPage, type FrameMeasure } from "./anchor";
import { pinElementWords } from "./describe";
import { MAX_NOTE_LENGTH, type Pin, type PinAnchor, type PinEvent, type PinState, type PinStatus } from "./model";

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

/**
 * What a view of frames gives every artboard's pin layer: the board, or the
 * Variants view. Absent (null) where frames carry no pins: a proposal's
 * examples, and the combination being picked in the Variants view.
 */
export type PinBoard = {
  readonly state: PinState;
  readonly pinning: boolean;
  readonly actions: PinActions;
  /** The revision (`fingerprint`) of what these frames draw, and what its element tags are. */
  readonly revision: string;
  readonly kind: "source" | "key";
  /** The variant these frames draw, for the Variants view's variants; absent for the prototype's own frames. */
  readonly variant?: string;
  /** The spot whose list of notes is open: several notes pinned on one spot are picked from it. */
  readonly picking: string | null;
  readonly setPicking: (spot: string | null) => void;
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

/** The open prototype's pinned notes, and "Pin a note" mode, which the workspace owns: what the board and the Variants view are given. */
export type BoardPins = {
  readonly state: PinState;
  readonly pinning: boolean;
  readonly onPinning: (next: boolean) => void;
  readonly actions: PinActions;
  /** The open prototype's id: another prototype's notes are other notes. */
  readonly prototype: string;
  /** The open prototype's revision, and what its element tags are (`pins/anchor.ts`). */
  readonly revision: string;
  readonly kind: "source" | "key";
  /** Says whether Escape is the view's now: pin mode is on, a note's card is open, or a spot's list is. */
  readonly onHold?: (held: boolean) => void;
};

/** An artboard's card, found by its frame and the surface it is on, inside one view. */
export function cardOf(root: HTMLElement | null, frame: FrameKey, variant: string | undefined): HTMLElement | undefined {
  return [...(root?.querySelectorAll<HTMLElement>(".frame-card") ?? [])].find((card) => card.dataset.frameKey === frame && (card.dataset.variant ?? null) === (variant ?? null));
}

/**
 * The pin state one view of frames keeps: which note's card is open, the
 * note being written, the spot being picked from, and Escape, which leaves
 * pin mode once none of those is open. `root` is the view's element, where
 * a frame's list button is found again to give focus back, never with a
 * scroll.
 */
export function usePinBoard(pins: BoardPins | undefined, root: RefObject<HTMLElement | null>, /** Whether the view is the one on top: only that one answers Escape. */ shown = true) {
  const [open, setOpen] = useState<number | null>(null);
  const [draft, setDraftState] = useState<PinDraft | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const pinning = pins?.pinning ?? false;
  /** The note being written was just pinned: focus goes to its pin, not back to the list's button. */
  const pinned = useRef(false);
  const setDraft = useCallback(
    (next: PinDraft | null) => {
      setDraftState((before) => {
        // A note started from a frame's list and put down gives focus back to that list's button, without a scroll.
        if (next === null && before?.list && !pinned.current) requestAnimationFrame(() => cardOf(root.current, before.frame, before.anchor.variant)?.querySelector<HTMLElement>(".frame-pin")?.focus({ preventScroll: true }));
        pinned.current = false;
        return next;
      });
    },
    [root],
  );
  const given = pins?.actions;
  const actions = useMemo(
    (): PinActions | null =>
      given
        ? {
            ...given,
            create: (anchor, note) => {
              const number = given.create(anchor, note);
              if (number !== null) {
                pinned.current = true;
                setFocus(number);
              }
              return number;
            },
          }
        : null,
    [given],
  );
  const focused = useCallback(() => setFocus(null), []);
  const context = useMemo(
    (): PinBoard | null => (pins && actions ? { state: pins.state, pinning: pins.pinning, actions, revision: pins.revision, kind: pins.kind, picking, setPicking, open, setOpen, draft, setDraft, focus, focused } : null),
    [pins, actions, picking, open, draft, setDraft, focus, focused],
  );
  // Another prototype: no card of the last one stays open, and no note half written for it.
  const of = pins?.prototype;
  useEffect(() => {
    setOpen(null);
    setDraftState(null);
    setFocus(null);
    setPicking(null);
  }, [of]);
  // Leaving pin mode puts down a note not yet pinned.
  useEffect(() => {
    if (!pinning) setDraftState(null);
  }, [pinning]);
  const hold = shown && (pinning || open !== null || draft !== null || picking !== null);
  const onHold = pins?.onHold;
  useEffect(() => {
    onHold?.(hold);
    return () => onHold?.(false);
  }, [hold, onHold]);
  // Escape leaves pin mode, once nothing of a note's is open: a card or a spot's list takes its own Escape first.
  useHotkey(SHORTCUTS.leave.keys, () => pins?.onPinning(false), { enabled: shown && pinning && open === null && draft === null && picking === null });
  /** Puts down a note being written without giving focus back: the view is moving to another note. */
  const dropDraft = useCallback(() => setDraftState(null), []);
  return { context, open, setOpen, dropDraft };
}

/** The frames under it draw one variant, or, with `variant` absent, the prototype as it is: their pins are that surface's, placed on its revision. */
export function PinSurface({ variant, revision, kind, children }: { readonly variant?: string; readonly revision: string; readonly kind: "source" | "key"; readonly children: ReactNode }) {
  const board = useContext(PinContext);
  const value = useMemo((): PinBoard | null => {
    if (!board) return null;
    const { variant: _other, ...rest } = board;
    return { ...rest, revision, kind, ...(variant !== undefined ? { variant } : {}) };
  }, [board, variant, revision, kind]);
  return <PinContext value={value}>{children}</PinContext>;
}

/** No pins under it: frames that are not the prototype's or a variant's, such as a combination not applied yet. */
export function NoPins({ children }: { readonly children: ReactNode }) {
  return <PinContext value={null}>{children}</PinContext>;
}

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

/** How much of a marker's width two pins' points may be apart and still share a spot: closer, and the upper marker covers most of the lower. */
const SPOT = 0.75;

export function PinLayer({ session, spec, scale, measure, name }: { readonly session: Session; readonly spec: FrameSpec; readonly scale: number; readonly measure: FrameMeasure | null; /** The frame's name in words. */ readonly name: string }) {
  const board = useContext(PinContext);
  const scroll = useSyncExternalStore(session.subscribeScroll, () => session.scrollOf(spec.key));
  // A marker's width as the stylesheet draws it, read from a probe sized by the same token.
  const [size, setSize] = useState(0);
  const layer = useRef<HTMLDivElement>(null);
  const probe = useCallback((element: HTMLSpanElement | null) => {
    const width = element?.getBoundingClientRect().width ?? 0;
    if (width > 0) setSize(width);
  }, []);
  if (!board) return null;
  const frame = { scenario: spec.scenario.id, view: spec.view.name, ...(board.variant !== undefined ? { variant: board.variant } : {}) };
  const mine = board.state.pins.filter((pin) => pin.anchor.scenario === spec.scenario.id && pin.anchor.view === spec.view.name && onSurface(pin.anchor, board.variant));
  const draft = board.draft?.frame === spec.key && onSurface(board.draft.anchor, board.variant) ? board.draft : null;
  if (!board.pinning && mine.length === 0 && !draft) return null;
  const { width, height, scheme } = spec.view;
  const place = (anchor: PinAnchor) => intoView(toOverlay(anchor.point, scale, scroll), spec.view, scale);
  const placed = mine.map((pin) => ({ pin, ...place(pin.anchor) }));
  // Notes pinned on one spot: every marker stays at its own point, and the spot gets a count that lists them, so each is one click away.
  const shared = size > 0 ? spots(placed, size * SPOT).filter((group) => group.length > 1) : [];
  const capture = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const point = toPage({ x: event.clientX - box.left, y: event.clientY - box.top }, scale, scroll);
    board.setOpen(null);
    board.setDraft({ frame: spec.key, anchor: anchorAt(measure, frame, point, board.revision, board.kind), list: false });
  };
  return (
    <div className="pin-layer" ref={layer} data-scheme={scheme} data-pinning={board.pinning ? "" : undefined} style={{ width: width * scale, height: height * scale }} data-testid="pin-layer">
      <span className="pin-probe" ref={probe} aria-hidden="true" />
      {/* The click is taken here, by the app: the frame under it never hears it. Not a control: a keyboard pins from the frame's list instead. */}
      {board.pinning && measure && <div className="pin-capture" onClick={capture} data-testid="pin-capture" />}
      {placed.map(({ pin, ...at }) => (
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
      ))}
      {shared.map((group) => {
        // The spot's count sits beside the marker drawn last, which is the one on top.
        const top = group[group.length - 1] as (typeof group)[number];
        const id = `${board.variant ?? ""}|${spec.key}|${(group[0] as (typeof group)[number]).pin.number}`;
        return (
          <Spot
            key={id}
            at={top}
            // Beside the marker, on the side with room for it.
            side={top.x + size * 4 > width * scale ? "start" : "end"}
            pins={group.map((item) => item.pin)}
            frame={name}
            open={board.picking === id}
            onOpenChange={(next) => board.setPicking(next ? id : board.picking === id ? null : board.picking)}
            onPick={(number) => {
              board.setPicking(null);
              board.setDraft(null);
              // After the list has closed and given focus back to its count: focus goes to the note's own marker, never with a scroll, and its
              // card opens from there, so Escape closes the card and leaves focus on the marker, as for any other note.
              requestAnimationFrame(() => {
                layer.current?.querySelector<HTMLElement>(`[data-testid="pin"][data-pin="${number}"]`)?.focus({ preventScroll: true });
                board.setOpen(number);
              });
            }}
          />
        );
      })}
      {draft && (
        <Marker at={place(draft.anchor)} number={board.state.next} status="open" lost={false} draft label={`A new note on ${name}`} title="A new note" open onOpenChange={(next) => !next && board.setDraft(null)} focus={false} onFocused={board.focused}>
          <DraftCard
            draft={draft}
            measure={measure}
            frame={name}
            onMove={(index) => {
              const anchor = measure ? anchorOn(measure, frame, index, board.revision, board.kind) : null;
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

/**
 * Several notes on one spot: a count beside the marker on top, which opens
 * the list of them. Picking one opens its card, and its marker comes to the
 * top. Each marker keeps its own point and its own shape; the count is the
 * way to the ones underneath for a pointer, as Tab is for a keyboard.
 */
function Spot({ at, side, pins, frame, open, onOpenChange, onPick }: { readonly at: { readonly x: number; readonly y: number }; readonly side: "start" | "end"; readonly pins: readonly Pin[]; readonly frame: string; readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly onPick: (number: number) => void }) {
  const numbers = pins.map((pin) => pin.number);
  const label = `${pins.length} notes on this spot of ${frame}: notes ${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}. Pick one`;
  return (
    <Menu.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Menu.Trigger variant="secondary" tooltip={false} className="pin-spot" data-side={side} data-testid="pin-spot" data-count={pins.length} aria-label={label} style={{ insetInlineStart: at.x, insetBlockStart: at.y }}>
        <Button.Icon>
          <Layers />
        </Button.Icon>
        {pins.length}
      </Menu.Trigger>
      <Menu.Content aria-label={`${pins.length} notes on this spot`} className="pin-spot-list" data-testid="pin-spot-list">
        {pins.map((pin) => (
          <Menu.Item key={pin.number} onSelect={() => onPick(pin.number)} textValue={`${pin.number} ${pin.note}`} className="pin-spot-item" data-pin={pin.number} data-testid="pin-spot-item">
            <NoteMark pin={pin} />
            <span className="pin-spot-words">
              <span className="pin-spot-note">{short(pin.note)}</span>
              <span className="pin-spot-status">
                Note {pin.number} · {STATUS_WORDS[pin.status]}
                {pin.anchor.lost ? " · Moved or gone" : ""}
              </span>
            </span>
          </Menu.Item>
        ))}
      </Menu.Content>
    </Menu.Root>
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

function NoteField({ value, onChange, label, onSubmit, focus }: { readonly value: string; readonly onChange: (next: string) => void; readonly label: string; readonly onSubmit: () => void; /** Takes focus when it appears, the caret after its words: a note being edited. */ readonly focus?: boolean }) {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!focus || !field.current) return;
    field.current.focus({ preventScroll: true });
    field.current.setSelectionRange(field.current.value.length, field.current.value.length);
  }, [focus]);
  return (
    <Field.Root aria-label={label} className="pin-card-field">
      <Field.Textarea
        ref={field}
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

/** One entry of a pin's history in words: every kind has its own, so a new kind cannot go unsaid. */
function eventWords(event: PinEvent): string {
  switch (event.kind) {
    case "created":
      return `You wrote: ${event.note}`;
    case "edited":
      return `You changed it to: ${event.note}`;
    case "addressed":
      return `The agent replied: ${event.reply}`;
    case "closed":
      return "You closed it";
    case "reopened":
      return "You reopened it";
    case "undone":
      return "You undid the agent's turn: the note is open again, without that reply";
    case "picked":
      return `You applied a pick from ${variantLabel(event.variant)}: the note came with it, onto the prototype`;
    case "unpicked":
      return `You undid that pick: the note is back on ${variantLabel(event.variant)}, where it was`;
  }
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
            {eventWords(event)}
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
          <NoteField value={text} onChange={setText} label={`Your note ${pin.number}`} onSubmit={save} focus />
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
