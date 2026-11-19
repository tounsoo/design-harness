import { Text, VisuallyHidden } from "@tounsoo/todae";
import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";
import { useId, type ReactNode } from "react";
import type { Cap, ChangeClass, PageType, Proposal, RuleSpec } from "@design-harness/core";
import { humanize } from "../app/words";
import { CLASS_STOPS, capMeter, pageTypeWords, proposalTrack, ruleGlyph, slotRows, type BudgetMeter } from "./project-model";

/**
 * The Project and Proposals tabs' own figures, drawn from the config and
 * from core's facts (`project-model.ts`): a page type as its slots, a
 * length cap as a square at its actual size, a rule's shape as a glyph, a
 * proposal's class on a scale and its status on a track. A count cap and a
 * step budget are numbers and stand as their words, with no picture. Each is either a
 * list a screen reader reads as it is, or a picture hidden from it with the
 * same words beside it. None decides anything.
 */

const SLOT_KIND = { chrome: "chrome", primary: "primary action", body: "layouts" } as const;

/** A page type's skeleton: its slots stacked in the order the project lists them, chrome hatched, the primary slot heavy with a button in it. */
export function SlotDiagram({ type, added }: { readonly type: PageType; /** Slots to mark as new. */ readonly added?: readonly string[] }) {
  return (
    <ol className="slot-diagram" aria-label={`Slots of the ${humanize(type.id).toLowerCase()} page type, in the order the project lists them`} data-testid="slot-diagram" data-page-type={type.id}>
      {slotRows(type).map((row) => (
        <li key={row.slot} className="slot" data-slot={row.slot} data-slot-kind={row.kind}>
          <span className="slot-name">{row.slot}</span>
          <span className="slot-kind">
            {SLOT_KIND[row.kind]}
            {added?.includes(row.slot) ? ", new" : ""}
          </span>
          {row.kind === "primary" && <i className="slot-button" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

/** What the diagram's three kinds of slot mean. */
export function SlotLegend() {
  return (
    <ul className="evidence-legend slot-legend">
      <li>
        <span className="legend-mark slot-key" data-slot-kind="chrome" aria-hidden="true" /> Chrome: frames the page
      </li>
      <li>
        <span className="legend-mark slot-key" data-slot-kind="body" aria-hidden="true" /> Body: built from layouts
      </li>
      <li>
        <span className="legend-mark slot-key" data-slot-kind="primary" aria-hidden="true" /> Primary slot: exactly one primary action
      </li>
    </ul>
  );
}

/** A page type's diagram with its kind and slot counts in words beside it. */
export function PageTypeFigure({ type, children }: { readonly type: PageType; readonly children?: ReactNode }) {
  const words = pageTypeWords(type);
  return (
    <div className="page-type" data-page-type={type.id}>
      <SlotDiagram type={type} />
      <div className="page-type-words">
        <Text.Root as="h4" className="figure-title">
          {humanize(type.id)}
        </Text.Root>
        <Text.Root as="p">{words.kind}</Text.Root>
        <Text.Root as="p" tone="muted">
          {words.slots}
        </Text.Root>
        {children}
      </div>
    </div>
  );
}

function Direction({ cap }: { readonly cap: Pick<Cap, "stricter"> }) {
  return (
    <span className="cap-direction">
      {cap.stricter === "lower" ? <ArrowDown aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
      stricter when {cap.stricter}
    </span>
  );
}

/** The limit itself: a square at its actual size for a length in px, which words cannot show; a count is its words alone. */
export function CapFigure({ name, cap }: { readonly name: string; readonly cap: Cap }) {
  const meter = capMeter(name, cap);
  return (
    <span className="cap-figure" data-meter={meter.kind}>
      {meter.kind === "size" && (
        <>
          <span className="cap-size" role="img" aria-label={`A ${meter.value} px square, at its actual size`} style={{ inlineSize: meter.value, blockSize: meter.value }} data-testid="cap-size" />
          <span className="count-words" data-testid="cap-words">
            {meter.words}, shown at its actual size
          </span>
        </>
      )}
      {meter.kind === "number" && (
        <span className="count-words" data-testid="cap-words">
          {meter.words}
        </span>
      )}
    </span>
  );
}

/** A cap: its name in words, its limit, which way is stricter, and the constant in code. */
export function CapMeterView({ name, cap, children }: { readonly name: string; readonly cap: Cap; readonly children?: ReactNode }) {
  const meter = capMeter(name, cap);
  return (
    <div className="cap" data-cap={name} data-testid="cap-meter">
      <Text.Root as="h4" className="figure-title">
        {meter.title}
      </Text.Root>
      <div className="cap-row">
        <CapFigure name={name} cap={cap} />
        <Direction cap={cap} />
      </div>
      {cap.description && (
        <Text.Root as="p" tone="muted">
          {cap.description}
        </Text.Root>
      )}
      {children}
    </div>
  );
}

/** A cap before and after a proposal: the two limits with an arrow between, and the direction in words. */
export function CapChange({ name, cap, before, moved }: { readonly name: string; readonly cap: Cap; readonly before?: number | undefined; readonly moved: string }) {
  return (
    <div className="cap-change" data-testid="cap-change" data-moved={moved}>
      {before !== undefined && (
        <>
          <CapFigure name={name} cap={{ ...cap, value: before }} />
          <ArrowRight aria-hidden="true" className="cap-arrow" />
        </>
      )}
      <CapFigure name={name} cap={cap} />
      <Text.Root as="span" weight="medium" className="cap-moved">
        {moved === "new" ? "a new cap" : moved === "the same" ? `${cap.stricter === "lower" ? "at most" : "at least"} ${cap.value} now` : `${moved}: this cap is stricter when ${cap.stricter}`}
      </Text.Root>
    </div>
  );
}

/** A task's step budget in words, and what core says the open prototype's longest route takes today. */
export function BudgetFigure({ meter }: { readonly meter: BudgetMeter }) {
  return (
    <div className="budget" data-testid="budget-meter" data-over={meter.today?.over ? "" : undefined}>
      <Text.Root as="p" weight="medium" className="count-words" data-testid="budget-limit">
        {meter.words}
      </Text.Root>
      {meter.today && (
        <Text.Root as="p" tone="muted" className="budget-today" data-testid="budget-today">
          {meter.today.text}
        </Text.Root>
      )}
    </div>
  );
}

/** Core's three classes as an ordered scale, with a marker on this one. It reads as how far the project moves, not as good to bad: position and weight carry it, never tone. */
export function ClassScale({ value }: { readonly value: ChangeClass }) {
  return (
    <ol className="class-scale" data-class={value} data-testid="class-scale" aria-label="How far it moves the project">
      {CLASS_STOPS.map((stop) => (
        <li key={stop.value} className="class-stop" data-current={stop.value === value ? "" : undefined} aria-current={stop.value === value ? "true" : undefined}>
          <i className="class-stop-line" aria-hidden="true" />
          <span className="class-stop-title" {...(stop.value === value ? { "data-testid": "proposal-class" } : {})}>
            {stop.title}
          </span>
          <span className="class-stop-about">{stop.about}</span>
        </li>
      ))}
    </ol>
  );
}

/** Where a proposal stands, as a track: each step it has passed, the one it is at with what it waits for, and the ones ahead. */
export function ProposalTrack({ proposal, note }: { readonly proposal: Pick<Proposal, "status" | "history">; /** What the current step waits for, in a few words. */ readonly note?: string | undefined }) {
  const steps = proposalTrack(proposal);
  return (
    <ol className="track" aria-label="Where it stands" data-testid="proposal-track">
      {steps.map((step) => (
        <li key={step.id} className="track-step" data-step={step.id} data-state={step.state} aria-current={step.state === "current" ? "step" : undefined}>
          <i className="track-dot" aria-hidden="true" />
          <span className="track-title">
            {step.title}
            {step.state === "current" && note ? `: ${note}` : ""}
          </span>
          <VisuallyHidden.Root>{step.state === "done" ? ", done" : step.state === "current" ? ", now" : ", not yet"}</VisuallyHidden.Root>
        </li>
      ))}
    </ol>
  );
}

/**
 * A rule's glyph, for a rule about how a rendered page looks: the rule's
 * shape, in ink and hatch, hidden from a screen reader because core's words
 * for the rule sit beside it. Any other rule draws nothing (see `ruleGlyph`).
 */
export function RuleFigure({ rule, label }: { readonly rule: RuleSpec; /** The rule's limit in a few words, written over the glyph. */ readonly label?: string | undefined }) {
  const id = useId();
  const glyph = ruleGlyph(rule);
  const hatch = `url(#${id}h)`;
  if (!glyph) return null;
  return (
    <div className="rule-glyph" data-glyph={glyph} aria-hidden="true">
      <svg className="vis-svg" viewBox="0 0 120 56">
        <defs>
          <pattern id={`${id}h`} className="vis-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" />
          </pattern>
        </defs>
        {label && (
          <text className="vis-text vis-text-strong" x="60" y="9" textAnchor="middle">
            {label}
          </text>
        )}
        {glyph === "target-size" && (
          <>
            <circle className="vis-guide" cx="60" cy="28" r="20" />
            <rect className="vis-subject" x="46" y="19" width="28" height="18" rx="3" />
          </>
        )}
        {glyph === "contrast" && (
          <>
            <rect className="vis-box" x="16" y="12" width="40" height="32" rx="3" />
            <text className="vis-text glyph-text" x="36" y="34" textAnchor="middle">
              Aa
            </text>
            <rect className="glyph-ink" x="64" y="12" width="40" height="32" rx="3" />
            <text className="vis-text glyph-text glyph-text-on" x="84" y="34" textAnchor="middle">
              Aa
            </text>
          </>
        )}
        {glyph === "headings" && (
          <>
            <line className="glyph-line glyph-line-strong" x1="24" y1="12" x2="74" y2="12" />
            <line className="glyph-line" x1="34" y1="24" x2="84" y2="24" />
            <rect className="vis-fail-area vis-fail-edge" x="54" y="32" width="42" height="7" rx="2" fill={hatch} />
            <line className="glyph-line" x1="34" y1="47" x2="78" y2="47" />
          </>
        )}
        {glyph === "first-view" && (
          <>
            <rect className="vis-box" x="38" y="3" width="44" height="34" />
            <rect className="vis-ghost" x="38" y="37" width="44" height="16" />
            <rect className="glyph-ink" x="46" y="24" width="28" height="8" rx="2" />
            <line className="vis-line-strong" x1="30" y1="37" x2="90" y2="37" />
          </>
        )}
        {glyph === "sideways" && (
          <>
            <rect className="vis-box" x="30" y="6" width="44" height="44" />
            <rect className="vis-fail-area vis-fail-edge" x="74" y="18" width="20" height="14" fill={hatch} />
            <line className="vis-line-strong" x1="74" y1="2" x2="74" y2="54" />
          </>
        )}
      </svg>
    </div>
  );
}
