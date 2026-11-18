import { Alert, Badge, Button, Card, EmptyState, Field, Label, RadioGroup, Stack, Table, Text } from "@tounsoo/todae";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CURRENT, formatSpec, parseJson, recombine, variantLabel, variantPrototype, type CheckReport, type PickRecord, type ProjectConfig, type Prototype, type Recombination, type Variant } from "@design-harness/core";
import type { PrototypeRecord } from "../store/project-file";
import { FrameCard } from "./Board";
import { useSessions, type Measured } from "./sessions";

/**
 * Variants side by side, and the person's pick. For the page being
 * compared, the page as it is and each variant the agent offered render in
 * measured frames of their own, every scenario and view (one scenario
 * shown at a time, the rest measured hidden), with core's whole report
 * under each. A variant that fails a rule says so in core's words; it can
 * be inspected and sent to the agent to fix, but not picked until it
 * passes. The person picks each slot of the page type from any passing
 * source; core recombines them (`recombine`), the combination is measured
 * and checked like any page, and Apply makes it a new revision, recorded
 * with where each slot came from and undoable. Only the person applies a
 * pick: nothing the agent sends reaches this view's actions.
 */

export type ApplyPick = { readonly page: string; readonly slots: Readonly<Record<string, string>>; readonly notes: Readonly<Record<string, string>>; readonly before: string; readonly after: string; readonly prototype: Prototype };

type Props = {
  readonly config: ProjectConfig;
  readonly record: PrototypeRecord | undefined;
  /** Whether the agent can take a message now, and why not. */
  readonly agent: { readonly ready: boolean; readonly why: string };
  readonly onApply: (pick: ApplyPick) => void;
  readonly onUndo: (index: number) => void;
  readonly onDismiss: (id: string) => void;
  /** Sends a message to the agent, as the person's. */
  readonly onSend: (message: string) => void;
  /** Puts a message in the chat's box for the person to edit and send. */
  readonly onPrefill: (message: string) => void;
};

type Source = { readonly id: string; readonly label: string; readonly note: string; readonly like?: string; readonly prototype: Prototype; readonly variant?: Variant };

/** Where a source stands: still measuring, failing (with core's failing rules), or passing every rule. */
type Standing = { readonly state: "measuring"; readonly text: string } | { readonly state: "fail" | "incomplete"; readonly report: CheckReport } | { readonly state: "pass"; readonly report: CheckReport };

function standingOf(item: Measured | undefined): Standing {
  if (!item) return { state: "measuring", text: "not measured" };
  if (item.measurement.state === "measuring") return { state: "measuring", text: `measuring ${item.measurement.answered} of ${item.measurement.total}` };
  const report = item.state.report;
  if (!report) return { state: "measuring", text: "checking" };
  return report.status === "pass" ? { state: "pass", report } : { state: report.status, report };
}

const canonical = (text: string | undefined): string => {
  if (text === undefined) return "";
  const parsed = parseJson(text);
  return parsed.ok ? formatSpec(parsed.value) : text;
};

/** Frames wrap in a column, so the widest view sets the scale. */
const FRAME_WIDTH = (config: ProjectConfig) => Math.max(1, ...config.views.map((view) => view.width));

