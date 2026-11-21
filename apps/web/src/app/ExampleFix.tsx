import { Alert, Button, Text } from "@tounsoo/todae";
import type { Finding, ProjectConfig, Prototype } from "@design-harness/core";
import { useEffect, useMemo, useState } from "react";
import type { ExampleFix, ExampleFixes } from "../review/fix-examples";
import { tagOf } from "../runtime/tags";
import { FrameViewport } from "./Board";
import { useSessions } from "./sessions";
import { exampleLabel, scenarioName, viewLabel } from "./words";

/** A prototype offered as a "Not allowed" example, and core's findings for the rule it would show, with the change in place. */
export type ChoiceScreen = { readonly prototype: Prototype; readonly findings: readonly Finding[] };

/**
 * The screen where the rule catches a prototype offered as a "Not allowed"
 * example, drawn small beside the choice: one scenario at one view, in a
 * frame of its own with the change in place, as an example's own screen is
 * drawn, with what core's finding points at outlined. A name cannot say
 * what the prototype looks like or where the rule bites, so this is the one
 * picture among the choices. It is a picture only: nothing in it can be
 * pressed or focused, it is hidden from a screen reader (the words beside
 * it say which screen it is), and no check reads it. A finding with no
 * page to draw, such as one about a whole flow, gets no picture.
 */
function ChoiceThumb({ name, screen, config }: { readonly name: string; readonly screen: ChoiceScreen; /** The project with the proposal applied. */ readonly config: ProjectConfig }) {
  const { prototype, findings } = screen;
  const finding = findings.find((item) => item.scenario !== undefined && item.view !== undefined) ?? findings[0];
  const page = finding?.page ?? finding?.targets?.find((target) => target.page !== undefined)?.page;
  const scenario = prototype.scenarios.find((item) => item.id === finding?.scenario) ?? (page !== undefined ? prototype.scenarios.find((item) => item.page === page) : undefined);
  // The view core's finding is in, else the narrowest, where a page reads at close to its own size.
  const view = config.views.find((item) => item.name === finding?.view) ?? [...config.views].sort((a, b) => a.width - b.width)[0];
  const items = useMemo(() => (scenario && view ? [{ id: `choice:${name}`, config: { ...config, views: [view] }, prototype: { ...prototype, scenarios: [scenario] } }] : []), [name, config, prototype, scenario, view]);
  const [measured] = useSessions(items);
  const [width, setWidth] = useState(0);
  const frame = measured?.state.frames[0];
  const frameState = measured && frame ? (measured.state.frameStates[frame.key] ?? { state: "waiting" as const }) : undefined;
  const shot = frameState?.state === "measured" ? frameState : undefined;
  const element = finding && finding.scenario === scenario?.id && finding.view === view?.name ? finding.element : undefined;
  const tags = useMemo(() => {
    if (!shot || element !== undefined) return [];
    const wanted = new Set(findings.flatMap((item) => item.targets ?? []).filter((target) => target.page === undefined || target.page === scenario?.page).flatMap((target) => tagOf(target) ?? []));
    return shot.tags.filter((tag) => wanted.has(tag));
  }, [shot, element, findings, scenario?.page]);
  useEffect(() => {
    if (!measured || !frame || !shot) return;
    if (element === undefined && tags.length > 0) measured.session.outline(frame.key, tags);
    else measured.session.highlight(frame.key, element ?? null);
  }, [measured?.session, frame?.key, shot, element, tags]);
  if (!scenario || !view) return null;
  const outlined = shot !== undefined && (element !== undefined || tags.length > 0);
  return (
    <>
      <div
        className="fix-thumb"
        data-testid="fix-thumb"
        aria-hidden="true"
        inert
        ref={(node) => {
          if (node) setWidth(node.clientWidth);
        }}
      >
        {measured && frame && frameState && width > 0 && <FrameViewport session={measured.session} spec={frame} revision={measured.state.revision} frameState={frameState} scale={width / view.width} hidden={false} name={`${name}, as an example: ${frame.scenario.id} at ${frame.view.name}`} fit />}
      </div>
      <Text.Root as="p" tone="muted" className="review-small fix-where" data-testid="fix-where" data-outlined={outlined ? "" : undefined}>
        {scenarioName(scenario)}, {viewLabel(view.name).toLowerCase()}, with this change in place.{outlined ? " The outlined part is what the rule catches." : ""}
      </Text.Root>
    </>
  );
}

