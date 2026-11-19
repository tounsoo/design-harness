import { Alert, Loader, Stack, Text } from "@tounsoo/todae";
import { Suspense, lazy, useEffect, useState } from "react";
import type { ProjectConfig } from "@design-harness/core";
import { SEED_PROTOTYPE_ID, seedProject } from "../seed/nook";
import { KeyVault } from "../agent/key-vault";
import { Store } from "../store/db";
import { withLibraryParts, type LoadNote } from "../store/migrate";
import type { Imported, PrototypeRecord } from "../store/project-file";
import type { CreatedProject } from "./ProjectWizard";
import { recallProject, rememberProject, type ProjectEntry } from "./projects";
import { Workspace } from "./Workspace";

/** The wizard is its own chunk: most visits never open it. */
const ProjectWizard = lazy(() => import("./ProjectWizard").then((module) => ({ default: module.ProjectWizard })));

/** The open project. `opened` counts every opening, so a project opens in a fresh workspace even when its id is the same. */
type Open = { readonly config: ProjectConfig; readonly prototypes: readonly PrototypeRecord[]; readonly problems: readonly string[]; readonly notes: readonly LoadNote[] };
type Loaded = Open & { readonly store: Store; readonly vault: KeyVault; readonly projects: readonly ProjectEntry[]; readonly opened: number };

/** Reads one stored project and its prototypes, bringing an older one up to date. */
async function open(store: Store, config: ProjectConfig, problems: readonly string[]): Promise<Open> {
  // A project stored before spec prototypes gets its library's part description, when the app ships one.
  const migration = withLibraryParts(config);
  const notes: LoadNote[] = [];
  if (migration.kind === "added-parts") {
    await store.putProject(migration.config);
    notes.push({ tone: "info", title: "The project was brought up to date", text: migration.note });
  } else if (migration.kind === "no-parts") notes.push({ tone: "warning", title: "Spec prototypes cannot be checked in this project", text: migration.note });
  const prototypes = await store.prototypes(migration.config.id);
  return { config: migration.config, prototypes: prototypes.items, problems: [...problems, ...prototypes.problems], notes };
}

const entries = (configs: readonly ProjectConfig[]): ProjectEntry[] => configs.map((config) => ({ id: config.id, name: config.name }));

/** Opens the browser's store, seeding it with the Nook example on first run, and shows the project last open here, or the first. */
async function load(): Promise<Loaded> {
  const [store, vault] = await Promise.all([Store.open(), KeyVault.open()]);
  let projects = await store.projects();
  if (projects.items.length === 0) {
    const seed = seedProject();
    await store.replaceProject(seed.config, [{ projectId: seed.config.id, id: SEED_PROTOTYPE_ID, name: "Booking", prototype: seed.prototype }]);
    projects = await store.projects();
  }
  const stored = projects.items.find((config) => config.id === recallProject()) ?? projects.items[0];
  if (!stored) throw new Error(`No stored project validates.\n${projects.problems.join("\n")}`);
  return { store, vault, projects: entries(projects.items), opened: 0, ...(await open(store, stored, projects.problems)) };
}

export function App() {
  const [state, setState] = useState<{ loaded: Loaded } | { error: string } | null>(null);
  /** The New project wizard takes the whole page; the open project comes back when it closes. */
  const [wizard, setWizard] = useState(false);
  useEffect(() => {
    load().then(
      (loaded) => setState({ loaded }),
      (error: unknown) => setState({ error: error instanceof Error ? error.message : String(error) }),
    );
  }, []);

  if (state === null) {
    return (
      <Stack.Root className="app-center" align="center" justify="center">
        <Loader.Root aria-label="Opening the project" />
      </Stack.Root>
    );
  }
  if ("error" in state) {
    return (
      <Stack.Root className="app-center" align="center" justify="center">
        <Alert.Root tone="critical">
          <Alert.Title>The project could not be opened</Alert.Title>
          <Alert.Description>
            <Text.Root as="p" className="pre">
              {state.error}
            </Text.Root>
          </Alert.Description>
        </Alert.Root>
      </Stack.Root>
    );
  }
  const { loaded } = state;
  const { store } = loaded;

  /** Shows a stored project, remembering it for the next visit. */
  const show = async (id: string, notes: readonly LoadNote[] = []) => {
    const projects = await store.projects();
    const config = projects.items.find((item) => item.id === id);
    if (!config) return;
    const opened = await open(store, config, projects.problems);
    rememberProject(id);
    setWizard(false);
    setState({ loaded: { ...loaded, ...opened, notes: [...notes, ...opened.notes], projects: entries(projects.items), opened: loaded.opened + 1 } });
  };
  const onImported = async (imported: Imported) => {
    await store.replaceProject(imported.config, imported.prototypes);
    await show(imported.config.id);
  };
  const onCreated = async (created: CreatedProject) => {
    await store.replaceProject(created.config, created.prototypes);
    await show(created.config.id, [created.note]);
  };
  /** Core's second worked example, added once: a stored Tally is opened as it is, never replaced. */
  const onExample = async () => {
    const { tallyProject, TALLY_PROTOTYPE_ID } = await import("../seed/tally");
    const tally = tallyProject();
    if (!loaded.projects.some((project) => project.id === tally.config.id)) await store.replaceProject(tally.config, [{ projectId: tally.config.id, id: TALLY_PROTOTYPE_ID, name: "Expense", prototype: tally.prototype }]);
    await show(tally.config.id);
  };

  if (wizard) {
    return (
      <Suspense
        fallback={
          <Stack.Root className="app-center" align="center" justify="center">
            <Loader.Root aria-label="Opening New project" />
          </Stack.Root>
        }
      >
        <ProjectWizard takenIds={loaded.projects.map((project) => project.id)} hasTally={loaded.projects.some((project) => project.id === "tally")} onCancel={() => setWizard(false)} onCreate={onCreated} onExample={onExample} />
      </Suspense>
    );
  }
  return (
    <Workspace
      key={loaded.opened}
      store={store}
      vault={loaded.vault}
      config={loaded.config}
      prototypes={loaded.prototypes}
      problems={loaded.problems}
      notes={loaded.notes}
      projects={loaded.projects}
      onOpenProject={(id) => void show(id)}
      onNewProject={() => setWizard(true)}
      onImported={onImported}
    />
  );
}