export function VariantsView({ config, record, agent, onApply, onUndo, onDismiss, onSend, onPrefill }: Props) {
  const prototype = record?.prototype;
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

  const grid = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    const element = grid.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, [sources.length]);
  const columns = Math.max(1, Math.min(sources.length, 4, Math.floor(width / 280)));
  const columnWidth = (width - 16 * (columns - 1)) / columns - 34;
  const scale = Math.max(0.08, Math.min(0.5, columnWidth / FRAME_WIDTH(config)));

  if (!record || !prototype) return null;
  if (prototype.format !== "spec") {
    return (
      <Stack.Root gap="normal" className="variants" data-testid="variants">
        <Text.Root as="h2" className="variants-title">
          Variants
        </Text.Root>
        <Alert.Root tone="info" data-testid="variants-tsx">
          <Alert.Title>Variants are for spec prototypes</Alert.Title>
          <Alert.Description>
            This prototype is TSX. Picking slots from several variants needs each page as data, which a spec prototype is and code is not, so variants and slot picks work only on spec prototypes. Make a new spec prototype (New prototype) to compare variants.
          </Alert.Description>
        </Alert.Root>
      </Stack.Root>
    );
  }

  const standings = new Map(sources.map((source) => [source.id, standingOf(byId.get(source.id))]));
  const pickable = (id: string) => standings.get(id)?.state === "pass";
  const comboStanding = combined ? standingOf(byId.get("combination")) : null;
  const blocked = Object.values(chosen).filter((id) => id !== CURRENT && !pickable(id));
  const applyWhy =
    !combination ? "Pick at least one slot from a variant." : !combination.ok ? combination.error : !combined ? "These picks give the page as it is." : blocked.length > 0 ? `${[...new Set(blocked)].map(variantLabel).join(", ")} does not pass every rule yet.` : comboStanding?.state === "measuring" ? `The combination is ${comboStanding.text}.` : comboStanding?.state !== "pass" ? "The combination does not pass every rule; pick differently." : null;
  const usedNotes = Object.fromEntries([...new Set(Object.values(chosen))].filter((id) => id !== CURRENT).map((id) => [id, sources.find((source) => source.id === id)?.note ?? ""]));
  const picksHere = (state?.picks ?? []).map((pick, index) => ({ pick, index })).filter(({ pick }) => pick.page === page);
  const undoable = [...picksHere].reverse().find(({ pick }) => !pick.undone);

  const frameRow = (item: Measured | undefined, label: string) =>
    item ? (
      <div className="variant-frames">
        {item.state.frames.map((spec) => (
          <FrameCard
            key={spec.key}
            session={item.session}
            spec={spec}
            revision={item.state.revision}
            frameState={item.state.frameStates[spec.key] ?? { state: "waiting" }}
            scale={scale}
            focused={false}
            hidden={spec.scenario.id !== scenario}
            selected={false}
            label={label}
          />
        ))}
      </div>
    ) : null;

  return (
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
                    {item}
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
                    {item.id}
                  </option>
                ))}
              </Field.Select>
            </Field.Root>
          </Stack.Root>
        )}
      </Stack.Root>

      {!page ? (
        <EmptyState.Root data-testid="variants-empty">
          <EmptyState.Title>No variants yet</EmptyState.Title>
          <EmptyState.Description>Ask the agent for two to four variants of a page. Each is a whole page built from the inventories and layouts, shown here side by side with core&apos;s checks; you pick each slot from the one you like.</EmptyState.Description>
          <EmptyState.Actions>
            <Button.Root variant="secondary" onClick={() => onPrefill(`Give me 3 variants of the ${prototype.pages[0]?.id ?? ""} page, each different in one way, so I can compare them.`)}>
              Ask the agent for variants
            </Button.Root>
          </EmptyState.Actions>
        </EmptyState.Root>
      ) : (
        <>
          <Text.Root as="p" tone="muted" className="variants-small">
            Page <strong>{page}</strong> ({pageType?.id ?? entry?.pageType}): the page as it is and {sources.length - 1} {sources.length === 2 ? "variant" : "variants"}, each measured in every scenario and view. A variant that fails a rule cannot be picked until it passes.
          </Text.Root>
          <div className="variants-grid" ref={grid} style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
            {sources.map((source) => (
              <SourceCard key={source.id} source={source} page={page} standing={standings.get(source.id) as Standing} frames={frameRow(byId.get(source.id), source.label)} agent={agent} onSend={onSend} onDismiss={onDismiss} />
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
                    <ReportList standing={comboStanding as Standing} />
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
                  onApply({ page, slots: combined.slots, notes: usedNotes, before: currentText, after: combined.spec, prototype: combined.prototype });
                  setPicks({});
                }}
              >
                Apply this pick
              </Button.Root>
              {applyWhy && (
                <Text.Root as="span" tone="muted" className="variants-small" data-testid="apply-why">
                  {applyWhy}
                </Text.Root>
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
  );
}

function StandingBadge({ standing }: { readonly standing: Standing }) {
  if (standing.state === "measuring") return <Badge.Root tone="info">{standing.text}</Badge.Root>;
  if (standing.state === "pass") return <Badge.Root tone="success">passes every rule</Badge.Root>;
  const failing = standing.report.rules.filter((rule) => rule.status === "fail").length;
  return <Badge.Root tone={standing.state === "fail" ? "critical" : "neutral"}>{standing.state === "fail" ? `fails ${failing} ${failing === 1 ? "rule" : "rules"}` : "incomplete"}</Badge.Root>;
}

/** Core's report under a source: every failing rule with its findings, word for word. */
function ReportList({ standing }: { readonly standing: Standing }) {
  if (standing.state === "measuring") return null;
  const failing = standing.report.rules.filter((rule) => rule.status !== "pass");
  if (failing.length === 0) {
    return (
      <Text.Root as="p" tone="muted" className="variants-small" data-testid="variant-report">
        Every rule passes: {standing.report.rules.length} rules, the rendered ones measured.
      </Text.Root>
    );
  }
  return (
    <ul className="variant-report" data-testid="variant-report" aria-label="What core found">
      {failing.map((rule) => (
        <li key={rule.rule} data-rule={rule.rule}>
          <Text.Root as="span" className="rule-id">
            {rule.rule}
          </Text.Root>{" "}
          <Badge.Root tone={rule.status === "fail" ? "critical" : "neutral"}>{rule.status}</Badge.Root>
          {rule.findings.slice(0, 3).map((finding, index) => (
            <Text.Root as="p" key={index} className="variants-small finding-message" data-testid="variant-finding">
              {finding.message}
            </Text.Root>
          ))}
          {rule.findings.length > 3 && (
            <Text.Root as="p" tone="muted" className="variants-small">
              and {rule.findings.length - 3} more
            </Text.Root>
          )}
        </li>
      ))}
    </ul>
  );
}

function SourceCard({ source, page, standing, frames, agent, onSend, onDismiss }: { readonly source: Source; readonly page: string; readonly standing: Standing; readonly frames: ReactNode; readonly agent: Props["agent"]; readonly onSend: (message: string) => void; readonly onDismiss: (id: string) => void }) {
  const [more, setMore] = useState(false);
  const [note, setNote] = useState("");
  const failing = standing.state === "fail" || standing.state === "incomplete" ? standing.report.rules.filter((rule) => rule.status === "fail") : [];
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
          <ReportList standing={standing} />
          {source.variant && (
            <Stack.Root direction="row" gap="condensed" wrap>
              {failing.length > 0 && (
                <Button.Root variant="secondary" disabled={!agent.ready} onClick={fix}>
                  Ask the agent to fix it
                </Button.Root>
              )}
              <Button.Root variant="ghost" aria-expanded={more} onClick={() => setMore(!more)}>
                More like this
              </Button.Root>
              <Button.Root variant="ghost" onClick={() => onDismiss(source.id)}>
                Dismiss
              </Button.Root>
            </Stack.Root>
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
