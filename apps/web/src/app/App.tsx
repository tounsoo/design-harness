import { Alert, Loader, Stack, Text } from "@tounsoo/todae";
import { useEffect, useState } from "react";
import type { ProjectConfig } from "@design-harness/core";
import { SEED_PROTOTYPE_ID, SEED_SPEC_PROTOTYPE_ID, seedProject } from "../seed/nook";
import { KeyVault } from "../agent/key-vault";
import { Store } from "../store/db";
import { withLibraryParts, type LoadNote } from "../store/migrate";
import type { Imported, PrototypeRecord } from "../store/project-file";
import { Workspace } from "./Workspace";

/** `opened` counts imports, so an imported project opens in a fresh workspace even when its id is the same. */
type Loaded = { readonly store: Store; readonly vault: KeyVault; readonly config: ProjectConfig; readonly prototypes: readonly PrototypeRecord[]; readonly problems: readonly string[]; readonly notes: readonly LoadNote[]; readonly opened: number };

/** Opens the browser's store, seeding it with the Nook example on first run, and shows the first project. */
async function load(): Promise<Loaded> {
  const [store, vault] = await Promise.all([Store.open(), KeyVault.open()]);
  let projects = await store.projects();
  if (projects.items.length === 0) {
    const seed = seedProject();
    await store.replaceProject(seed.config, [
      { projectId: seed.config.id, id: SEED_PROTOTYPE_ID, name: "Booking", prototype: seed.prototype },
      { projectId: seed.config.id, id: SEED_SPEC_PROTOTYPE_ID, name: "Booking (spec)", prototype: seed.spec },
    ]);
    projects = await store.projects();
  }
  const stored = projects.items[0];
  if (!stored) throw new Error(`No stored project validates.\n${projects.problems.join("\n")}`);
  // A project stored before spec prototypes gets its library's part description, when the app ships one.
  const migration = withLibraryParts(stored);
  const notes: LoadNote[] = [];
  if (migration.kind === "added-parts") {
    await store.putProject(migration.config);
    notes.push({ tone: "info", title: "The project was brought up to date", text: migration.note });
  } else if (migration.kind === "no-parts") notes.push({ tone: "warning", title: "Spec prototypes cannot be checked in this project", text: migration.note });
  const config = migration.config;
  const prototypes = await store.prototypes(config.id);
  return { store, vault, config, prototypes: prototypes.items, problems: [...projects.problems, ...prototypes.problems], notes, opened: 0 };
}

export function App() {
  const [state, setState] = useState<{ loaded: Loaded } | { error: string } | null>(null);
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
  const onImported = async (imported: Imported) => {
    await loaded.store.replaceProject(imported.config, imported.prototypes);
    const prototypes = await loaded.store.prototypes(imported.config.id);
    setState({ loaded: { ...loaded, config: imported.config, prototypes: prototypes.items, problems: prototypes.problems, notes: [], opened: loaded.opened + 1 } });
  };
  return <Workspace key={loaded.opened} store={loaded.store} vault={loaded.vault} config={loaded.config} prototypes={loaded.prototypes} problems={loaded.problems} notes={loaded.notes} onImported={onImported} />;
}
