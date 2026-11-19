import { Text, VisuallyHidden } from "@tounsoo/todae";
import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";
import { useId, type ReactNode } from "react";
import type { Cap, ChangeClass, PageType, Proposal, RuleSpec } from "@design-harness/core";
import { humanize } from "../app/words";
import { Bar } from "./parts";
import { CLASS_STOPS, capMeter, pageTypeWords, proposalTrack, ruleGlyph, slotRows, type BudgetMeter, type RuleGlyph } from "./project-model";

/**
 * The Project and Proposals tabs' own figures, drawn from the config and
 * from core's facts (`project-model.ts`): a page type as its slots, a cap
 * as a meter, a step budget as pips, a rule's shape as a glyph, a
 * proposal's class on a scale and its status on a track. Each is either a
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

/** The limit itself: pips to a dashed line for a count, a square at its actual size for a length in px. */
export function CapFigure({ name, cap }: { readonly name: string; readonly cap: Cap }) {
  const meter = capMeter(name, cap);
  return (
    <span className="cap-figure" data-meter={meter.kind}>
      {meter.kind === "size" && (
        <>
          <span className="cap-size" role="img" aria-label={`A ${meter.value} px square, at its actual size`} style={{ inlineSize: meter.value, blockSize: meter.value }} data-testid="cap-size" />
          <span className="count-words">{meter.words}, shown at its actual size</span>
        </>
      )}
      {meter.kind === "pips" && <Bar bar={{ pips: Array.from({ length: meter.value }, () => "missing" as const), limitAfter: meter.value, more: 0, words: meter.words }} />}
      {meter.kind === "number" && <span className="count-words">{meter.words}</span>}
    </span>
  );
}

/** A cap as a meter: its name in words, the limit drawn, which way is stricter, and the constant in code. */
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

/** A cap before and after a proposal: two meters with an arrow, and the direction in words. */
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

/** A task's step budget: pips to the limit, filled for what core says the open prototype's longest route takes. */
export function BudgetFigure({ meter }: { readonly meter: BudgetMeter }) {
  return (
    <div className="budget" data-testid="budget-meter" data-over={meter.today?.over ? "" : undefined}>
      <Bar bar={meter.bar} />
      {meter.today && (
        <Text.Root as="p" tone="muted" className="budget-today" data-testid="budget-today">
          {meter.today.text}
        </Text.Root>
      )}
    </div>
  );
}

