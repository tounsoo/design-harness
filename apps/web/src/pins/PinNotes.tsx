import { Button, Card, Stack, Text } from "@tounsoo/todae";
import { CircleHelp, Crosshair, MessageSquareText, Sparkles } from "lucide-react";
import { pinElementWords } from "./describe";
import type { Pin, PinState } from "./model";
import { LOST_WORDS, NoteMark, NoteStatus, PinHistory, type PinActions } from "./PinLayer";

/**
 * "Your notes": every note the person pinned on the open prototype, under
 * the checks and apart from them. A different section, different words and a
 * different mark from core's findings, because a note is the person's
 * feedback and never a check: it is counted in no verdict and no badge of
 * the Checks tab. Open notes lead, then the ones the agent answered, then
 * the closed ones; none is ever left out, whatever became of its element or
 * its frame.
 */
export function PinNotes({
  state,
  frameOf,
  actions,
  onShow,
  onAsk,
  onStart,
}: {
  readonly state: PinState;
  /** A pin's frame in words, or null when the prototype no longer has that scenario or view. */
  readonly frameOf: (pin: Pin) => string | null;
  readonly actions: PinActions;
  /** Moves the canvas to a pin and opens its card. */
  readonly onShow: (number: number) => void;
  /** Puts a message asking the agent to address the open notes into the chat. */
  readonly onAsk?: () => void;
  /** Turns "Pin a note" on, from the empty list. */
  readonly onStart: () => void;
}) {
  const order = { open: 0, addressed: 1, closed: 2 } as const;
  const pins = [...state.pins].sort((a, b) => order[a.status] - order[b.status] || a.number - b.number);
  const open = pins.filter((pin) => pin.status === "open").length;
  const answered = pins.filter((pin) => pin.status === "addressed").length;
  const summary = pins.length === 0 ? "Pin a note on any frame to tell the agent what to change there." : [open > 0 ? `${open} open` : null, answered > 0 ? `${answered} answered by the agent` : null, pins.length - open - answered > 0 ? `${pins.length - open - answered} closed` : null].filter(Boolean).join(" · ");
  return (
    <section className="notes" aria-labelledby="your-notes" data-testid="your-notes" data-open={open}>
      <div className="notes-head">
        <span className="notes-glyph" aria-hidden="true">
          <MessageSquareText />
        </span>
        <div className="notes-head-text">
          <Text.Root as="h2" id="your-notes" className="notes-title">
            Your notes
          </Text.Root>
          <Text.Root as="p" tone="muted" className="notes-summary" data-testid="notes-summary">
            {summary}
          </Text.Root>
        </div>
      </div>
      <Text.Root as="p" tone="muted" className="notes-what">
        Your own feedback, pinned on the canvas. Open notes go to the agent with your next message. They are never a check: they change no rule and no result above.
      </Text.Root>
      {pins.length === 0 ? (
        <Button.Root variant="secondary" onClick={onStart} className="notes-start">
          <Button.Icon>
            <MessageSquareText />
          </Button.Icon>
          Pin a note
        </Button.Root>
      ) : (
        <ol className="notes-list" aria-label="Your notes">
          {pins.map((pin) => {
            const frame = frameOf(pin);
            const element = pinElementWords(pin.anchor);
            return (
              <li key={pin.number} className="note" data-note={pin.number} data-status={pin.status} data-lost={pin.anchor.lost || frame === null ? "" : undefined}>
                <Card.Root className="note-card" aria-label={`Your note ${pin.number}`}>
                  <Stack.Root gap="condensed">
                    <div className="note-head">
                      <NoteMark pin={pin} />
                      <NoteStatus status={pin.status} />
                    </div>
                    <Text.Root as="p" className="note-text" data-testid="note-text">
                      {pin.note}
                    </Text.Root>
                    <Text.Root as="p" tone="muted" className="note-where">
                      {element ? `On ${element}` : "On the page"} · {frame ?? `${pin.anchor.scenario} at ${pin.anchor.view}`}
                    </Text.Root>
                    {(pin.anchor.lost || frame === null) && (
                      <Text.Root as="p" className="pin-lost" data-testid="note-lost">
                        <CircleHelp aria-hidden="true" />
                        <span>{frame === null ? "Moved or gone: the prototype no longer has this note's frame. The note is kept." : LOST_WORDS}</span>
                      </Text.Root>
                    )}
                    {pin.reply !== undefined && pin.status !== "open" && (
                      <div className="pin-reply" data-testid="note-reply">
                        <Text.Root as="span" variant="label" tone="muted">
                          The agent replied
                        </Text.Root>
                        <Text.Root as="p">{pin.reply}</Text.Root>
                      </div>
                    )}
                    <Stack.Root direction="row" gap="condensed" wrap className="note-actions">
                      <Button.Root variant="secondary" onClick={() => onShow(pin.number)} disabled={frame === null} data-testid="note-show">
                        <Button.Icon>
                          <Crosshair />
                        </Button.Icon>
                        Show me
                      </Button.Root>
                      {pin.status !== "closed" && (
                        <Button.Root variant="ghost" onClick={() => actions.close(pin.number)} data-testid="note-close">
                          Close note
                        </Button.Root>
                      )}
                      {pin.status !== "open" && (
                        <Button.Root variant="ghost" onClick={() => actions.reopen(pin.number)} data-testid="note-reopen">
                          Reopen
                        </Button.Root>
                      )}
                    </Stack.Root>
                    <PinHistory pin={pin} />
                  </Stack.Root>
                </Card.Root>
              </li>
            );
          })}
        </ol>
      )}
      {open > 0 && onAsk && (
        <Button.Root variant="ghost" onClick={onAsk} className="notes-ask" data-testid="notes-ask">
          <Button.Icon>
            <Sparkles />
          </Button.Icon>
          {open === 1 ? "Ask the agent to address it" : `Ask the agent to address all ${open}`}
        </Button.Root>
      )}
    </section>
  );
}
