import { Text } from "@tounsoo/todae";
import { Check, X } from "lucide-react";
import { useContext, useId, type ReactNode } from "react";
import type { Evidence, EvidenceKind, Finding } from "@design-harness/core";
import { FlowMap } from "./FlowMap";
import { VisualContext } from "./parts";
import { boxFigure, outlineRows, regionFigure } from "./geometry";

/**
 * Evidence figures: what a rule measured, drawn from core's evidence. Every
 * evidence kind has one entry, never one per rule, so a rule a proposal adds
 * in the existing vocabulary is shown the day it is adopted. An entry either
 * draws a figure or says in words why it draws none.
 *
 * A kind draws only when the picture shows what core's message cannot: a
 * size, a ratio seen as the colours themselves, a place on the page, a gap
 * in an order, a route. A number against a limit reads whole in the message
 * ("has 2 primary actions, more than 1"), so it draws nothing: pips beside
 * that sentence would only repeat it. A figure is a schematic of measured
 * boxes, not the page's pixels, and it decides nothing: core's message stays
 * beside it word for word, as its caption and its text alternative.
 *
 * To show a new evidence kind, add its entry to `FIGURES`. The type fails to
 * compile, and `figures.test.ts` fails, until every kind core declares has
 * decided: a figure, or the reason for none.
 */

export type FigureProps<K extends EvidenceKind = EvidenceKind> = {
  readonly evidence: Extract<Evidence, { readonly kind: K }>;
  /** The finding the evidence is on, and every finding of its rule, for a figure that shows more than one place. */
  readonly finding: Finding;
  readonly findings: readonly Finding[];
};

export type FigureEntry<K extends EvidenceKind = EvidenceKind> =
  | {
      /** What the figure shows that the message cannot, in a few words. */
      readonly shows: string;
      readonly Figure: (props: FigureProps<K>) => ReactNode;
    }
  | {
      /** Why this kind's message stands alone, in words. */
      readonly wordsOnly: string;
    };

export const FIGURES: { readonly [K in EvidenceKind]: FigureEntry<K> } = {
  "box-with-neighbour": { shows: "The control at scale, its circle and the control it meets: sizes and a gap, from measured boxes", Figure: BoxWithNeighbour },
  "colour-pair": { shows: "The text in its measured colours, as it is painted in each scheme", Figure: ColourPair },
  "sequence-gap": { shows: "The page's outline in order, with the level it skips", Figure: SequenceGap },
  "count-vs-cap": { wordsOnly: "A count against its limit is two numbers, and core's message says both and names each element counted. The elements are outlined in their frames." },
  "region-line": { shows: "Where the first view ends or the view's edge runs, and how far the element or the page lies past it", Figure: RegionLine },
  "route-vs-budget": { shows: "The task's routes as a map, the longest numbered against the budget", Figure: RouteVsBudget },
  coverage: { wordsOnly: "How many states have a scenario is two numbers, and the message names the state that has none. The coverage grid shows every state against every view." },
};

/** The figure of a finding's evidence kind, when that kind draws one. */
function figureOf(finding: Finding): ((props: FigureProps) => ReactNode) | undefined {
  const entry = finding.evidence ? (FIGURES[finding.evidence.kind] as FigureEntry | undefined) : undefined;
  return entry && "Figure" in entry ? entry.Figure : undefined;
}

/** True when a finding has a figure to show: it carries evidence of a kind that draws. */
export function drawsFigure(finding: Finding): boolean {
  return figureOf(finding) !== undefined;
}

/**
 * A finding's figure with core's message as its caption (`children`). A
 * finding with no evidence, or with evidence of a kind that reads whole in
 * words, has no figure: the message stands alone, with nothing above it.
 */
