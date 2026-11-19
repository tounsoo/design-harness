import { Alert, Badge, Button, Card, Code, Disclosure, EmptyState, Field, Label, RadioGroup, Stack, Table, Text } from "@tounsoo/todae";
import { Layers, MessageSquarePlus, RotateCcw, Sparkles, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CURRENT, formatSpec, parseJson, pickScope, recombine, recombinedKey, variantLabel, variantPrototype, type CheckReport, type Finding, type PickRecord, type PickScope, type ProjectConfig, type Prototype, type Recombination, type Variant } from "@design-harness/core";
import { fingerprint, reanchor, type FrameMeasure } from "../pins/anchor";
import type { PinState } from "../pins/model";
import { NoPins, PinContext, PinSurface, cardOf, usePinBoard, type BoardPins } from "../pins/PinLayer";
import { frameKey } from "../runtime/session";
import { isSpecRecord, type PrototypeRecord } from "../store/project-file";
import { FrameCard } from "./Board";
import { SHORTCUTS, ariaKeys } from "./shortcuts";
import { MIN_SCALE, rowScale, type RowBox } from "./frame-row";
import { useSessions, type Measured } from "./sessions";
import { humanize, ruleLead, scenarioName, viewLabel } from "./words";

/**
 * Variants side by side, and the person's pick. For the page being
 * compared, the page as it is and each variant the agent offered render in
 * measured frames of their own, every scenario and view (one scenario
 * shown at a time, the rest measured hidden), with core's whole report
 * under each. A pick answers for the page it changes, not for the whole
 * prototype: core's `pickScope` sorts each report into what is about this
 * page, what the change brings or changes elsewhere, and what another page
 * already had, and only the first two block. A variant with something to
 * fix on the page says so in core's words; it can be inspected and sent to
 * the agent to fix, but not picked until the page is clean. The person
 * picks each slot of the page type from any source that is; core recombines
 * them (`recombine`), the combination is measured and judged the same way,
 * and Apply makes it a new revision, recorded with where each slot came
 * from and undoable. Only the person applies a pick: nothing the agent
 * sends reaches this view's actions.
 *
 * Pinned notes work here as on the board (`pins/`). "Current" is the
 * prototype as it is, so it shows the board's own notes. A note pinned on a
 * variant is that variant's: its anchor names the variant, it is found again
 * on what the variant draws after the agent revises it, and it stays in the
 * list if the variant is dismissed. The combination being picked takes no
 * note: it is not kept anywhere until it is applied, and then it is the
 * prototype. When it is applied, the notes on what it took from a variant
 * go with it onto the prototype, and undoing the pick puts them back
 * (`pins/pick.ts`). A note is never read by `pickScope` or by any standing
 * here.
 */

export type ApplyPick = {
  readonly page: string;
  readonly slots: Readonly<Record<string, string>>;
  readonly notes: Readonly<Record<string, string>>;
  readonly before: string;
  readonly after: string;
  readonly prototype: Prototype;
  /** Where an element of one source is in the combination: core's `recombinedKey`. The notes pinned on a variant follow it (`pins/pick.ts`). */
  readonly keyOf: (source: string, key: string) => string | null;
};

type Props = {
  readonly config: ProjectConfig;
  readonly record: PrototypeRecord | undefined;
  /** Whether the agent can take a message now, and why not. */
  readonly agent: { readonly ready: boolean; readonly why: string };
  readonly onApply: (pick: ApplyPick) => void;
  readonly onUndo: (index: number) => void;
  /** Dismisses a variant, with the person's note on why when they give one. */
  readonly onDismiss: (id: string, note?: string) => void;
  /** Sends a message to the agent, as the person's. */
  readonly onSend: (message: string) => void;
  /** Puts a message in the chat's box for the person to edit and send. */
  readonly onPrefill: (message: string) => void;
  /** The open prototype's pinned notes and "Pin a note" mode; absent, the frames here carry none. */
  readonly pins?: BoardPins | undefined;
  /** Places the notes again on what a variant's frames measured; it changes anchors only. */
  readonly onReanchor?: (change: (state: PinState) => PinState) => void;
  /** A note on a variant to show: its page and scenario are chosen, its frame scrolled to, and its card opened. The nonce makes the same note show twice. */
  readonly show?: { readonly number: number; readonly nonce: number } | null;
};

type Source = { readonly id: string; readonly label: string; readonly note: string; readonly like?: string; readonly prototype: Prototype; readonly variant?: Variant };

/**
 * Where a source stands for a pick on the page: still measuring, or measured,
 * with core's report sorted by `pickScope` against the prototype as it is.
 * `pass` means nothing blocks a pick of it: the page has no finding and the
 * change brings none elsewhere. A failure another page already had is in
 * `scope.existing` and blocks nothing.
 */
