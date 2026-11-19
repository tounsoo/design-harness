import { Alert, Badge, Button, Card, Checkbox, Code, Disclosure, ErrorMessage, Field, Label, Stack, Text } from "@tounsoo/todae";
import { Check, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { BUILT_IN_RULES, ROLE_NAMES, describeMapping, missingRoleEffects, roleOptions, rolePreview, type RoleDraft, type RoleMapping, type RoleName, type RoleOptions } from "@design-harness/core";
import { FrameViewport } from "./Board";
import { useSessions, type MeasureItem, type Measured } from "./sessions";
import { ROLE_WORDS, mappingsOf, roleStanding, togglePart, toggleValue, type RoleState, type RolesState, type StepIssue, type WizardLibrary } from "./wizard-model";

type Props = {
  readonly library: WizardLibrary;
  readonly draft: RoleDraft;
  readonly roles: RolesState;
  readonly onChange: (role: RoleName, next: RoleState) => void;
  /** Core's refusals for this step, shown on the card of the role each names. */
  readonly issues: readonly StepIssue[];
  /** The scheme the previews are drawn in: the app's own, so a preview reads as part of the page. */
  readonly scheme: "light" | "dark";
};

const CONFIDENCE = { high: { tone: "success", text: "High confidence" }, medium: { tone: "warning", text: "Medium confidence" }, low: { tone: "critical", text: "Low confidence" } } as const;

/**
 * Step 3: each role as a card, with the drafted parts drawn live in a
 * sandboxed frame with the library's own styles, core's confidence and
 * evidence for the guess, and what the role could be instead. A person
 * accepts the draft or picks other parts or values; a change needs a reason,
 * as core's `confirmRoles` requires, and a role left with no part shows what
 * `missingRoleEffects` says happens to the rules that select it.
 */
export function WizardRoles({ library, draft, roles, onChange, issues, scheme }: Props) {
  const { description, setup } = library;
  const mappings = useMemo(() => mappingsOf(roles), [roles]);
  const options = useMemo(() => Object.fromEntries(ROLE_NAMES.map((role) => [role, roleOptions(description, role, mappings)])) as Record<RoleName, RoleOptions>, [description, mappings]);
  /** The roles whose options are open: a prop role then also draws every value its prop has, to pick from by eye. */
  const [open, setOpen] = useState<readonly RoleName[]>([]);
  const mappingKey = JSON.stringify(mappings);
  const previews = useMemo(
    () => {
      const items: (MeasureItem & { readonly why?: string })[] = [];
      const whys: Partial<Record<string, string>> = {};
      for (const role of ROLE_NAMES) {
        const preview = rolePreview(description, setup, role, mappings, scheme);
        if (preview.ok) items.push({ id: `role:${role}`, config: preview.config, prototype: preview.prototype });
        else whys[`role:${role}`] = preview.why;
        const choice = options[role];
        if (choice.kind === "values" && open.includes(role)) {
          const all = rolePreview(description, setup, role, { ...mappings, [role]: { components: choice.components.slice(0, 1), prop: { name: choice.prop, values: choice.values, whenMissing: false } } }, scheme);
          if (all.ok) items.push({ id: `all:${role}`, config: all.config, prototype: all.prototype });
        }
      }
      return { items, whys };
    },
    // The mappings by value: a new object with the same choices draws the same previews.
    [description, setup, mappingKey, scheme, open.join("|")],
  );
  const measured = useSessions(previews.items);
  const rules = useMemo(() => [...BUILT_IN_RULES, ...(setup.rules ?? [])], [setup.rules]);

  return (
    <div className="role-grid">
      {ROLE_NAMES.map((role) => (
        <RoleCard
          key={role}
          role={role}
          library={library}
          draft={draft}
          state={roles[role]}
          options={options[role]}
          preview={measured.find((item) => item.id === `role:${role}`)}
          previewWhy={previews.whys[`role:${role}`]}
          all={measured.find((item) => item.id === `all:${role}`)}
          effects={missingRoleEffects(rules, [role])[0]?.rules ?? []}
          issues={issues.filter((issue) => issue.role === role)}
          open={open.includes(role)}
          onOpen={(next) => setOpen((current) => (next ? [...current.filter((item) => item !== role), role] : current.filter((item) => item !== role)))}
          onChange={(next) => onChange(role, next)}
        />
      ))}
    </div>
  );
}

function Preview({ measured, label }: { readonly measured: Measured; readonly label: string }) {
  const frame = measured.state.frames[0];
  if (!frame) return null;
  return <FrameViewport session={measured.session} spec={frame} revision={measured.state.revision} frameState={measured.state.frameStates[frame.key] ?? { state: "waiting" }} scale={1} hidden={false} name={label} fit />;
}

type CardProps = {
  readonly role: RoleName;
  readonly library: WizardLibrary;
  readonly draft: RoleDraft;
  readonly state: RoleState;
  readonly options: RoleOptions;
  readonly preview: Measured | undefined;
  readonly previewWhy: string | undefined;
  readonly all: Measured | undefined;
  readonly effects: readonly { readonly rule: string; readonly description?: string }[];
  readonly issues: readonly StepIssue[];
  readonly open: boolean;
  readonly onOpen: (open: boolean) => void;
  readonly onChange: (next: RoleState) => void;
};

function RoleCard({ role, library, draft, state, options, preview, previewWhy, all, effects, issues, open, onOpen, onChange }: CardProps) {
  const words = ROLE_WORDS[role];
  const guess = draft.guesses.find((item) => item.role === role);
  const missing = draft.missing.find((item) => item.role === role);
  const standing = roleStanding(draft, role, state);
  const id = `role-${role}`;
  const change = (mapping: RoleMapping) => onChange({ mapping, why: state.why, accepted: false });
  const frameState = preview?.state.frames[0] ? preview.state.frameStates[preview.state.frames[0].key]?.state : undefined;
  return (
    <Card.Root className="role-card" data-role={role} data-standing={standing} aria-labelledby={`${id}-title`} role="group">
      <Card.Header>
        <Stack.Root gap="condensed">
          <Stack.Root direction="row" align="center" gap="condensed" wrap>
            <Text.Root as="h3" id={`${id}-title`} className="role-title">
              {words.title}
            </Text.Root>
            {standing === "accepted" && (
              <Badge.Root tone="success" data-testid="role-status">
                Accepted
              </Badge.Root>
            )}
            {standing === "corrected" && (
              <Badge.Root tone="info" data-testid="role-status">
                Changed by you
              </Badge.Root>
            )}
            {standing === "none" && (
              <Badge.Root tone="warning" data-testid="role-status">
                {guess ? "No part, by your choice" : "No part found"}
              </Badge.Root>
            )}
            {standing === "drafted" && guess && (
              <Badge.Root tone={CONFIDENCE[guess.confidence].tone} data-testid="role-status">
                {CONFIDENCE[guess.confidence].text}
              </Badge.Root>
            )}
          </Stack.Root>
          <Text.Root as="p" tone="muted">
            {words.about}
          </Text.Root>
        </Stack.Root>
      </Card.Header>
      <Card.Body className="role-card-body">
        <Stack.Root gap="normal">
          <figure className="role-preview" data-testid="role-preview" data-state={frameState ?? "none"}>
            {preview ? (
              <Preview measured={preview} label={`${words.title} preview`} />
            ) : (
              <Text.Root as="p" tone="muted" className="role-preview-none">
                {previewWhy ?? "Nothing to draw."}
              </Text.Root>
            )}
            <figcaption>
              <Text.Root as="span" variant="label">
                {state.mapping.components.length === 0 ? "Maps to" : `Drawn live from ${library.description.package}`}
              </Text.Root>
              <Text.Root as="span" weight="medium" className="role-mapping" data-testid="role-mapping">
                {state.mapping.components.length === 0 ? "No part" : describeMapping(state.mapping)}
              </Text.Root>
            </figcaption>
          </figure>

          {guess && (standing === "drafted" || standing === "accepted") && (
            <div className="role-evidence">
              <Text.Root as="span" variant="label">
                Why core drafted this
              </Text.Root>
              <ul>
                {guess.evidence.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          {!guess && missing && (
            <Text.Root as="p" tone="muted" data-testid="role-missing-why">
              The draft found no part: {missing.why}.
            </Text.Root>
          )}
          {standing === "none" && (
            <Alert.Root tone="warning" data-testid="role-effects">
              <Alert.Title>{effects.length === 0 ? "No rule reads this role" : `${effects.length} ${effects.length === 1 ? "rule leaves" : "rules leave"} the project`}</Alert.Title>
              <Alert.Description>
                {effects.length === 0 ? (
                  "Leaving it with no part changes no check."
                ) : (
                  <>
                    <Text.Root as="p">A rule that selects a role with no part could never fire, and core refuses a project that holds one. So with no part here, these are left out:</Text.Root>
                    <ul className="role-effects">
                      {effects.map((effect) => (
                        <li key={effect.rule}>
                          {effect.description ?? effect.rule} <Code.Root>{effect.rule}</Code.Root>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </Alert.Description>
            </Alert.Root>
          )}

          <Disclosure.Root className="role-options" open={open} onToggle={(event) => onOpen(event.currentTarget.open)}>
            <Disclosure.Summary>{options.kind === "values" ? "Pick other values" : "Pick another part"}</Disclosure.Summary>
            <Stack.Root gap="condensed" className="role-options-body">
              {options.kind === "none" && <Text.Root as="p">Nothing else to pick: {options.why}.</Text.Root>}
              {options.kind === "parts" && (
                <>
                  <Text.Root as="p" tone="muted">
                    Check every part that is {/^[aeiou]/i.test(words.title) ? "an" : "a"} {words.title.toLowerCase()} in your product. The preview above draws what is checked.
                  </Text.Root>
                  <div className="option-list" role="group" aria-label={`Parts for ${words.title}`}>
                    {options.parts.map((part) => (
                      <Checkbox.Root key={part} checked={state.mapping.components.includes(part)} onCheckedChange={(on) => change(togglePart(options, state.mapping, part, on))}>
                        {part}
                      </Checkbox.Root>
                    ))}
                  </div>
                </>
              )}
              {options.kind === "values" && (
                <>
                  <Text.Root as="p" tone="muted">
                    Every <Code.Root>{options.prop}</Code.Root> of {options.components.join(", ")}, drawn below. Check each one that marks {/^[aeiou]/i.test(words.title) ? "an" : "a"} {words.title.toLowerCase()}.
                  </Text.Root>
                  {all && (
                    <div className="role-preview role-preview-all" data-testid="role-all-values">
                      <Preview measured={all} label={`Every ${options.prop} of ${options.components[0] ?? "the part"}`} />
                    </div>
                  )}
                  <div className="option-list" role="group" aria-label={`Values for ${words.title}`}>
                    {options.values.map((value) => (
                      <Checkbox.Root key={value} checked={state.mapping.prop?.name === options.prop && state.mapping.prop.values.includes(value)} onCheckedChange={(on) => change(toggleValue(options, state.mapping, value, on))}>
                        {value}
                      </Checkbox.Root>
                    ))}
                  </div>
                  {state.mapping.prop && (
                    <Checkbox.Root checked={state.mapping.prop.whenMissing} onCheckedChange={(on) => state.mapping.prop && change({ ...state.mapping, prop: { ...state.mapping.prop, whenMissing: on } })}>
                      One with no {options.prop} counts too
                    </Checkbox.Root>
                  )}
                </>
              )}
            </Stack.Root>
          </Disclosure.Root>

          {(standing === "corrected" || standing === "none") && (
            <Field.Group>
              <Label.Root htmlFor={`${id}-why`}>{standing === "none" ? "Why the library has no part for it" : "Why the change"}</Label.Root>
              <Field.Root id={`${id}-why`} invalid={issues.some((issue) => issue.path.endsWith(".why"))}>
                <Field.Textarea value={state.why} onValueChange={(why) => onChange({ ...state, why })} rows={2} placeholder={standing === "none" ? "This product has none." : "Say what the draft got wrong."} />
              </Field.Root>
              <Text.Root as="span" tone="muted" className="role-hint">
                The reason is kept with the project, beside the mapping.
              </Text.Root>
            </Field.Group>
          )}
          {issues.length > 0 && (
            <ErrorMessage.Root id={`${id}-problem`} role="alert">
              {issues.map((issue) => issue.message).join(" ")}
            </ErrorMessage.Root>
          )}
        </Stack.Root>
      </Card.Body>
      <Card.Footer>
        {standing === "drafted" || standing === "accepted" ? (
          <Button.Root type="button" variant="secondary" pressed={standing === "accepted"} onPressedChange={(accepted) => onChange({ ...state, accepted })} data-testid="role-accept">
            {standing === "accepted" && (
              <Button.Icon>
                <Check />
              </Button.Icon>
            )}
            {standing === "accepted" ? "Accepted" : "Accept"}
          </Button.Root>
        ) : guess ? (
          <Button.Root type="button" variant="ghost" onClick={() => onChange({ mapping: guess.mapping, why: "", accepted: false })}>
            <Button.Icon>
              <RotateCcw />
            </Button.Icon>
            Back to the draft
          </Button.Root>
        ) : (
          <Text.Root as="span" tone="muted">
            Pick a part above, or say why there is none.
          </Text.Root>
        )}
      </Card.Footer>
    </Card.Root>
  );
}
