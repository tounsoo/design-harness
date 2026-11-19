import { Alert, Badge, Button, Card, Checkbox, Code, DataList, Disclosure, ErrorMessage, Field, Form, Label, Loader, RadioGroup, Stack, Steps, Text, useAppearance, type StepsStatus } from "@tounsoo/todae";
import { ArrowLeft, ArrowRight, Check, Plus, RotateCcw, Shapes, Trash2, Upload, X } from "lucide-react";
import { useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ROLE_NAMES,
  STARTER_CAPS,
  STARTER_CAP_NOTES,
  STARTER_PAGE_TYPES,
  STARTER_VIEWS,
  buildProject,
  defaultStarterRules,
  describeMapping,
  describeRule,
  draftRoles,
  formatIssues,
  parseLibraryDescription,
  projectId,
  projectNameIssues,
  roleComponents,
  type BuiltProject,
  type LibrarySetup,
  type ProjectConfig,
  type RoleName,
  type StarterRules,
} from "@design-harness/core";
import { FRAME_REACT, SHIPPED_LIBRARIES } from "../libraries/registry";
import { resolvePackages } from "../runtime/package-source";
import type { LoadNote } from "../store/migrate";
import type { PrototypeRecord } from "../store/project-file";
import { FrameCard } from "./Board";
import { LibraryRequestForm } from "./LibraryRequest";
import { blankPrototype } from "./new-prototype";
import { packageSource } from "./runtime";
import { useSessions } from "./sessions";
import { WizardRoles } from "./WizardRoles";
import { ROLE_WORDS, STEP, STEPS, answersOf, componentsOf, exclusionIsDraft, initialExclusion, initialRoles, mappingsOf, roleStanding, routeIssue, type RoleState, type StepIssue, type WizardLibrary, type WizardState } from "./wizard-model";
import { scenarioLabel } from "./words";

/** A project the wizard made: its config, its first prototype, and what to say once it is open. */
export type CreatedProject = { readonly config: ProjectConfig; readonly prototypes: readonly PrototypeRecord[]; readonly note: LoadNote };

type Props = {
  /** Ids of the projects in the store, so the new one's is its own. */
  readonly takenIds: readonly string[];
  /** Whether the Tally example is already in the store. */
  readonly hasTally: boolean;
  readonly onCancel: () => void;
  readonly onCreate: (created: CreatedProject) => Promise<void>;
  /** Adds the Tally example to the store, when it is not there, and opens it. */
  readonly onExample: () => Promise<void>;
};

const IMPORT = "import";
const EMPTY: WizardState = { name: "", library: null, roles: null, exclusion: { props: [], why: "", accepted: false }, components: null, rules: defaultStarterRules() };

const statusOf = (index: number, step: number): StepsStatus => (index < step ? "done" : index === step ? "current" : "pending");
const listOf = (text: string) => text.split(/[\s,]+/).map((item) => item.trim()).filter((item) => item !== "");

/**
 * New project: a designer names a product, picks the component library it
 * is built with, confirms by eye which of the library's parts play each
 * role the rules read, confirms which style props stay out of specs, sets
 * the starting rule inputs, and creates the project with a starter
 * prototype on the board.
 *
 * Built after Todae's wizard recipe: a Steps list for where the person is,
 * a Form per step, focus moved to each step's heading. One thing differs:
 * only the current step is mounted, since its previews are live frames and
 * a frame in a hidden form has no viewport to render in; the answers live
 * here, so going back and forth keeps them.
 *
 * Nothing here decides what is valid. Each step shows what core's
 * `buildProject` refuses of its answers, and Create stores only a config
 * that came back from it.
 */