/**
 * Fixing a proposal's examples yourself, when they are why it can't be
 * accepted: take out an example that isn't needed, or put one of the
 * project's own prototypes in its place. Only prototypes core's check says
 * would do the job are offered; each choice is a revision of the proposal by
 * you, kept in its history, and core judges the examples again after it.
 * Each way out is a row of its own: what it is, then the button that does
 * it.
 */
export function ExampleFixCard({ fixes, config, screens = {}, onFix }: { readonly fixes: ExampleFixes; /** The project with the proposal applied, which a choice's screen is drawn under. */ readonly config: ProjectConfig; /** What the rule catches in each choice, by the prototype's name, for its screen. */ readonly screens?: Readonly<Record<string, ChoiceScreen>>; readonly onFix: (fix: ExampleFix) => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const side = fixes.side === "pass" ? "Allowed" : "Not allowed";
  const target = fixes.target;
  const run = async (fix: ExampleFix) => {
    setBusy(true);
    const refused = await onFix(fix);
    setBusy(false);
    setProblem(refused);
  };
  const lead = target
    ? fixes.choices.length > 0
      ? `You can fix this yourself: put one of your prototypes in place of the “${side}” example “${exampleLabel(target.name)}”${fixes.canRemove ? ", or take that example out, since the proposal has enough without it" : ""}.`
      : fixes.canRemove
        ? `You can fix this yourself: the proposal has enough examples without “${exampleLabel(target.name)}”, so you can take it out.`
        : `None of your prototypes would do as the “${side}” example in place of “${exampleLabel(target.name)}”${fixes.side === "fail" ? ": none is caught by this rule and by no other" : ": none passes every rule with this change"}. Ask the agent for another example, or decline it.`
    : fixes.choices.length > 0
      ? `You can fix this yourself: add one of your prototypes as its “${side}” example.`
      : `None of your prototypes would do as its “${side}” example. Ask the agent for one, or decline it.`;
  const removes = target !== undefined && fixes.canRemove;
  const offers = fixes.choices.length > 0 || removes;
  return (
    <div className="review-fix" data-testid="example-fix" data-side={fixes.side} data-example={target?.name}>
      <Text.Root as="p" {...(offers ? { weight: "medium" as const } : {})} data-testid="example-fix-lead">
        {lead}
      </Text.Root>
      {offers && (
        <div className="fix-choices">
          {fixes.choices.length > 0 && (
            <ul className="review-fix-choices" aria-label={`Your prototypes that would do as the “${side}” example`}>
              {fixes.choices.map((choice) => {
                const screen = screens[choice.name];
                return (
                  <li key={choice.name} className="fix-choice" data-prototype={choice.name}>
                    <Text.Root as="p" weight="medium" className="fix-choice-name">
                      {choice.name}
                    </Text.Root>
                    {screen && <ChoiceThumb name={choice.name} screen={screen} config={config} />}
                    <Button.Root
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void run({ kind: "use", prototype: choice.name, side: fixes.side, ...(fixes.rule !== undefined ? { rule: fixes.rule } : {}), ...(target ? { replaces: target } : {}) })}
                    >
                      {target ? `Use “${choice.name}” instead` : `Add “${choice.name}”`}
                    </Button.Root>
                  </li>
                );
              })}
            </ul>
          )}
          {removes && (
            <div className="fix-choice" data-testid="fix-remove">
              <div className="fix-choice-words">
                <Text.Root as="p" weight="medium">
                  Go without the example
                </Text.Root>
                <Text.Root as="p" tone="muted" className="review-small">
                  The proposal has enough examples without it.
                </Text.Root>
              </div>
              <Button.Root variant="secondary" disabled={busy} onClick={() => void run({ kind: "remove", example: target })}>
                {`Take out “${exampleLabel(target.name)}”`}
              </Button.Root>
            </div>
          )}
        </div>
      )}
      {fixes.choices.length > 0 && (
        <Text.Root as="p" tone="muted" className="review-small">
          {fixes.side === "fail" ? "Each of these is caught by the rule and by no other, with this change in place." : "Each of these passes every rule, with this change in place."} It is used as it is now; your choice is kept in the proposal&apos;s history.
        </Text.Root>
      )}
      {problem && (
        <Alert.Root tone="warning" data-testid="example-fix-refused">
          <Alert.Description>It wasn&apos;t changed: {problem}</Alert.Description>
        </Alert.Root>
      )}
    </div>
  );
}