type Standing = { readonly state: "measuring"; readonly text: string } | { readonly state: "pass" | "fail"; readonly report: CheckReport; readonly scope: PickScope };

function reportOf(item: Measured | undefined): CheckReport | { readonly measuring: string } {
  if (!item) return { measuring: "not measured" };
  if (item.measurement.state === "measuring") return { measuring: `measuring ${item.measurement.answered} of ${item.measurement.total}` };
  return item.state.report ?? { measuring: "checking" };
}

/** `before` is core's report on the prototype as it is, or null while that is still being measured. */
function standingOf(item: Measured | undefined, before: CheckReport | null, page: string): Standing {
  const report = reportOf(item);
  if ("measuring" in report) return { state: "measuring", text: report.measuring };
  if (!before || !item) return { state: "measuring", text: "waiting for the page as it is" };
  const scope = pickScope(before, report, item.prototype, page);
  return { state: scope.clear ? "pass" : "fail", report, scope };
}

/** The findings that block a pick, by rule, in core's order: the page's own, then what the change brings elsewhere. */
function blocking(standing: Standing): { readonly rule: string; readonly findings: readonly Finding[]; readonly elsewhere: boolean }[] {
  if (standing.state === "measuring") return [];
  const groups = new Map<string, { rule: string; findings: Finding[]; elsewhere: boolean }>();
  const add = (finding: Finding, elsewhere: boolean) => {
    const key = `${elsewhere ? "1" : "0"}${finding.rule}`;
    const group = groups.get(key) ?? { rule: finding.rule, findings: [], elsewhere };
    group.findings.push(finding);
    groups.set(key, group);
  };
  for (const finding of standing.scope.page) add(finding, false);
  for (const finding of standing.scope.introduced) add(finding, true);
  return [...groups.values()];
}

const things = (count: number) => `${count} ${count === 1 ? "thing" : "things"} to fix`;

const canonical = (text: string | undefined): string => {
  if (text === undefined) return "";
  const parsed = parseJson(text);
  return parsed.ok ? formatSpec(parsed.value) : text;
};

/**
 * One source's frames: the chosen scenario's views side by side, scaled to
 * the row's own width, which it measures with the gap and the artboard's
 * least width its stylesheet gives; the frames not shown keep measuring out
 * of sight. Its card names the source, so each artboard's head says only its
 * view.
 */