export function ProjectWizard({ takenIds, hasTally, onCancel, onCreate, onExample }: Props) {
  const [step, setStep] = useState(0);
  const [state, setState] = useState(EMPTY);
  /** The steps whose Next was pressed: their refusals show from then on, and clear as they are fixed. */
  const [asked, setAsked] = useState<readonly number[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [libraryProblems, setLibraryProblems] = useState<readonly string[]>([]);
  const [checking, setChecking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const scheme = useAppearance();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  // Once a step shows, its heading takes focus: the button pressed is gone, and the heading says where the person is.
  useLayoutEffect(() => {
    if (moved.current) heading.current?.focus();
  }, [step]);
  const go = (index: number) => {
    moved.current = true;
    setFailed(null);
    setStep(index);
  };

  const description = state.library?.description;
  const draft = useMemo(() => (description ? draftRoles(description) : null), [description]);
  // Core's verdict on the answers as they stand. Deferred, so typing a reason is not held up by it.
  const answers = useMemo(() => answersOf(state, draft, takenIds), [state, draft, takenIds]);
  const settled = useDeferredValue(answers);
  const built = useMemo(() => (settled ? buildProject(settled) : null), [settled]);
  // Before a library is picked there is nothing to build, and the name is all core can judge.
  const issues: readonly StepIssue[] = built ? (built.ok ? [] : built.error.map(routeIssue)) : projectNameIssues(state.name).map(routeIssue);
  const issuesOf = (index: number) => (asked.includes(index) ? issues.filter((issue) => issue.step === index) : []);

  /** Next: this step's answers, judged now, and on to the next step when core refuses none of them. */
  const next = () => {
    setAsked((current) => (current.includes(step) ? current : [...current, step]));
    const now = answersOf(state, draft, takenIds);
    const refused = now ? buildProject(now) : { ok: false as const, error: projectNameIssues(state.name) };
    const mine = refused.ok ? [] : refused.error.map(routeIssue).filter((issue) => issue.step === step);
    if (mine.length === 0) go(step + 1);
  };

  const setLibrary = (library: WizardLibrary) => {
    const drafted = draftRoles(library.description);
    setState((current) => ({ ...current, library, roles: initialRoles(drafted), exclusion: initialExclusion(drafted), components: null }));
    setLibraryProblems([]);
  };
  const pick = (id: string | null) => {
    setPicked(id);
    setLibraryProblems([]);
    const shipped = SHIPPED_LIBRARIES.find((library) => library.id === id);
    if (!shipped) {
      setState((current) => ({ ...current, library: null, roles: null }));
      return;
    }
    setLoading(true);
    shipped.describe().then(
      (described) => {
        setLibrary({ source: `shipped:${shipped.id}`, name: `${shipped.name} ${shipped.version}`, description: described, setup: shipped.setup, notes: shipped.notes });
        setLoading(false);
      },
      (error: unknown) => {
        setLibraryProblems([`The description of ${shipped.name} could not be loaded: ${error instanceof Error ? error.message : String(error)}`]);
        setLoading(false);
      },
    );
  };
  const importFile = async (file: File) => {
    let json: unknown;
    try {
      json = JSON.parse(await file.text());
    } catch (error) {
      setLibraryProblems([`${file.name} is not JSON: ${error instanceof Error ? error.message : String(error)}`]);
      return;
    }
    const parsed = parseLibraryDescription(json);
    if (!parsed.ok) {
      setLibraryProblems([`${file.name} is not a library description, the file describe-library.mjs writes:`, ...formatIssues(parsed.error.slice(0, 8)).split("\n"), ...(parsed.error.length > 8 ? [`and ${parsed.error.length - 8} more.`] : [])]);
      return;
    }
    // A description of a library this deployment ships starts from that library's setup.
    const shipped = SHIPPED_LIBRARIES.find((library) => library.package === parsed.value.package && library.version === parsed.value.version);
    setLibrary({ source: "imported", name: `${parsed.value.package} ${parsed.value.version}`, description: parsed.value, setup: shipped?.setup ?? { react: FRAME_REACT }, notes: [`Read from ${file.name}: ${Object.keys(parsed.value.parts).length} parts.`] });
  };
  const setSetup = (change: (setup: LibrarySetup) => LibrarySetup) => setState((current) => (current.library ? { ...current, library: { ...current.library, setup: change(current.library.setup) } } : current));

  /** Leaving the library step: this deployment must be able to load the library into a frame, or nothing after this step could be shown. */
  const checkLibrary = async () => {
    const library = state.library;
    if (!library) {
      setLibraryProblems([picked === IMPORT ? "Choose a description file first." : "Pick a library first."]);
      return;
    }
    const { root } = library.setup;
    if (root && !(root.component in library.description.parts)) {
      setLibraryProblems([`${library.description.package} ${library.description.version} has no part named ${root.component} to render every page inside.`]);
      return;
    }
    setChecking(true);
    try {
      await resolvePackages({ package: library.description.package, version: library.description.version, react: library.setup.react, ...(library.setup.stylesheets ? { stylesheets: library.setup.stylesheets } : {}), roles: mappingsOf(initialRoles(draftRoles(library.description))) }, packageSource(), { spec: true });
      setLibraryProblems([]);
      go(STEP.roles);
    } catch (error) {
      setLibraryProblems([
        `This deployment cannot render ${library.name}: ${error instanceof Error ? error.message : String(error)}.`,
        "A project on it could be checked but never drawn, so the wizard stops here. Ask for the library to be added (below), or pick one it ships.",
      ]);
    } finally {
      setChecking(false);
    }
  };

  const setRole = (role: RoleName, value: RoleState) => setState((current) => (current.roles ? { ...current, roles: { ...current.roles, [role]: value } } : current));
  const setRules = (change: (rules: StarterRules) => StarterRules) => setState((current) => ({ ...current, rules: change(current.rules) }));

  const create = async (project: BuiltProject) => {
    if (creating) return;
    setCreating(true);
    setFailed(null);
    const { config, starter } = project;
    const record: PrototypeRecord = starter.ok ? { projectId: config.id, id: "starter", name: "Starter", prototype: starter.value } : { projectId: config.id, id: "first", name: "First prototype", prototype: blankPrototype() };
    const note: LoadNote = starter.ok
      ? { tone: "info", title: `${config.name} was created`, text: `It is built with ${config.library.package} ${config.library.version}, with ${config.rules.length} rules in force. Its starter prototype is on the canvas: describe a change to the agent, or edit it in the code view.` }
      : { tone: "warning", title: `${config.name} was created, without a starter page`, text: starter.error };
    try {
      await onCreate({ config, prototypes: [record], note });
    } catch (error) {
      setFailed(`The project was not saved: ${error instanceof Error ? error.message : String(error)}`);
      setCreating(false);
    }
  };

  const title = (index: number, lead: ReactNode) => (
    <div className="wizard-head">
      <Text.Root as="h2" id={`${headingId}-${index}`} ref={heading} tabIndex={-1} className="wizard-title">
        <Text.Root as="span" variant="label" className="wizard-count">
          Step {index + 1} of {STEPS.length}
        </Text.Root>
        {TITLES[index]}
      </Text.Root>
      <Text.Root as="p" tone="muted" className="wizard-lead">
        {lead}
      </Text.Root>
    </div>
  );
  const actions = (submit: ReactNode, aside?: ReactNode) => (
    <div className="wizard-actions">
      {step > 0 && (
        <Button.Root type="button" variant="secondary" aria-disabled={creating || undefined} onClick={() => !creating && go(step - 1)}>
          <Button.Icon>
            <ArrowLeft />
          </Button.Icon>
          Back
        </Button.Root>
      )}
      {submit}
      {aside}
    </div>
  );
  const nextButton = (label = "Next") => (
    <Button.Root type="submit" variant="primary">
      {label}
      <Button.Icon>
        <ArrowRight />
      </Button.Icon>
    </Button.Root>
  );
  const problems = (list: readonly StepIssue[], field?: string) => {
    const mine = field === undefined ? list : list.filter((issue) => issue.path === field);
    return mine.length > 0 ? (
      <ErrorMessage.Root id={`${headingId}-problem-${field ?? "step"}`} role="alert">
        {mine.map((issue) => issue.message).join(" ")}
      </ErrorMessage.Root>
    ) : null;
  };

  const form = (index: number, onSubmit: () => void, children: ReactNode) => (
    <Form.Root
      className="wizard-step"
      aria-labelledby={`${headingId}-${index}`}
      data-step={STEPS[index]}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </Form.Root>
  );

  const id = state.name.trim() === "" ? "" : projectId(state.name, takenIds);
  const families = useMemo(() => (description ? [...new Set(Object.keys(description.parts).map((part) => part.split(".")[0] as string))].sort() : []), [description]);
  const components = useMemo(() => componentsOf(state), [state]);
  const locked = useMemo(() => (state.roles ? roleComponents(mappingsOf(state.roles)) : []), [state.roles]);
  const undecided = draft && state.roles ? ROLE_NAMES.filter((role) => roleStanding(draft, role, state.roles?.[role] as RoleState) === "drafted") : [];

  return (
    <div className="wizard" data-testid="project-wizard">
      <Stack.Root as="header" direction="row" align="center" gap="condensed" className="wizard-header">
        <span className="shell-mark" aria-hidden="true">
          <Shapes />
        </span>
        <Text.Root as="h1" className="wizard-name">
          New project
        </Text.Root>
        {state.name.trim() !== "" && (
          <>
            <span className="shell-slash" aria-hidden="true">
              /
            </span>
            <Text.Root as="span" weight="medium" className="wizard-product">
              {state.name.trim()}
            </Text.Root>
          </>
        )}
        <Button.Root type="button" variant="ghost" onClick={onCancel} className="wizard-cancel">
          <Button.Icon>
            <X />
          </Button.Icon>
          Cancel
        </Button.Root>
      </Stack.Root>
      <div className="wizard-body">
        <nav className="wizard-rail" aria-label="Steps">
          <Steps.Root variant="progress" aria-label="New project steps">
            {STEPS.map((name, index) => (
              <Steps.Item key={name} status={statusOf(index, step)}>
                {name}
              </Steps.Item>
            ))}
          </Steps.Root>
        </nav>
        <main className="wizard-main" data-wide={step === STEP.roles || step === STEP.create ? "" : undefined}>
          {step === STEP.name &&
            form(
              STEP.name,
              next,
              <>
                {title(STEP.name, "A project holds one product: its component library, the rules its pages follow, and its prototypes.")}
                <Field.Group>
                  <Label.Root htmlFor={`${headingId}-name`}>Product name</Label.Root>
                  <Field.Root id={`${headingId}-name`} invalid={issuesOf(STEP.name).length > 0}>
                    <Field.TextInput value={state.name} onValueChange={(name) => setState((current) => ({ ...current, name }))} placeholder="Ledger" autoComplete="off" />
                  </Field.Root>
                  {id !== "" && (
                    <Text.Root as="span" tone="muted" data-testid="project-id">
                      Its id will be <Code.Root>{id}</Code.Root>, which names its export file.
                    </Text.Root>
                  )}
                  {problems(issuesOf(STEP.name))}
                </Field.Group>
                {actions(nextButton())}
                <Card.Root className="wizard-aside">
                  <Card.Body>
                    <Stack.Root gap="condensed">
                      <Text.Root as="h3">Just looking around?</Text.Root>
                      <Text.Root as="p" tone="muted">
                        Tally is a worked example: an expense report app on Mantine, with its roles confirmed and a prototype that follows every rule.
                      </Text.Root>
                      <div>
                        <Button.Root type="button" variant="secondary" onClick={() => void onExample()} data-testid="open-tally">
                          {hasTally ? "Open the Tally example" : "Add the Tally example"}
                        </Button.Root>
                      </div>
                    </Stack.Root>
                  </Card.Body>
                </Card.Root>
              </>,
            )}

          {step === STEP.library &&
            form(
              STEP.library,
              () => void checkLibrary(),
              <>
                {title(STEP.library, "The parts every prototype in this project is built from. The app runs in your browser with no server, so it can use a library it ships, or one described ahead of time.")}
                <Stack.Root gap="condensed">
                  <Text.Root as="span" weight="medium" id={`${headingId}-library`}>
                    Component library
                  </Text.Root>
                  <RadioGroup.Root aria-labelledby={`${headingId}-library`} value={picked} onValueChange={pick} className="library-list">
                    {SHIPPED_LIBRARIES.map((library) => (
                      <RadioGroup.Item key={library.id} value={library.id} className="library-option">
                        <span className="library-option-text">
                          <Text.Root as="span" weight="medium">
                            {library.name} {library.version}
                          </Text.Root>
                          <Text.Root as="span" tone="muted">
                            {library.about}
                          </Text.Root>
                        </span>
                      </RadioGroup.Item>
                    ))}
                    <RadioGroup.Item value={IMPORT} className="library-option">
                      <span className="library-option-text">
                        <Text.Root as="span" weight="medium">
                          Import a description file
                        </Text.Root>
                        <Text.Root as="span" tone="muted">
                          The JSON file the repository&apos;s describe-library script writes for a package and version.
                        </Text.Root>
                      </span>
                    </RadioGroup.Item>
                  </RadioGroup.Root>
                </Stack.Root>

                {picked === IMPORT && <ImportDescription onFile={(file) => void importFile(file)} />}
                {loading && (
                  <Stack.Root direction="row" align="center" gap="condensed">
                    <Loader.Root aria-label="Reading the library's description" />
                    <Text.Root as="span" tone="muted">
                      Reading the library&apos;s description
                    </Text.Root>
                  </Stack.Root>
                )}
                {state.library && !loading && <LibraryFacts library={state.library} editable={state.library.source === "imported"} onSetup={setSetup} />}
                {libraryProblems.length > 0 && (
                  <Alert.Root tone="critical" data-testid="library-problem">
                    <Alert.Title>{libraryProblems[0]}</Alert.Title>
                    {libraryProblems.length > 1 && (
                      <Alert.Description>
                        <Text.Root as="p" className="pre">
                          {libraryProblems.slice(1).join("\n")}
                        </Text.Root>
                      </Alert.Description>
                    )}
                  </Alert.Root>
                )}
                <Disclosure.Root className="wizard-note" data-testid="unlisted-library">
                  <Disclosure.Summary>Use a library that is not listed</Disclosure.Summary>
                  <Stack.Root gap="normal">
                    <Text.Root as="p">
                      A library&apos;s parts are read from its TypeScript declarations by a script that needs Node and npm, and a frame can only load code this deployment serves. Neither can happen in a browser on a static site, so a new library is added in the repository, once, and then everyone can pick it here.
                    </Text.Root>
                    <LibraryRequestForm listed={(request) => SHIPPED_LIBRARIES.some((library) => library.package === request.package && library.version === request.version)} />
                    <Text.Root as="p" tone="muted">
                      Someone with the repository can also add one by hand, which is what the workflow does:
                    </Text.Root>
                    <ol className="wizard-list">
                      <li>
                        Add the package at an exact version to <Code.Root>apps/web/package.json</Code.Root>, and list it with its stylesheets under <Code.Root>designHarness.libraries</Code.Root>.
                      </li>
                      <li>
                        Describe it: <Code.Root>node packages/core/scripts/describe-library.mjs &lt;package&gt; &lt;version&gt; --out packages/core/libraries/&lt;name&gt;.json</Code.Root>
                      </li>
                      <li>
                        Add it to <Code.Root>apps/web/src/libraries/registry.ts</Code.Root>, and deploy.
                      </li>
                    </ol>
                    <Text.Root as="p" tone="muted">
                      Importing a description file skips the last step, for a library the deployment already serves. Opened with <Code.Root>?packages=esm.sh</Code.Root>, the app loads any published package from esm.sh instead; that path has not been tested against esm.sh itself.
                    </Text.Root>
                  </Stack.Root>
                </Disclosure.Root>
                {actions(
                  <Button.Root type="submit" variant="primary" aria-disabled={checking || loading || undefined}>
                    {checking ? "Checking it renders" : "Next"}
                    <Button.Icon>
                      <ArrowRight />
                    </Button.Icon>
                  </Button.Root>,
                )}
              </>,
            )}

          {step === STEP.roles &&
            state.library &&
            draft &&
            state.roles &&
            form(
              STEP.roles,
              next,
              <>
                {title(
                  STEP.roles,
                  <>
                    The rules never name a library&apos;s parts. They name six roles, and this is where {state.library.name}&apos;s parts are matched to them. Core drafted each one from the library&apos;s part names and props; nothing is used until you accept it or change it.
                  </>,
                )}
                <Stack.Root direction="row" align="center" gap="condensed" wrap className="wizard-bar">
                  <Text.Root as="span" role="status" data-testid="roles-left">
                    {undecided.length === 0 ? "Every drafted role is decided." : `${undecided.length} of 6 still to accept or change.`}
                  </Text.Root>
                  <Button.Root
                    type="button"
                    variant="secondary"
                    aria-disabled={undecided.length === 0 || undefined}
                    onClick={() => setState((current) => (current.roles ? { ...current, roles: Object.fromEntries(ROLE_NAMES.map((role) => [role, undecided.includes(role) ? { ...(current.roles?.[role] as RoleState), accepted: true } : current.roles?.[role]])) as typeof current.roles } : current))}
                    data-testid="accept-all"
                  >
                    <Button.Icon>
                      <Check />
                    </Button.Icon>
                    Accept all as drafted
                  </Button.Root>
                </Stack.Root>
                <WizardRoles library={state.library} draft={draft} roles={state.roles} onChange={setRole} issues={issuesOf(STEP.roles)} scheme={scheme} />
                {problems(issuesOf(STEP.roles).filter((issue) => issue.role === undefined))}
                {issuesOf(STEP.roles).length > 0 && (
                  <ErrorMessage.Root id={`${headingId}-roles-left`} role="alert" data-testid="roles-problem">
                    {`${issuesOf(STEP.roles).length === 1 ? "One role needs" : `${issuesOf(STEP.roles).length} roles need`} a decision: ${issuesOf(STEP.roles).map((issue) => (issue.role ? ROLE_WORDS[issue.role].title : "a role")).join(", ")}.`}
                  </ErrorMessage.Root>
                )}
                {actions(nextButton())}
              </>,
            )}

          {step === STEP.exclusion &&
            state.library &&
            draft &&
            form(
              STEP.exclusion,
              next,
              <>
                {title(STEP.exclusion, "Style props let a page restyle a part one at a time, around the library's own variants and tokens. Excluding them keeps every page on the design system: a prototype that sets one is refused.")}
                <ExcludedProps draft={draft} state={state.exclusion} library={state.library} onChange={(exclusion) => setState((current) => ({ ...current, exclusion }))} invalid={issuesOf(STEP.exclusion).length > 0} />
                {problems(issuesOf(STEP.exclusion))}
                {actions(nextButton())}
              </>,
            )}

          {step === STEP.rules &&
            state.library &&
            form(
              STEP.rules,
              next,
              <>
                {title(STEP.rules, "The numbers and names the rules read. These are starting points: each can change later through a proposal, which the checks then hold every prototype to.")}
                <RuleInputs rules={state.rules} onChange={setRules} issues={issuesOf(STEP.rules)} />
                <section className="wizard-section" aria-labelledby={`${headingId}-components`}>
                  <Text.Root as="h3" id={`${headingId}-components`}>
                    Parts a prototype may use
                  </Text.Root>
                  <Text.Root as="p" tone="muted">
                    A prototype renders only what is listed here. It starts with the parts the roles map to, the ones the starter page writes with, and common layout parts. Adding one later is a proposal.
                  </Text.Root>
                  <div className="chip-row" data-testid="inventory">
                    {components.map((component) => (
                      <Badge.Root key={component} tone="neutral">
                        {component}
                      </Badge.Root>
                    ))}
                  </div>
                  <Disclosure.Root className="wizard-note">
                    <Disclosure.Summary>
                      Change the list ({components.length} of {families.length})
                    </Disclosure.Summary>
                    <div className="option-list option-list-wide" role="group" aria-label="Parts a prototype may use">
                      {families.map((family) => (
                        <Checkbox.Root
                          key={family}
                          checked={components.includes(family)}
                          disabled={locked.includes(family)}
                          onCheckedChange={(on) => setState((current) => ({ ...current, components: on ? [...componentsOf(current), family] : componentsOf(current).filter((item) => item !== family) }))}
                        >
                          {family}
                        </Checkbox.Root>
                      ))}
                    </div>
                    <Text.Root as="p" tone="muted">
                      A part a role maps to stays checked: a rule that reads the role needs it.
                    </Text.Root>
                  </Disclosure.Root>
                  {problems(issuesOf(STEP.rules), "$.components")}
                </section>
                <section className="wizard-section" aria-labelledby={`${headingId}-fixed`}>
                  <Text.Root as="h3" id={`${headingId}-fixed`}>
                    What every new project starts with
                  </Text.Root>
                  <DataList.Root>
                    <DataList.Item>
                      <DataList.Term>Page types</DataList.Term>
                      <DataList.Details>{STARTER_PAGE_TYPES.map((type) => `${type.id} (${type.kind === "action" ? "one primary action" : type.kind === "collection" ? "a list to choose from" : "information"})`).join(", ")}</DataList.Details>
                    </DataList.Item>
                    <DataList.Item>
                      <DataList.Term>Measured at</DataList.Term>
                      <DataList.Details>{STARTER_VIEWS.map((view) => `${view.name} ${view.width} × ${view.height}, ${view.scheme}`).join("; ")}</DataList.Details>
                    </DataList.Item>
                  </DataList.Root>
                </section>
                {actions(nextButton("Review"))}
              </>,
            )}

          {step === STEP.create &&
            form(
              STEP.create,
              () => undefined,
              <>
                {title(STEP.create, "This is the project as core built it from your answers, and its first page drawn and measured. Nothing is saved until you create it.")}
                {built?.ok && settled === answers ? (
                  <Review project={built.value} onEdit={go} creating={creating} failed={failed} onCreate={() => void create(built.value)} back={actions} />
                ) : built && !built.ok ? (
                  <>
                    <Alert.Root tone="critical" data-testid="review-problem">
                      <Alert.Title>Core refuses these answers</Alert.Title>
                      <Alert.Description>
                        <ul className="wizard-list">
                          {issues.map((issue) => (
                            <li key={`${issue.path}${issue.message}`}>
                              {issue.message}{" "}
                              <Button.Root type="button" variant="ghost" onClick={() => go(issue.step)}>
                                Go to {STEPS[issue.step]}
                              </Button.Root>
                            </li>
                          ))}
                        </ul>
                      </Alert.Description>
                    </Alert.Root>
                    {actions(null)}
                  </>
                ) : (
                  <Loader.Root aria-label="Building the project" />
                )}
              </>,
            )}
        </main>
      </div>
    </div>
  );
}

const TITLES = ["Name the product", "Pick its component library", "Confirm the roles", "Confirm the style props", "Set the starting rules", "Review and create"] as const;

function ImportDescription({ onFile }: { readonly onFile: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <Stack.Root gap="condensed" className="wizard-import">
      <Text.Root as="p" tone="muted">
        Someone with the repository runs <Code.Root>node packages/core/scripts/describe-library.mjs &lt;package&gt; &lt;version&gt; --out description.json</Code.Root> and sends you the file. The app reads the parts and props from it; it still needs this deployment to serve the package itself, which the next step checks.
      </Text.Root>
      <div>
        <Button.Root type="button" variant="secondary" onClick={() => input.current?.click()}>
          <Button.Icon>
            <Upload />
          </Button.Icon>
          Choose a description file
        </Button.Root>
      </div>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        hidden
        data-testid="description-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFile(file);
        }}
      />
    </Stack.Root>
  );
}