export function EvidenceFigure({ finding, findings, children }: { readonly finding: Finding; readonly findings: readonly Finding[]; readonly children: ReactNode }) {
  const evidence = finding.evidence;
  const Figure = figureOf(finding);
  if (!evidence || !Figure) return <>{children}</>;
  return (
    <figure className="evidence" data-evidence={evidence.kind} data-testid="evidence">
      <div className="evidence-figure">
        <Figure evidence={evidence} finding={finding} findings={findings} />
      </div>
      <figcaption className="evidence-caption">{children}</figcaption>
    </figure>
  );
}

/** The hatch every failing area is filled with, so a failure never rests on colour alone. */
function Hatch({ id }: { readonly id: string }) {
  return (
    <defs>
      <pattern id={id} className="vis-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" />
      </pattern>
    </defs>
  );
}

function Legend({ items }: { readonly items: readonly ReactNode[] }) {
  return (
    <ul className="evidence-legend">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

const clip = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);

function BoxWithNeighbour({ evidence }: FigureProps<"box-with-neighbour">) {
  const id = useId();
  const figure = boxFigure(evidence);
  const { box, circle, neighbour, size } = figure;
  const name = evidence.name;
  const dimX = Math.min(box.x, circle.cx - circle.r) - 10;
  const dimY = Math.max(box.y + box.height, circle.cy + circle.r) + 8;
  return (
    <>
      <svg className="vis-svg" viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true" data-testid="figure-box">
        <Hatch id={`${id}hatch`} />
        <clipPath id={`${id}circle`}>
          <circle cx={circle.cx} cy={circle.cy} r={circle.r} />
        </clipPath>
        {neighbour && (
          <g data-testid="figure-neighbour">
            <rect className="vis-box" x={neighbour.box.x} y={neighbour.box.y} width={neighbour.box.width} height={neighbour.box.height} rx="3" />
            {/* Where the circle reaches the neighbour: hatched, the part that breaks the exception. */}
            {neighbour.circle ? (
              <circle className="vis-fail-area" cx={neighbour.circle.cx} cy={neighbour.circle.cy} r={neighbour.circle.r} fill={`url(#${id}hatch)`} clipPath={`url(#${id}circle)`} />
            ) : (
              <rect className="vis-fail-area" x={neighbour.box.x} y={neighbour.box.y} width={neighbour.box.width} height={neighbour.box.height} fill={`url(#${id}hatch)`} clipPath={`url(#${id}circle)`} />
            )}
            {neighbour.circle && <circle className="vis-guide" cx={neighbour.circle.cx} cy={neighbour.circle.cy} r={neighbour.circle.r} />}
            <text className="vis-text vis-text-muted" x={neighbour.box.x + neighbour.box.width / 2} y={Math.max(10, neighbour.box.y - 5)} textAnchor="middle">
              {clip(neighbour.name, 14)}
            </text>
          </g>
        )}
        <circle className="vis-guide" cx={circle.cx} cy={circle.cy} r={circle.r} />
        <rect className="vis-subject" x={box.x} y={box.y} width={box.width} height={box.height} rx="3" />
        {/* Dimension lines, just outside the circle: the measured height at its start side, the width under it. */}
        <g className="vis-dimension">
          <line x1={box.x} y1={dimY} x2={box.x + box.width} y2={dimY} />
          <line x1={box.x} y1={dimY - 4} x2={box.x} y2={dimY + 4} />
          <line x1={box.x + box.width} y1={dimY - 4} x2={box.x + box.width} y2={dimY + 4} />
          <line x1={dimX} y1={box.y} x2={dimX} y2={box.y + box.height} />
          <line x1={dimX - 4} y1={box.y} x2={dimX + 4} y2={box.y} />
          <line x1={dimX - 4} y1={box.y + box.height} x2={dimX + 4} y2={box.y + box.height} />
        </g>
        <text className="vis-text" x={box.x + box.width / 2} y={dimY + 13} textAnchor="middle">
          {figure.measured.width}
        </text>
        <text className="vis-text" x={dimX - 7} y={box.y + box.height / 2 + 4} textAnchor="end">
          {figure.measured.height}
        </text>
        {name && (
          <text className="vis-text vis-text-strong" x={box.x + box.width / 2} y={Math.max(10, Math.min(box.y, circle.cy - circle.r) - 5)} textAnchor={neighbour && neighbour.box.x >= box.x ? "end" : neighbour ? "start" : "middle"}>
            {clip(name, 18)}
          </text>
        )}
      </svg>
      <Legend
        items={[
          `Shown at ${figure.scale}×`,
          <>
            <span className="legend-mark legend-dash" aria-hidden="true" /> its {figure.min} px circle
          </>,
          ...(neighbour
            ? [
                <>
                  <span className="legend-mark legend-hatch" aria-hidden="true" /> where it meets {neighbour.name ? `"${clip(neighbour.name, 24)}"` : "another control"}
                </>,
              ]
            : []),
        ]}
      />
    </>
  );
}

function Verdict({ ok, children }: { readonly ok: boolean; readonly children: ReactNode }) {
  return (
    <span className="vis-verdict" data-ok={ok ? "" : undefined}>
      <span className="vis-verdict-icon" aria-hidden="true">
        {ok ? <Check /> : <X />}
      </span>
      {children}
    </span>
  );
}

/** The schemes a contrast finding covers: this text in this scenario, once per scheme and pair of colours. */
function schemesOf(finding: Finding, findings: readonly Finding[]): Extract<Evidence, { kind: "colour-pair" }>[] {
  const own = finding.evidence?.kind === "colour-pair" ? finding.evidence : undefined;
  if (!own) return [];
  const out = new Map<string, Extract<Evidence, { kind: "colour-pair" }>>();
  for (const item of [finding, ...findings]) {
    const evidence = item.evidence;
    if (evidence?.kind !== "colour-pair" || item.rule !== finding.rule || item.scenario !== finding.scenario || evidence.text !== own.text) continue;
    const key = `${evidence.scheme} ${evidence.foreground} ${evidence.background}`;
    if (!out.has(key)) out.set(key, evidence);
  }
  return [...out.values()].sort((a, b) => (a.scheme === b.scheme ? 0 : a.scheme === "light" ? -1 : 1));
}

function ColourPair({ evidence, finding, findings }: FigureProps<"colour-pair">) {
  const schemes = schemesOf(finding, findings);
  return (
    <>
      <ul className="contrast" aria-label="Measured contrast, by colour scheme">
        {schemes.map((item) => (
          <li key={`${item.scheme}${item.foreground}${item.background}`} className="contrast-row" data-scheme={item.scheme} data-testid="figure-contrast-row">
            <Text.Root as="span" tone="muted" className="contrast-scheme">
              {item.scheme === "dark" ? "Dark" : "Light"}
            </Text.Root>
            {/* The measured colours themselves: data, not theme. */}
            <span className="contrast-sample" style={{ color: item.foreground, background: item.background, fontWeight: item.weight >= 600 ? 700 : 400 }}>
              {item.text}
            </span>
            <Verdict ok={false}>
              <span data-testid="figure-ratio">{item.ratio.toFixed(2)}:1</span>
            </Verdict>
            <span className="contrast-pair">
              <span className="contrast-swatch" style={{ background: item.foreground }} aria-hidden="true" />
              {item.foreground} on <span className="contrast-swatch" style={{ background: item.background }} aria-hidden="true" />
              {item.background}
            </span>
          </li>
        ))}
      </ul>
      <Legend items={[`${evidence.px} px${evidence.weight >= 600 ? ", bold" : ""}: ${evidence.needs === 3 ? "large text needs 3:1" : "needs 4.5:1"}`]} />
    </>
  );
}

function SequenceGap({ evidence }: FigureProps<"sequence-gap">) {
  const rows = outlineRows(evidence);
  return (
    <ol className="outline" aria-label="The page's headings, in order" data-testid="figure-outline">
      {rows.map((row, index) =>
        row.kind === "more" ? (
          <li key={index} className="outline-more">
            {row.count} more {row.count === 1 ? "heading" : "headings"}
          </li>
        ) : row.kind === "gap" ? (
          <li key={index} className="outline-row outline-gap" style={{ "--level": row.level } as React.CSSProperties} data-testid="figure-gap">
            <span className="outline-level">h{row.level}</span>
            <span>no heading at this level</span>
          </li>
        ) : (
          <li key={index} className="outline-row" style={{ "--level": row.level } as React.CSSProperties} data-flagged={row.flag ? "" : undefined} data-hidden={row.shown ? undefined : ""}>
            <span className="outline-level">h{row.level}</span>
            <span className="outline-text">{row.text || "(no text)"}</span>
            {!row.shown && <span className="outline-note">not shown</span>}
            {row.flag && (
              <Verdict ok={false}>
                <span data-testid="figure-flag">{row.flag}</span>
              </Verdict>
            )}
          </li>
        ),
      )}
    </ol>
  );
}

function RegionLine({ evidence }: FigureProps<"region-line">) {
  const id = useId();
  const figure = regionFigure(evidence);
  const { page, view, line, past, box, size } = figure;
  const down = evidence.axis === "y";
  const words = page.x + page.width + 10;
  return (
    <>
      <svg className="vis-svg" viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true" data-testid="figure-region" data-axis={evidence.axis}>
        <Hatch id={`${id}hatch`} />
        <rect className="vis-box" x={view.x} y={view.y} width={view.width} height={view.height} />
        {down ? <rect className="vis-ghost" x={past.x} y={past.y} width={past.width} height={past.height} /> : <rect className="vis-fail-area vis-fail-edge" x={past.x} y={past.y} width={past.width} height={past.height} fill={`url(#${id}hatch)`} data-testid="figure-strip" />}
        {box && (
          <g data-testid="figure-below">
            <rect className="vis-subject" x={box.x} y={box.y} width={box.width} height={Math.max(box.height, 3)} rx="2" />
            {/* The part of it past the line is hatched: that is what the rule counts. */}
            <rect className="vis-fail-area" x={box.x} y={Math.max(box.y, line.y1)} width={box.width} height={Math.max(box.y + Math.max(box.height, 3) - Math.max(box.y, line.y1), 0)} fill={`url(#${id}hatch)`} />
          </g>
        )}
        <line className="vis-line-strong" x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} data-testid="figure-line" />
        {down ? (
          <>
            <text className="vis-text vis-text-strong" x={words} y={line.y1 - 3}>
              first view ends
            </text>
            <text className="vis-text vis-text-muted" x={words} y={line.y1 + 11}>
              {evidence.line} px
            </text>
            {box && (
              <text className="vis-text vis-text-fail" x={words} y={Math.max(line.y1 + 26, Math.min(box.y + box.height, size.height - 4))} data-testid="figure-by">
                ✕ {figure.by} px below
              </text>
            )}
          </>
        ) : (
          <>
            <text className="vis-text vis-text-strong" x={line.x1} y={size.height - 2} textAnchor="middle">
              view edge, {Math.round(evidence.line)} px
            </text>
            <text className="vis-text vis-text-fail" x={past.x + past.width + 6} y={past.y + past.height / 2 + 4} data-testid="figure-by">
              ✕ +{figure.by} px
            </text>
          </>
        )}
      </svg>
      <Legend
        items={[
          down ? (figure.closeUp ? "A close-up of where the first view ends, from measured boxes" : "The page in miniature") : "The first view in miniature",
          <>
            <span className="legend-mark legend-hatch" aria-hidden="true" /> {down ? "the part below the first view" : "the part wider than the view"}
          </>,
        ]}
      />
    </>
  );
}

function RouteVsBudget({ evidence }: FigureProps<"route-vs-budget">) {
  const { scenarios, onOpenState } = useContext(VisualContext);
  return <FlowMap scenarios={scenarios} onOpenState={onOpenState} task={{ id: evidence.task, start: evidence.start, success: evidence.success, budget: evidence.budget, transitions: evidence.transitions, longest: evidence.route, status: evidence.steps > evidence.budget ? "over" : "fits" }} />;
}