/** Core's three classes as an ordered scale, with a marker on this one. It reads as how far the project moves, not as good to bad: position and weight carry it, never tone. */
export function ClassScale({ value, small }: { readonly value: ChangeClass; readonly small?: boolean }) {
  return (
    <ol className="class-scale" data-class={value} data-small={small ? "" : undefined} data-testid="class-scale" aria-label="How far it moves the project">
      {CLASS_STOPS.map((stop) => (
        <li key={stop.value} className="class-stop" data-current={stop.value === value ? "" : undefined} aria-current={stop.value === value ? "true" : undefined}>
          <i className="class-stop-line" aria-hidden="true" />
          <span className="class-stop-title" {...(stop.value === value ? { "data-testid": "proposal-class" } : {})}>
            {stop.title}
          </span>
          {!small && <span className="class-stop-about">{stop.about}</span>}
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

const GLYPH_NOTE: Readonly<Record<RuleGlyph, string>> = {
  count: "A count against its limit",
  "count-min": "A count that must reach its least",
  slot: "A page and one of its slots",
  inside: "One thing inside another",
  outside: "One thing kept out of another",
  nest: "Nesting, and one level too deep",
  list: "Names against a list",
  "target-size": "A control and its circle",
  contrast: "Text on its ground",
  headings: "A page's heading outline",
  "first-view": "A page and where its first view ends",
  sideways: "A page wider than its view",
  names: "A control and its name",
  coverage: "The flow's states, one with no scenario",
  budget: "A route, step by step, to a limit",
  code: "Checked in the source",
};

/** What a rule's glyph shows, in a few words: the shape of the rule, not this prototype's page. */
export function glyphNote(rule: RuleSpec): string {
  return GLYPH_NOTE[ruleGlyph(rule)];
}

/**
 * A rule's glyph, chosen by its type and check: the rule's shape, in ink
 * and hatch, hidden from a screen reader because core's words for the rule
 * sit beside it. A rule about code gets a plain plate, never a picture.
 */
export function RuleFigure({ rule, label }: { readonly rule: RuleSpec; /** The rule's limit in a few words, written over the glyph. */ readonly label?: string | undefined }) {
  const id = useId();
  const glyph = ruleGlyph(rule);
  const hatch = `url(#${id}h)`;
  if (glyph === "code") {
    return (
      <div className="rule-glyph rule-glyph-plate" data-glyph="code" aria-hidden="true">
        <span>{"{ }"}</span> checked in the source
      </div>
    );
  }
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
        {glyph === "count-min" && (
          <>
            <rect className="vis-guide" x="45" y="24" width="30" height="16" rx="3" />
            <rect className="vis-fail-area" x="45" y="24" width="30" height="16" rx="3" fill={hatch} />
          </>
        )}
        {glyph === "count" && (
          <>
            {/* A limit of none has nothing before the line. */}
            {label !== "none" && <rect className="glyph-ink" x="22" y="24" width="30" height="16" rx="3" />}
            <line className="vis-guide" x1="62" y1="14" x2="62" y2="52" />
            <rect className="vis-fail-area vis-fail-edge" x="72" y="24" width="30" height="16" rx="3" fill={hatch} />
          </>
        )}
        {glyph === "slot" && (
          <>
            <rect className="vis-box" x="36" y="4" width="48" height="48" rx="3" />
            <line className="glyph-line" x1="42" y1="12" x2="66" y2="12" />
            <line className="glyph-line" x1="42" y1="19" x2="76" y2="19" />
            <rect className="vis-subject" x="41" y="36" width="38" height="11" rx="2" />
            <rect className="glyph-ink" x="60" y="39" width="16" height="5" rx="1.5" />
          </>
        )}
        {glyph === "inside" && (
          <>
            <rect className="vis-guide" x="28" y="8" width="64" height="40" rx="4" />
            <rect className="glyph-ink" x="44" y="20" width="32" height="16" rx="3" />
          </>
        )}
        {glyph === "outside" && (
          <>
            <rect className="vis-guide" x="10" y="8" width="52" height="40" rx="4" />
            <rect className="vis-fail-area vis-fail-edge" x="20" y="20" width="30" height="16" rx="3" fill={hatch} />
            <rect className="glyph-ink" x="76" y="20" width="32" height="16" rx="3" />
          </>
        )}
        {glyph === "nest" && (
          <>
            <rect className="vis-box" x="22" y="6" width="76" height="44" rx="4" />
            <rect className="vis-subject" x="32" y="14" width="56" height="28" rx="3" />
            <rect className="vis-fail-area vis-fail-edge" x="42" y="21" width="36" height="14" rx="2" fill={hatch} />
          </>
        )}
        {glyph === "list" && (
          <>
            {[10, 22, 34].map((y) => (
              <g key={y}>
                <circle className="glyph-ink" cx="34" cy={y + 3} r="3" />
                <line className="glyph-line" x1="44" y1={y + 3} x2="86" y2={y + 3} />
              </g>
            ))}
            <rect className="vis-fail-area vis-fail-edge" x="30" y="43" width="58" height="8" rx="2" fill={hatch} />
          </>
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
        {glyph === "names" && (
          <>
            <rect className="vis-subject" x="26" y="24" width="34" height="18" rx="3" />
            <path className="glyph-stroke" d="M 60 28 L 72 18" />
            <rect className="vis-box" x="70" y="8" width="34" height="14" rx="7" />
            <line className="glyph-line" x1="77" y1="15" x2="97" y2="15" />
          </>
        )}
        {glyph === "coverage" && (
          <>
            <rect className="vis-subject" x="8" y="19" width="28" height="18" rx="9" />
            <rect className="vis-subject" x="46" y="19" width="28" height="18" rx="9" />
            <rect className="vis-guide" x="84" y="19" width="28" height="18" rx="9" />
          </>
        )}
        {glyph === "budget" && (
          <>
            <circle className="glyph-ink" cx="20" cy="28" r="7" />
            <line className="glyph-stroke" x1="27" y1="28" x2="43" y2="28" />
            <circle className="glyph-ink" cx="50" cy="28" r="7" />
            <line className="glyph-stroke" x1="57" y1="28" x2="68" y2="28" />
            <line className="vis-guide" x1="74" y1="8" x2="74" y2="48" />
            <circle className="vis-fail-area vis-fail-edge" cx="96" cy="28" r="7" fill={hatch} />
            <line className="glyph-stroke" x1="78" y1="28" x2="89" y2="28" />
          </>
        )}
      </svg>
    </div>
  );
}