function FrameRow({ item, label, scenario, viewName }: { readonly item: Measured; readonly label: string; readonly scenario: string | null; readonly viewName: string }) {
  const row = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<RowBox | null>(null);
  useEffect(() => {
    const element = row.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const card = element.querySelector(".frame-card");
      const next = {
        // A pixel of slack: clientWidth is rounded, and a row that is a fraction too wide wraps.
        width: Math.floor(element.clientWidth - parseFloat(style.paddingInlineStart) - parseFloat(style.paddingInlineEnd)) - 1,
        gap: parseFloat(style.columnGap) || 0,
        least: card ? parseFloat(getComputedStyle(card).minWidth) || 0 : 0,
      };
      setBox((previous) => (previous && previous.width === next.width && previous.gap === next.gap && previous.least === next.least ? previous : next));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  const shown = item.state.frames.filter((spec) => spec.scenario.id === scenario && (viewName === "all" || spec.view.name === viewName));
  // Until the row is measured, the least scale: nothing drawn wider than the row.
  // As on the board, a scenario's light views share one line and its dark views the next: the row is sized for the widest line, and the next scheme wraps under it.
  const lines = new Map<string, number[]>();
  for (const spec of shown) lines.set(spec.view.scheme, [...(lines.get(spec.view.scheme) ?? []), spec.view.width]);
  const widest = [...lines.values()].reduce((best, line) => (line.reduce((sum, width) => sum + width, 0) > best.reduce((sum, width) => sum + width, 0) ? line : best), [] as number[]);
  const scale = box ? rowScale(widest, box) : MIN_SCALE;
  return (
    <div className="variant-frames" ref={row}>
      {item.state.frames.map((spec) => (
        <FrameCard key={spec.key} session={item.session} spec={spec} revision={item.state.revision} frameState={item.state.frameStates[spec.key] ?? { state: "waiting" }} scale={scale} focused={false} hidden={!shown.includes(spec)} selected={false} label={label} caption="" />
      ))}
    </div>
  );
}

export function VariantsView({ config, record, agent, onApply, onUndo, onDismiss, onSend, onPrefill, pins, onReanchor, show }: Props) {
  // A stored TSX prototype has no variants: core reads no page of it.
  const prototype = record && isSpecRecord(record) ? record.prototype : undefined;
  const state = record?.variants;
  const variants = useMemo(() => state?.variants ?? [], [state]);
  const pages = useMemo(() => [...new Set(variants.map((variant) => variant.page))].filter((page) => prototype?.pages.some((item) => item.id === page)), [variants, prototype]);
  const [chosenPage, setPage] = useState<string | null>(null);
  const page = chosenPage !== null && pages.includes(chosenPage) ? chosenPage : (variants.at(-1)?.page ?? pages[0] ?? null);
  const entry = prototype?.pages.find((item) => item.id === page);
  const pageType = entry ? config.inventories.pageTypes.find((type) => type.id === entry.pageType) : undefined;
  const scenarios = prototype?.scenarios.filter((scenario) => scenario.page === page) ?? [];
  const [scenarioChoice, setScenario] = useState<string | null>(null);
  const scenario = scenarios.find((item) => item.id === scenarioChoice)?.id ?? scenarios[0]?.id ?? null;
  /** One view at a time, or every view of the scenario; the views not shown keep measuring out of sight. */
  const [viewChoice, setView] = useState("all");
  const viewName = config.views.some((view) => view.name === viewChoice) ? viewChoice : "all";
  const [picks, setPicks] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => setPicks({}), [page]);

  const sources = useMemo((): Source[] => {
    if (!prototype || !page) return [];
    const current: Source = { id: CURRENT, label: variantLabel(CURRENT), note: "The page as it is now.", prototype };
    return [current, ...variants.filter((variant) => variant.page === page).map((variant): Source => ({ id: variant.id, label: variantLabel(variant.id), note: variant.note, ...(variant.like ? { like: variant.like } : {}), prototype: variantPrototype(prototype, variant), variant }))];
  }, [prototype, page, variants]);

  const slots = pageType?.slots ?? [];
  const chosen: Record<string, string> = Object.fromEntries(slots.map((slot) => [slot, picks[slot] ?? CURRENT]));
  const currentText = entry && prototype ? prototype.files[entry.component.file] : undefined;
  const combination = useMemo((): { readonly ok: true; readonly value: Recombination } | { readonly ok: false; readonly error: string } | null => {
    if (!prototype || !page || !entry || Object.values(chosen).every((source) => source === CURRENT)) return null;
    const texts = Object.fromEntries(sources.map((source) => [source.id, source.id === CURRENT ? (currentText ?? "") : (source.variant?.spec ?? "")]));
    return recombine(prototype, config, page, texts, chosen);
    // The picks are read through `chosen`, which is rebuilt from them each render.
  }, [prototype, page, entry, sources, currentText, config, JSON.stringify(chosen)]);
  const combined = combination?.ok && canonical(combination.value.spec) !== canonical(currentText) ? combination.value : null;

  const items = useMemo(() => [...sources.map((source) => ({ id: source.id, config, prototype: source.prototype })), ...(combined ? [{ id: "combination", config, prototype: combined.prototype }] : [])], [sources, combined, config]);
  const measured = useSessions(items);
  const byId = new Map(measured.map((item) => [item.id, item]));

  // Pinned notes on these frames: which card is open, the note being written, and Escape.
  const root = useRef<HTMLDivElement>(null);
  const { context: pinBoard, setOpen: setOpenPin, dropDraft } = usePinBoard(prototype ? pins : undefined, root);
  const pinning = pinBoard?.pinning ?? false;
  // Each time a variant's frames are measured, the notes pinned on it are placed again, as the board's are on the prototype's.
  const noted = pins?.state.pins.some((pin) => pin.anchor.variant !== undefined) ?? false;
  useEffect(() => {
    if (!noted || !onReanchor) return;
    for (const item of measured) {
      if (item.id === CURRENT || item.id === "combination") continue;
      const frames: Record<string, FrameMeasure> = {};
      for (const frame of item.state.frames) {
        const value = item.state.frameStates[frame.key];
        if (value?.state === "measured") frames[frame.key] = { snapshot: value.snapshot, places: value.places ?? [], width: frame.view.width, height: frame.view.height };
      }
      const revision = fingerprint(item.prototype);
      // The same state comes back when no anchor moved, and then nothing is saved.
      onReanchor((state) => reanchor(state, frames, revision, item.id));
    }
  });
  // "Show me" on a note pinned to a variant: its page and scenario, then its frame and its card.
  const showNonce = show?.nonce;
  useEffect(() => {
    const pin = show ? pins?.state.pins.find((item) => item.number === show.number) : undefined;
    const variant = variants.find((item) => item.id === pin?.anchor.variant);
    if (!pin || !variant) return;
    setPage(variant.page);
    setScenario(pin.anchor.scenario);
    setView("all");
    dropDraft();
    let tries = 0;
    let frame = 0;
    const look = () => {
      const card = cardOf(root.current, frameKey(pin.anchor.scenario, pin.anchor.view), variant.id);
      if (card?.querySelector(`[data-pin="${pin.number}"]`)) {
        // The view's own pane scrolls to the frame; the board is not touched.
        card.scrollIntoView({ block: "center", inline: "nearest" });
        setOpenPin(pin.number);
      } else if ((tries += 1) < 120) frame = requestAnimationFrame(look);
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
    // Only a new request moves the view: what the person chooses afterwards is theirs.
  }, [showNonce]);

  if (!record) return null;
  if (!prototype) {
    return (
      <Stack.Root gap="normal" className="variants" data-testid="variants">
        <Text.Root as="h2" className="variants-title">
          Variants
        </Text.Root>
        <Alert.Root tone="info" data-testid="variants-tsx">
          <Alert.Title>Variants are for spec prototypes</Alert.Title>
          <Alert.Description>
            This prototype is TSX, which is no longer edited or checked here: it takes no variants and no picks. Variants need each page as data, which a spec is and code is not. Start a spec version of it from the canvas to compare variants.
          </Alert.Description>
        </Alert.Root>
      </Stack.Root>
    );
  }

  // Core's report on the prototype as it is: what every source and the combination are compared with.
  const currentReport = reportOf(byId.get(CURRENT));
  const before = "measuring" in currentReport ? null : currentReport;
  const standings = new Map(sources.map((source) => [source.id, page ? standingOf(byId.get(source.id), before, page) : ({ state: "measuring", text: "not measured" } as Standing)]));
  const pickable = (id: string) => standings.get(id)?.state === "pass";
  const comboStanding = combined && page ? standingOf(byId.get("combination"), before, page) : null;
  const blocked = Object.values(chosen).filter((id) => id !== CURRENT && !pickable(id));
  const comboBlocks = comboStanding ? blocking(comboStanding) : [];
  const applyWhy = !combination
    ? "Pick at least one slot from a variant."
    : !combination.ok
      ? combination.error
      : !combined
        ? "These picks give the page as it is."
        : blocked.length > 0
          ? `${[...new Set(blocked)].map(variantLabel).join(", ")} still has something to fix on this page.`
          : comboStanding?.state === "measuring"
            ? `The combination is ${comboStanding.text}.`
            : comboStanding?.state !== "pass"
              ? comboBlocks.some((group) => !group.elsewhere)
                ? "The combination has something to fix on this page; pick differently."
                : "The combination changes a check outside this page; pick differently."
              : null;
  const elsewhere = comboStanding && comboStanding.state !== "measuring" ? comboStanding.scope.existing.length : 0;
  const usedNotes = Object.fromEntries([...new Set(Object.values(chosen))].filter((id) => id !== CURRENT).map((id) => [id, sources.find((source) => source.id === id)?.note ?? ""]));
  const picksHere = (state?.picks ?? []).map((pick, index) => ({ pick, index })).filter(({ pick }) => pick.page === page);
  const undoable = [...picksHere].reverse().find(({ pick }) => !pick.undone);

  // A source's frames carry its notes: the prototype's own for "Current", a variant's for that variant, and none for the combination.
  const frameRow = (item: Measured | undefined, label: string) => {
    if (!item) return null;
    const row = <FrameRow item={item} label={label} scenario={scenario} viewName={viewName} />;
    if (item.id === "combination") return <NoPins>{row}</NoPins>;
    return (
      <PinSurface {...(item.id === CURRENT ? {} : { variant: item.id })} revision={fingerprint(item.prototype)}>
        {row}
      </PinSurface>
    );
  };

  return (
    <PinContext value={pinBoard}>
    <div className="variants-root" ref={root} data-pinning={pinning ? "" : undefined}>
    <Stack.Root gap="normal" className="variants" data-testid="variants">
      <Stack.Root direction="row" align="center" gap="normal" wrap className="variants-head">
        <Text.Root as="h2" className="variants-title">
          Variants
        </Text.Root>
        {pages.length > 1 && (
          <Stack.Root direction="row" align="center" gap="condensed">
            <Label.Root htmlFor="variants-page">Page</Label.Root>
            <Field.Root id="variants-page" className="variants-picker">
              <Field.Select value={page ?? ""} onValueChange={(value) => setPage(value)}>
                {pages.map((item) => (
                  <option key={item} value={item}>
                    {humanize(item)}
                  </option>
                ))}
              </Field.Select>
            </Field.Root>
          </Stack.Root>
        )}
        {scenarios.length > 0 && page && (
          <Stack.Root direction="row" align="center" gap="condensed">
            <Label.Root htmlFor="variants-scenario">Scenario</Label.Root>
            <Field.Root id="variants-scenario" className="variants-picker">
              <Field.Select value={scenario ?? ""} onValueChange={(value) => setScenario(value)}>
                {scenarios.map((item) => (
                  <option key={item.id} value={item.id}>
                    {scenarioName(item)}
                  </option>
                ))}
              </Field.Select>
            </Field.Root>
          </Stack.Root>
        )}
        {config.views.length > 1 && page && (
          <Stack.Root direction="row" align="center" gap="condensed">
            <Label.Root htmlFor="variants-view">View</Label.Root>
            <Field.Root id="variants-view" className="variants-picker">
              <Field.Select value={viewName} onValueChange={setView}>
                <option value="all">Every view</option>
                {config.views.map((view) => (
                  <option key={view.name} value={view.name}>
                    {viewLabel(view.name)}
                  </option>
                ))}
              </Field.Select>
            </Field.Root>
          </Stack.Root>
        )}
        {pins && page && (
          <Button.Root variant="ghost" className="variants-pin" pressed={pinning} onPressedChange={(next) => pins.onPinning(next)} aria-label={`Pin a note (${SHORTCUTS.pin.label})`} aria-keyshortcuts={ariaKeys(SHORTCUTS.pin)} data-testid="variants-pin-mode">
            <Button.Icon>
              <MessageSquarePlus />
            </Button.Icon>
            Pin a note
          </Button.Root>
        )}
      </Stack.Root>
      {pinning && page && (
        <Text.Root as="p" className="variants-pinning" data-testid="variants-pin-hint">
          Click a spot on Current or on a variant to pin a note there, or pick an element from a frame&apos;s list. A note on a variant is about that variant. <kbd>Esc</kbd> leaves.
        </Text.Root>
      )}

      {!page ? (
        <EmptyState.Root data-testid="variants-empty">
          <EmptyState.Title>No variants yet</EmptyState.Title>
          <EmptyState.Description>Ask the agent for two to four variants of a page. Each is a whole page built from the inventories and layouts, shown here side by side with core&apos;s checks; you pick each slot from the one you like.</EmptyState.Description>
          <EmptyState.Actions>
            <Button.Root variant="secondary" onClick={() => onPrefill(`Give me 3 variants of the ${prototype.pages[0]?.id ?? ""} page, each different in one way, so I can compare them.`)}>
              <Button.Icon>
                <Layers />
              </Button.Icon>
              Ask the agent for variants
            </Button.Root>
          </EmptyState.Actions>
        </EmptyState.Root>
      ) : (
        <>
          <Text.Root as="p" tone="muted" className="variants-small">
            The <strong>{humanize(page).toLowerCase()}</strong> page as it is, beside {sources.length - 1} {sources.length === 2 ? "variant" : "variants"}. Each is checked in every scenario and view. A pick answers for this page only: a variant with something to fix here cannot be picked until it is fixed, and a problem already on another page does not stand in the way.
          </Text.Root>
          <div className="variants-grid" data-views={viewName === "all" && config.views.length > 1 ? "all" : "one"}>
            {sources.map((source) => (
              <SourceCard key={source.id} source={source} page={page} config={config} standing={standings.get(source.id) as Standing} frames={frameRow(byId.get(source.id), source.label)} agent={agent} onSend={onSend} onDismiss={onDismiss} />
            ))}
          </div>

          <section className="variants-section" aria-labelledby="variants-pick-title">
            <Text.Root as="h3" id="variants-pick-title" className="variants-subtitle">
              Pick each slot
            </Text.Root>
            <Table.Root className="variants-table" data-testid="variants-picks">
              <Table.Head>
                <Table.Row>
                  <Table.HeaderCell>Slot</Table.HeaderCell>
                  <Table.HeaderCell>From</Table.HeaderCell>
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {slots.map((slot) => (
                  <Table.Row key={slot} data-slot={slot}>
                    <Table.Cell>
                      <Text.Root as="span" weight="medium">
                        {slot}
                      </Text.Root>
                    </Table.Cell>
                    <Table.Cell>
                      <RadioGroup.Root aria-label={`Where ${slot} comes from`} orientation="horizontal" value={chosen[slot] ?? CURRENT} onValueChange={(value) => value && setPicks((previous) => ({ ...previous, [slot]: value }))}>
                        {sources.map((source) => (
                          <RadioGroup.Item key={source.id} value={source.id} disabled={source.id !== CURRENT && !pickable(source.id)}>
                            {source.label}
                          </RadioGroup.Item>
                        ))}
                      </RadioGroup.Root>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
            <Stack.Root direction="row" gap="condensed" wrap>
              {sources
                .filter((source) => source.id !== CURRENT)
                .map((source) => (
                  <Button.Root key={source.id} variant="ghost" disabled={!pickable(source.id)} onClick={() => setPicks(Object.fromEntries(slots.map((slot) => [slot, source.id])))}>
                    {`Every slot from ${source.label}`}
                  </Button.Root>
                ))}
              <Button.Root variant="ghost" onClick={() => setPicks({})}>
                <Button.Icon>
                  <RotateCcw />
                </Button.Icon>
                Reset to the page as it is
              </Button.Root>
            </Stack.Root>
            {combined && (
              <Card.Root className="variant-card" data-testid="variant-combination" data-standing={comboStanding?.state}>
                <Card.Header>
                  <Stack.Root direction="row" align="center" gap="condensed" wrap>
                    <Text.Root as="h4" className="variant-name">
                      The combination
                    </Text.Root>
                    <StandingBadge standing={comboStanding as Standing} />
                  </Stack.Root>
                  <Text.Root as="p" tone="muted" className="variants-small">
                    {slots.map((slot) => `${slot} from ${variantLabel(chosen[slot] ?? CURRENT)}`).join(", ")}.
                    {combined.renamed.length > 0 && ` Kept apart: ${combined.renamed.map((item) => `${item.kind} ${item.from} of ${variantLabel(item.source)} is ${item.to}`).join("; ")}.`}
                  </Text.Root>
                </Card.Header>
                <Card.Body>
                  <Stack.Root gap="condensed">
                    {frameRow(byId.get("combination"), "The combination")}
                    <ReportList standing={comboStanding as Standing} config={config} />
                  </Stack.Root>
                </Card.Body>
              </Card.Root>
            )}
            {combination && !combination.ok && (
              <Alert.Root tone="warning">
                <Alert.Description>{combination.error}</Alert.Description>
              </Alert.Root>
            )}
            <Stack.Root direction="row" align="center" gap="normal" wrap>
              <Button.Root
                variant="primary"
                disabled={applyWhy !== null}
                data-testid="apply-pick"
                onClick={() => {
                  if (applyWhy !== null || !combined || currentText === undefined || !page) return;
                  onApply({ page, slots: combined.slots, notes: usedNotes, before: currentText, after: combined.spec, prototype: combined.prototype, keyOf: (source, key) => recombinedKey(combined, source, key) });
                  setPicks({});
                }}
              >
                Apply this pick
              </Button.Root>
              {applyWhy ? (
                <Text.Root as="span" tone="muted" className="variants-small" data-testid="apply-why">
                  {applyWhy}
                </Text.Root>
              ) : (
                elsewhere > 0 && (
                  <Text.Root as="span" tone="muted" className="variants-small" data-testid="apply-note">
                    {`This page follows the rules. ${things(elsewhere)} on another page ${elsewhere === 1 ? "stays" : "stay"} as ${elsewhere === 1 ? "it is" : "they are"}.`}
                  </Text.Root>
                )
              )}
            </Stack.Root>
          </section>

          {picksHere.length > 0 && (
            <section className="variants-section" aria-labelledby="variants-history-title">
              <Text.Root as="h3" id="variants-history-title" className="variants-subtitle">
                Picks applied
              </Text.Root>
              <ul className="variants-history" data-testid="pick-history">
                {picksHere.map(({ pick, index }) => (
                  <PickEntry key={index} pick={pick} order={slots} canUndo={undoable?.index === index} current={currentText} onUndo={() => onUndo(index)} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </Stack.Root>
    </div>
    </PinContext>
  );
}

function StandingBadge({ standing }: { readonly standing: Standing }) {
  if (standing.state === "measuring") return <Badge.Root tone="info">{standing.text}</Badge.Root>;
  if (standing.state === "pass") return <Badge.Root tone="success">{standing.report.status === "pass" ? "passes every rule" : "this page follows the rules"}</Badge.Root>;
  const count = blocking(standing).length + standing.scope.stopped.length;
  return <Badge.Root tone="critical">{things(count)}</Badge.Root>;
}

/**
 * Core's report under a source, for a pick on this page: what blocks it,
 * each rule in plain words with core's messages word for word, then what
 * another page already had, which blocks nothing, and the rule ids one step
 * away.
 */
function ReportList({ standing, config }: { readonly standing: Standing; readonly config: ProjectConfig }) {
  if (standing.state === "measuring") return null;
  const { report, scope } = standing;
  const groups = blocking(standing);
  const lead = (id: string) => {
    const rule = report.rules.find((item) => item.rule === id);
    return rule ? ruleLead(rule, config) : humanize(id);
  };
  const existingRules = [...new Set(scope.existing.map((finding) => finding.rule))];
  return (
    <Stack.Root gap="condensed" data-testid="variant-report">
      {groups.length === 0 && scope.stopped.length === 0 ? (
        <Text.Root as="p" tone="muted" className="variants-small">
          {report.status === "pass" ? `Every rule passes: ${report.rules.length} rules, the rendered ones measured.` : "Nothing to fix on this page."}
        </Text.Root>
      ) : (
        <ul className="variant-report" aria-label="What to fix before this can be picked">
          {groups.map((group) => (
            <li key={`${group.elsewhere ? "elsewhere" : "page"}-${group.rule}`} data-rule={group.rule} data-scope={group.elsewhere ? "introduced" : "page"} className="variant-issue">
              <Text.Root as="p" weight="medium" className="variants-small">
                {group.elsewhere ? `Outside this page, changed by it: ${lead(group.rule)}` : lead(group.rule)}
              </Text.Root>
              {group.findings.slice(0, 3).map((finding, index) => (
                <Text.Root as="p" key={index} className="variants-small fix-message" data-testid="variant-finding">
                  {finding.message}
                </Text.Root>
              ))}
              {group.findings.length > 3 && (
                <Text.Root as="p" tone="muted" className="variants-small">
                  and {group.findings.length - 3} more
                </Text.Root>
              )}
            </li>
          ))}
          {scope.stopped.map((rule) => (
            <li key={`stopped-${rule}`} data-rule={rule} data-scope="stopped" className="variant-issue">
              <Text.Root as="p" weight="medium" className="variants-small">
                {`Could not be checked any more: ${lead(rule)}`}
              </Text.Root>
            </li>
          ))}
        </ul>
      )}
      {scope.existing.length > 0 && (
        <Disclosure.Root className="variant-elsewhere" data-testid="variant-elsewhere">
          <Disclosure.Summary>{`Already on another page: ${things(scope.existing.length)}, not part of this pick`}</Disclosure.Summary>
          <ul className="variant-report">
            {scope.existing.map((finding, index) => (
              <li key={index} data-rule={finding.rule}>
                <Text.Root as="p" tone="muted" className="variants-small fix-message">
                  {finding.message}
                </Text.Root>
              </li>
            ))}
          </ul>
        </Disclosure.Root>
      )}
      {(groups.length > 0 || existingRules.length > 0 || scope.stopped.length > 0) && (
        <Disclosure.Root className="variant-details">
          <Disclosure.Summary>Details</Disclosure.Summary>
          <Text.Root as="p" tone="muted" className="variants-small">
            Core&apos;s verdict on the whole prototype: {report.status}. Rules:{" "}
            {[...new Set([...groups.map((group) => group.rule), ...scope.stopped, ...existingRules])].map((rule, index) => (
              <span key={rule}>
                {index > 0 ? ", " : ""}
                <Code.Root>{rule}</Code.Root>
              </span>
            ))}
            .
          </Text.Root>
        </Disclosure.Root>
      )}
    </Stack.Root>
  );
}

function SourceCard({ source, page, config, standing, frames, agent, onSend, onDismiss }: { readonly source: Source; readonly page: string; readonly config: ProjectConfig; readonly standing: Standing; readonly frames: ReactNode; readonly agent: Props["agent"]; readonly onSend: (message: string) => void; readonly onDismiss: (id: string, note?: string) => void }) {
  const [more, setMore] = useState(false);
  const [note, setNote] = useState("");
  const [dismissing, setDismissing] = useState(false);
  const [why, setWhy] = useState("");
  // What the agent is asked to fix: what blocks a pick of this variant, never another page's failure.
  const failing = standing.state === "fail" ? blocking(standing) : [];
  const fix = () =>
    onSend(
      `${source.label} of page "${page}" fails core's checks:\n${failing
        .map((rule) => `- ${rule.rule}: ${rule.findings.slice(0, 3).map((finding) => finding.message).join(" ")}`)
        .join("\n")}\nFix it with revise_variant, keeping its id "${source.id}". Do not change the prototype itself.`,
    );
  return (
    <Card.Root className="variant-card" data-variant={source.id} data-standing={standing.state}>
      <Card.Header>
        <Stack.Root gap="condensed">
          <Stack.Root direction="row" align="center" gap="condensed" wrap>
            <Text.Root as="h3" className="variant-name">
              {source.label}
            </Text.Root>
            <StandingBadge standing={standing} />
          </Stack.Root>
          <Text.Root as="p" className="variants-small" data-testid="variant-note">
            {source.note}
            {source.like ? ` (like ${variantLabel(source.like)})` : ""}
          </Text.Root>
        </Stack.Root>
      </Card.Header>
      <Card.Body>
        <Stack.Root gap="condensed">
          {frames}
          <ReportList standing={standing} config={config} />
          {source.variant && (
            <Stack.Root direction="row" gap="condensed" wrap>
              {failing.length > 0 && (
                <Button.Root variant="secondary" disabled={!agent.ready} onClick={fix}>
                  <Button.Icon>
                    <Sparkles />
                  </Button.Icon>
                  Ask the agent to fix it
                </Button.Root>
              )}
              <Button.Root variant="ghost" aria-expanded={more} onClick={() => setMore(!more)}>
                <Button.Icon>
                  <Wand2 />
                </Button.Icon>
                More like this
              </Button.Root>
              <Button.Root variant="ghost" aria-expanded={dismissing} onClick={() => setDismissing(!dismissing)}>
                <Button.Icon>
                  <X />
                </Button.Icon>
                Dismiss
              </Button.Root>
            </Stack.Root>
          )}
          {source.variant && dismissing && (
            <form
              className="variant-more"
              onSubmit={(event) => {
                event.preventDefault();
                onDismiss(source.id, why);
              }}
            >
              <Stack.Root gap="condensed">
                <Label.Root htmlFor={`dismiss-${source.id}`}>Why not this one? (optional)</Label.Root>
                <Field.Root id={`dismiss-${source.id}`}>
                  <Field.Textarea value={why} onValueChange={setWhy} rows={2} />
                </Field.Root>
                <Text.Root as="span" tone="muted" className="variants-small">
                  A note is kept with the prototype, so the app can notice when the same thing keeps coming up.
                </Text.Root>
                <div>
                  <Button.Root type="submit" variant="secondary">
                    {`Dismiss ${source.label}`}
                  </Button.Root>
                </div>
              </Stack.Root>
            </form>
          )}
          {source.variant && more && (
            <form
              className="variant-more"
              onSubmit={(event) => {
                event.preventDefault();
                onSend(`More variants like ${source.label} ("${source.note}") of page "${page}"${note.trim() ? `: ${note.trim()}` : "."}\nOffer them with propose_variants, with like: "${source.id}".`);
                setMore(false);
                setNote("");
              }}
            >
              <Stack.Root gap="condensed">
                <Label.Root htmlFor={`more-${source.id}`}>What more of it, or what else?</Label.Root>
                <Field.Root id={`more-${source.id}`}>
                  <Field.Textarea value={note} onValueChange={setNote} rows={2} />
                </Field.Root>
                <Stack.Root direction="row" gap="condensed" align="center" wrap>
                  <Button.Root type="submit" variant="secondary" disabled={!agent.ready}>
                    Ask for more like this
                  </Button.Root>
                  {!agent.ready && (
                    <Text.Root as="span" tone="muted" className="variants-small">
                      {agent.why}
                    </Text.Root>
                  )}
                </Stack.Root>
              </Stack.Root>
            </form>
          )}
          {source.variant && failing.length > 0 && !agent.ready && !more && (
            <Text.Root as="p" tone="muted" className="variants-small">
              {agent.why}
            </Text.Root>
          )}
        </Stack.Root>
      </Card.Body>
    </Card.Root>
  );
}

function PickEntry({ pick, order, canUndo, current, onUndo }: { readonly pick: PickRecord; readonly order: readonly string[]; readonly canUndo: boolean; readonly current: string | undefined; readonly onUndo: () => void }) {
  const rank = (slot: string) => (order.includes(slot) ? order.indexOf(slot) : order.length);
  const changed = canonical(current) !== canonical(pick.after);
  return (
    <li className="variants-pick" data-undone={pick.undone ? "" : undefined}>
      <Text.Root as="p" className="variants-small">
        {pick.at.replace("T", " ").slice(0, 16)}: {Object.entries(pick.slots)
          .sort(([a], [b]) => rank(a) - rank(b))
          .map(([slot, source]) => `${slot} from ${variantLabel(source)}`)
          .join(", ")}
        {pick.undone ? " (undone)" : ""}
      </Text.Root>
      {Object.keys(pick.notes).length > 0 && (
        <Text.Root as="p" tone="muted" className="variants-small">
          {Object.entries(pick.notes)
            .map(([id, note]) => `${variantLabel(id)}: ${note}`)
            .join(" · ")}
        </Text.Root>
      )}
      {canUndo && (
        <Stack.Root direction="row" align="center" gap="condensed" wrap>
          <Button.Root variant="secondary" disabled={changed} onClick={onUndo} data-testid="undo-pick">
            Undo this pick
          </Button.Root>
          {changed && (
            <Text.Root as="span" tone="muted" className="variants-small">
              The page changed after this pick; undoing it would lose those changes.
            </Text.Root>
          )}
        </Stack.Root>
      )}
    </li>
  );
}