/** What the project will say about its library: read-only for one the deployment ships, editable for an imported description. */
function LibraryFacts({ library, editable, onSetup }: { readonly library: WizardLibrary; readonly editable: boolean; readonly onSetup: (change: (setup: LibrarySetup) => LibrarySetup) => void }) {
  const { description, setup } = library;
  const id = useId();
  const [sheets, setSheets] = useState((setup.stylesheets ?? []).join(", "));
  // Another description starts from its own stylesheets; typing in the field does not reset it.
  useEffect(() => setSheets((setup.stylesheets ?? []).join(", ")), [description]);
  return (
    <Card.Root className="library-facts" data-testid="library-facts">
      <Card.Body>
        <Stack.Root gap="normal">
          <DataList.Root>
            <DataList.Item>
              <DataList.Term>Package</DataList.Term>
              <DataList.Details>
                <Code.Root>{description.package}</Code.Root>
              </DataList.Details>
            </DataList.Item>
            <DataList.Item>
              <DataList.Term>Version</DataList.Term>
              <DataList.Details>{description.version}, exactly: a prototype renders with the same code on every load</DataList.Details>
            </DataList.Item>
            <DataList.Item>
              <DataList.Term>Parts described</DataList.Term>
              <DataList.Details>{Object.keys(description.parts).length}</DataList.Details>
            </DataList.Item>
            {!editable && (
              <>
                <DataList.Item>
                  <DataList.Term>Stylesheet</DataList.Term>
                  <DataList.Details>{(setup.stylesheets ?? []).map((path) => <Code.Root key={path}>{path}</Code.Root>)}</DataList.Details>
                </DataList.Item>
                <DataList.Item>
                  <DataList.Term>Renders with</DataList.Term>
                  <DataList.Details>React {setup.react}</DataList.Details>
                </DataList.Item>
              </>
            )}
          </DataList.Root>
          {editable && (
            <Stack.Root gap="normal">
              <Field.Group>
                <Label.Root htmlFor={`${id}-sheets`}>Stylesheets</Label.Root>
                <Field.Root id={`${id}-sheets`}>
                  <Field.TextInput
                    value={sheets}
                    onValueChange={(text) => {
                      setSheets(text);
                      onSetup((current) => {
                        const { stylesheets: _stylesheets, ...rest } = current;
                        return listOf(text).length > 0 ? { ...rest, stylesheets: listOf(text) } : rest;
                      });
                    }}
                    placeholder="dist/styles.css"
                  />
                </Field.Root>
                <Text.Root as="span" tone="muted">
                  Paths inside the package, separated by commas. The library&apos;s styles must be a plain CSS file. Renders with React {setup.react}.
                </Text.Root>
              </Field.Group>
              <Field.Group>
                <Label.Root htmlFor={`${id}-root`}>Part every page renders inside, if it needs one</Label.Root>
                <Field.Root id={`${id}-root`}>
                  <Field.TextInput
                    value={setup.root?.component ?? ""}
                    onValueChange={(component) =>
                      onSetup((current) => {
                        const { root: _root, ...rest } = current;
                        return component.trim() === "" ? rest : { ...rest, root: { ...(current.root?.schemeProp ? { schemeProp: current.root.schemeProp } : {}), component: component.trim() } };
                      })
                    }
                    placeholder="ThemeProvider"
                  />
                </Field.Root>
              </Field.Group>
              <Field.Group>
                <Label.Root htmlFor={`${id}-scheme`}>How it switches light and dark</Label.Root>
                <Field.Root id={`${id}-scheme`}>
                  <Field.TextInput
                    value={setup.root?.schemeProp ?? setup.schemeAttribute ?? ""}
                    onValueChange={(name) =>
                      onSetup((current) => {
                        const { schemeAttribute: _attribute, ...rest } = current;
                        const value = name.trim();
                        if (current.root) return { ...rest, root: { component: current.root.component, ...(value === "" ? {} : { schemeProp: value }) } };
                        return value === "" ? rest : { ...rest, schemeAttribute: value };
                      })
                    }
                    placeholder={setup.root ? "colorScheme" : "data-theme"}
                  />
                </Field.Root>
                <Text.Root as="span" tone="muted">
                  {setup.root ? `A prop of ${setup.root.component} set to "light" or "dark".` : 'An attribute on the page set to "light" or "dark". Leave empty to use only the CSS color-scheme.'}
                </Text.Root>
              </Field.Group>
            </Stack.Root>
          )}
          {library.notes.length > 0 && (
            <ul className="wizard-list wizard-notes">
              {library.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </Stack.Root>
      </Card.Body>
    </Card.Root>
  );
}

function ExcludedProps({ draft, state, library, onChange, invalid }: { readonly draft: ReturnType<typeof draftRoles>; readonly state: WizardState["exclusion"]; readonly library: WizardLibrary; readonly onChange: (next: WizardState["exclusion"]) => void; readonly invalid: boolean }) {
  const id = useId();
  const [more, setMore] = useState("");
  const drafted = draft.excludedProps?.props ?? [];
  const all = [...new Set([...drafted, ...state.props])].sort();
  const isDraft = exclusionIsDraft(draft, state);
  const add = () => {
    const names = listOf(more);
    if (names.length === 0) return;
    onChange({ ...state, props: [...new Set([...state.props, ...names])].sort(), accepted: false });
    setMore("");
  };
  return (
    <Stack.Root gap="normal" data-testid="excluded-props">
      {draft.excludedProps ? (
        <Card.Root>
          <Card.Header>
            <Stack.Root direction="row" align="center" gap="condensed" wrap>
              <Text.Root as="h3">
                {state.props.length} style props of {library.description.package} excluded
              </Text.Root>
              <Badge.Root tone={isDraft ? "success" : "info"} data-testid="exclusion-status">
                {isDraft ? (state.accepted ? "Accepted" : "High confidence") : "Changed by you"}
              </Badge.Root>
            </Stack.Root>
          </Card.Header>
          <Card.Body>
            <Stack.Root gap="normal">
              <div className="role-evidence">
                <Text.Root as="span" variant="label">
                  Why core drafted this
                </Text.Root>
                <ul>
                  {draft.excludedProps.evidence.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
              <div className="option-list option-list-wide" role="group" aria-label="Excluded props">
                {all.map((prop) => (
                  <Checkbox.Root key={prop} checked={state.props.includes(prop)} onCheckedChange={(on) => onChange({ ...state, props: on ? [...state.props, prop].sort() : state.props.filter((item) => item !== prop), accepted: false })}>
                    {prop}
                  </Checkbox.Root>
                ))}
              </div>
              <Text.Root as="p" tone="muted">
                Checked props are excluded. Uncheck one to let a prototype set it.
              </Text.Root>
            </Stack.Root>
          </Card.Body>
          <Card.Footer>
            {isDraft && state.accepted ? (
              <Stack.Root direction="row" align="center" gap="condensed">
                <span className="role-accepted">
                  <Check aria-hidden="true" />
                  Accepted
                </span>
                <Button.Root type="button" variant="ghost" onClick={() => onChange({ ...state, accepted: false })} aria-label="Undo accepting the excluded props">
                  Undo
                </Button.Root>
              </Stack.Root>
            ) : isDraft ? (
              <Button.Root type="button" variant="secondary" onClick={() => onChange({ ...state, accepted: true })} data-testid="exclusion-accept">
                <Button.Icon>
                  <Check />
                </Button.Icon>
                Accept
              </Button.Root>
            ) : (
              <Button.Root type="button" variant="ghost" onClick={() => onChange({ props: drafted, why: "", accepted: false })}>
                <Button.Icon>
                  <RotateCcw />
                </Button.Icon>
                Back to the draft
              </Button.Root>
            )}
          </Card.Footer>
        </Card.Root>
      ) : (
        <Alert.Root tone="info">
          <Alert.Title>The description names no style props</Alert.Title>
          <Alert.Description>Nothing is excluded unless you add a prop below. A spec cannot set an inline style either way: no part in the catalog takes one.</Alert.Description>
        </Alert.Root>
      )}
      {!draft.excludedProps && state.props.length > 0 && (
        <div className="chip-row">
          {state.props.map((prop) => (
            <Badge.Root key={prop} tone="neutral">
              {prop}
            </Badge.Root>
          ))}
          <Button.Root type="button" variant="ghost" onClick={() => onChange({ props: [], why: "", accepted: false })}>
            Clear
          </Button.Root>
        </div>
      )}
      <Field.Group>
        <Label.Root htmlFor={`${id}-more`}>Also exclude</Label.Root>
        <div className="add-row">
          <Field.Root id={`${id}-more`}>
            <Field.TextInput
              value={more}
              onValueChange={setMore}
              placeholder="sx, data-*"
              onKeyDown={(event) => {
                // Enter adds the names; it does not move to the next step.
                if (event.key !== "Enter") return;
                event.preventDefault();
                add();
              }}
            />
          </Field.Root>
          <Button.Root type="button" variant="secondary" onClick={add}>
            <Button.Icon>
              <Plus />
            </Button.Icon>
            Add
          </Button.Root>
        </div>
        <Text.Root as="span" tone="muted">
          Prop names, or patterns where * stands for any characters, separated by commas.
        </Text.Root>
      </Field.Group>
      {!isDraft && (
        <Field.Group>
          <Label.Root htmlFor={`${id}-why`}>Why the change</Label.Root>
          <Field.Root id={`${id}-why`} invalid={invalid}>
            <Field.Textarea value={state.why} onValueChange={(why) => onChange({ ...state, why })} rows={2} placeholder="Say why this list, and not the draft's." />
          </Field.Root>
        </Field.Group>
      )}
    </Stack.Root>
  );
}

function RuleInputs({ rules, onChange, issues }: { readonly rules: StarterRules; readonly onChange: (change: (rules: StarterRules) => StarterRules) => void; readonly issues: readonly StepIssue[] }) {
  const id = useId();
  const at = (path: string) => {
    const mine = issues.filter((issue) => issue.path === path || issue.path.startsWith(`${path}.`) || issue.path.startsWith(`${path}[`));
    return mine.length > 0 ? (
      <ErrorMessage.Root id={`${id}-${path}`} role="alert">
        {mine.map((issue) => issue.message).join(" ")}
      </ErrorMessage.Root>
    ) : null;
  };
  return (
    <>
      <section className="wizard-section" aria-labelledby={`${id}-tasks`}>
        <Text.Root as="h3" id={`${id}-tasks`}>
          Tasks and their step budgets
        </Text.Root>
        <Text.Root as="p" tone="muted">
          A task is something a person comes to get done. Its budget is the most presses it may take from start to finish; a prototype with a longer route fails the checks.
        </Text.Root>
        <div className="task-list">
          {rules.tasks.map((task, index) => (
            <div className="task-row" key={index} data-testid="task-row">
              <Field.Group className="task-name">
                <Label.Root htmlFor={`${id}-task-${index}`}>Task {index + 1}</Label.Root>
                <Field.Root id={`${id}-task-${index}`} invalid={issues.some((issue) => issue.path === `$.rules.tasks[${index}].name`)}>
                  <Field.TextInput value={task.name} onValueChange={(name) => onChange((current) => ({ ...current, tasks: current.tasks.map((item, at) => (at === index ? { ...item, name } : item)) }))} placeholder="Pay an invoice" />
                </Field.Root>
              </Field.Group>
              <Field.Group className="task-steps">
                <Label.Root htmlFor={`${id}-steps-${index}`}>Most steps</Label.Root>
                <Field.Root id={`${id}-steps-${index}`} invalid={issues.some((issue) => issue.path === `$.rules.tasks[${index}].maxSteps`)}>
                  <Field.NumberInput value={task.maxSteps} min={1} onValueChange={(value) => onChange((current) => ({ ...current, tasks: current.tasks.map((item, at) => (at === index ? { ...item, maxSteps: value ?? 0 } : item)) }))} />
                </Field.Root>
              </Field.Group>
              <Button.Root type="button" variant="ghost" aria-label={`Remove task ${index + 1}`} aria-disabled={rules.tasks.length === 1 || undefined} onClick={() => rules.tasks.length > 1 && onChange((current) => ({ ...current, tasks: current.tasks.filter((_, at) => at !== index) }))} className="task-remove">
                <Button.Icon>
                  <Trash2 />
                </Button.Icon>
              </Button.Root>
            </div>
          ))}
        </div>
        {at("$.rules.tasks")}
        <div>
          <Button.Root type="button" variant="secondary" onClick={() => onChange((current) => ({ ...current, tasks: [...current.tasks, { name: "", maxSteps: 3 }] }))}>
            <Button.Icon>
              <Plus />
            </Button.Icon>
            Add a task
          </Button.Root>
        </div>
      </section>

      <section className="wizard-section" aria-labelledby={`${id}-actions`}>
        <Text.Root as="h3" id={`${id}-actions`}>
          Ranked actions
        </Text.Root>
        <Text.Root as="p" tone="muted">
          The rules find actions by what they say. The top-ranked one is the only action allowed to look primary, and it must be in the first view; the second must look secondary wherever it appears.
        </Text.Root>
        <div className="two-fields">
          <Field.Group>
            <Label.Root htmlFor={`${id}-primary`}>Rank 1, the primary action</Label.Root>
            <Field.Root id={`${id}-primary`} invalid={issues.some((issue) => issue.path === "$.rules.primaryAction")}>
              <Field.TextInput value={rules.primaryAction} onValueChange={(primaryAction) => onChange((current) => ({ ...current, primaryAction }))} placeholder="Pay now" />
            </Field.Root>
            {at("$.rules.primaryAction")}
          </Field.Group>
          <Field.Group>
            <Label.Root htmlFor={`${id}-secondary`}>Rank 2, a secondary action</Label.Root>
            <Field.Root id={`${id}-secondary`} invalid={issues.some((issue) => issue.path === "$.rules.secondaryAction")}>
              <Field.TextInput value={rules.secondaryAction} onValueChange={(secondaryAction) => onChange((current) => ({ ...current, secondaryAction }))} placeholder="Save for later" />
            </Field.Root>
            <Text.Root as="span" tone="muted">
              Leave empty for none.
            </Text.Root>
            {at("$.rules.secondaryAction")}
          </Field.Group>
        </div>
      </section>

      <section className="wizard-section" aria-labelledby={`${id}-caps`}>
        <Text.Root as="h3" id={`${id}-caps`}>
          Caps
        </Text.Root>
        <Text.Root as="p" tone="muted">
          Limits that hold on every page alike. The defaults are strict on purpose: loosening one later takes a proposal with a reason.
        </Text.Root>
        <div className="cap-grid">
          {STARTER_CAPS.map((cap) => (
            <Field.Group key={cap} className="cap">
              <Label.Root htmlFor={`${id}-${cap}`}>{STARTER_CAP_NOTES[cap].label}</Label.Root>
              <Field.Root id={`${id}-${cap}`} invalid={issues.some((issue) => issue.path === `$.rules.caps.${cap}`)}>
                <Field.NumberInput value={rules.caps[cap]} min={STARTER_CAP_NOTES[cap].min} onValueChange={(value) => onChange((current) => ({ ...current, caps: { ...current.caps, [cap]: value ?? -1 } }))} />
              </Field.Root>
              <Text.Root as="span" tone="muted">
                {STARTER_CAP_NOTES[cap].description}
              </Text.Root>
              {at(`$.rules.caps.${cap}`)}
            </Field.Group>
          ))}
        </div>
      </section>
    </>
  );
}

/** The last step: what core built, the starter page drawn and measured in frames, and Create. */
function Review({ project, onEdit, creating, failed, onCreate, back }: { readonly project: BuiltProject; readonly onEdit: (step: number) => void; readonly creating: boolean; readonly failed: string | null; readonly onCreate: () => void; readonly back: (submit: ReactNode) => ReactNode }) {
  const { config, starter, dropped, unranked, confirmed } = project;
  const items = useMemo(() => (starter.ok ? [{ id: "starter", config, prototype: starter.value }] : []), [config, starter]);
  const [measured] = useSessions(items);
  const report = measured?.state.measured ? measured.state.report : null;
  const failing = report ? report.rules.filter((rule) => rule.status !== "pass") : [];
  const waiting = starter.ok && (!measured || measured.measurement.state === "measuring");
  const corrected = confirmed.record.filter((entry) => entry.decision === "corrected");
  const left = [...new Set([...dropped.flatMap((effect) => effect.rules.map((rule) => rule.rule)), ...unranked])];
  const edit = (step: number) => (
    <Button.Root type="button" variant="ghost" onClick={() => onEdit(step)} className="wizard-edit">
      Change
    </Button.Root>
  );
  const first = measured?.state.frames.filter((frame) => frame.scenario.id === measured.state.frames[0]?.scenario.id) ?? [];
  return (
    <>
      <div className="wizard-review">
        <Card.Root data-testid="review-summary">
          <Card.Body className="wizard-summary">
            <DataList.Root>
              <DataList.Item>
                <DataList.Term>Product</DataList.Term>
                <DataList.Details>
                  {config.name} <Code.Root>{config.id}</Code.Root> {edit(STEP.name)}
                </DataList.Details>
              </DataList.Item>
              <DataList.Item>
                <DataList.Term>Library</DataList.Term>
                <DataList.Details>
                  {config.library.package} {config.library.version} {edit(STEP.library)}
                </DataList.Details>
              </DataList.Item>
              <DataList.Item>
                <DataList.Term>Roles</DataList.Term>
                <DataList.Details>
                  <ul className="wizard-roles">
                    {ROLE_NAMES.map((role) => (
                      <li key={role}>
                        <Text.Root as="span" tone="muted">
                          {ROLE_WORDS[role].title}:
                        </Text.Root>{" "}
                        {describeMapping(config.library.roles[role])}
                        {corrected.some((entry) => entry.role === role) ? " (changed by you)" : ""}
                      </li>
                    ))}
                  </ul>
                  {edit(STEP.roles)}
                </DataList.Details>
              </DataList.Item>
              <DataList.Item>
                <DataList.Term>Style props</DataList.Term>
                <DataList.Details>
                  {(config.library.excludedProps ?? []).length} excluded {edit(STEP.exclusion)}
                </DataList.Details>
              </DataList.Item>
              <DataList.Item>
                <DataList.Term>Tasks</DataList.Term>
                <DataList.Details>
                  {config.inputs.tasks.map((task) => `${task.description ?? task.id}, in ${task.maxSteps} ${task.maxSteps === 1 ? "step" : "steps"}`).join("; ")} {edit(STEP.rules)}
                </DataList.Details>
              </DataList.Item>
              <DataList.Item>
                <DataList.Term>Actions</DataList.Term>
                <DataList.Details>{config.inputs.ranking.map((item) => `${item.rank}. ${item.action} (${item.level})`).join(", ")}</DataList.Details>
              </DataList.Item>
              <DataList.Item>
                <DataList.Term>May use</DataList.Term>
                <DataList.Details>
                  {config.inventories.components.length} parts: {config.inventories.components.join(", ")}
                </DataList.Details>
              </DataList.Item>
              <DataList.Item>
                <DataList.Term>Rules in force</DataList.Term>
                <DataList.Details>
                  <span data-testid="review-rules">{config.rules.length}</span>
                  {left.length > 0 && `, without ${left.join(", ")}`}
                </DataList.Details>
              </DataList.Item>
            </DataList.Root>
            <Disclosure.Root className="wizard-note">
              <Disclosure.Summary>The rules in plain words</Disclosure.Summary>
              <ul className="wizard-list">
                {config.rules.map((rule) => (
                  <li key={rule.id}>{rule.description ?? describeRule(rule, config)}</li>
                ))}
              </ul>
            </Disclosure.Root>
          </Card.Body>
        </Card.Root>

        <section className="wizard-starter" aria-label="Starter page" data-testid="wizard-starter">
          <Text.Root as="h3">The starter page</Text.Root>
          {!starter.ok ? (
            <Alert.Root tone="warning" data-testid="starter-missing">
              <Alert.Title>The project will start with an empty prototype</Alert.Title>
              <Alert.Description>
                <Text.Root as="p" className="pre">
                  {starter.error}
                </Text.Root>
              </Alert.Description>
            </Alert.Root>
          ) : (
            <>
              <div className="wizard-verdict" role="status" data-testid="starter-verdict" data-state={waiting ? "measuring" : failing.length === 0 ? "pass" : "fail"}>
                {waiting ? (
                  <Stack.Root direction="row" align="center" gap="condensed">
                    <Loader.Root variant="dots" aria-hidden="true" />
                    <Text.Root as="span">Drawing it in {measured?.state.frames.length ?? ""} frames and measuring</Text.Root>
                  </Stack.Root>
                ) : failing.length === 0 ? (
                  <Alert.Root tone="success">
                    <Alert.Title>It follows all {config.rules.length} rules</Alert.Title>
                    <Alert.Description>
                      Core checked it as drawn in {measured?.state.frames.length} frames: every scenario at {config.views.map((view) => `${view.name} (${view.scheme})`).join(" and ")}.
                    </Alert.Description>
                  </Alert.Root>
                ) : (
                  <Alert.Root tone="warning">
                    <Alert.Title>
                      {failing.length} {failing.length === 1 ? "rule finds" : "rules find"} something on the starter page
                    </Alert.Title>
                    <Alert.Description>
                      <ul className="wizard-list">
                        {failing.map((rule) => (
                          <li key={rule.rule}>
                            <Code.Root>{rule.rule}</Code.Root> {rule.findings[0]?.message ?? "was not measured"}
                          </li>
                        ))}
                      </ul>
                      <Text.Root as="p">You can still create the project: the board shows each one, and the agent can fix it.</Text.Root>
                    </Alert.Description>
                  </Alert.Root>
                )}
              </div>
              {measured && (
                <div className="wizard-frames">
                  {measured.state.frames.map((frame) => (
                    <FrameCard key={frame.key} session={measured.session} spec={frame} revision={measured.state.revision} frameState={measured.state.frameStates[frame.key] ?? { state: "waiting" }} scale={0.28} focused={false} hidden={!first.includes(frame)} selected={false} label={scenarioLabel(frame.scenario.id)} />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
      {failed && <Alert.Root tone="critical">{failed}</Alert.Root>}
      {back(
        <Button.Root type="button" variant="primary" aria-disabled={creating || waiting || undefined} onClick={() => !(creating || waiting) && onCreate()} data-testid="create-project">
          {creating ? "Creating" : waiting ? "Measuring the starter page" : `Create ${config.name}`}
        </Button.Root>,
      )}
    </>
  );
}
