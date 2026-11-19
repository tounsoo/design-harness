import type { PartDescription, ProjectConfig } from "@design-harness/core";
import todae0101 from "../../../../packages/core/libraries/todae-0.10.1.json";
import todae0113 from "../../../../packages/core/libraries/todae-0.11.3.json";

/**
 * Stored projects from before spec prototypes have no `library.parts`, the
 * description of the library's parts a spec is checked against. On load the
 * app adds the description bundled for exactly that package and version, if
 * there is one; otherwise it says plainly that spec prototypes cannot be
 * checked in that project, and leaves the config as it is. A stored TSX
 * prototype never needs the description, but it is read-only.
 */

type Parts = Readonly<Record<string, PartDescription>>;

/**
 * The library descriptions this app ships, by `package@version`: written by
 * core's describe-library script. A project gets the one for exactly its
 * library's version, so a project stored on an older Todae keeps checking.
 */
export const BUNDLED_PARTS: Readonly<Record<string, Parts>> = Object.fromEntries(
  [todae0101, todae0113].map((description) => [`${description.package}@${description.version}`, description.parts as Parts]),
);

/** Something the app changed or found about stored data on load, said once. */
export type LoadNote = { readonly tone: "info" | "warning"; readonly title: string; readonly text: string };

export type Migration =
  | { readonly kind: "unchanged"; readonly config: ProjectConfig }
  | { readonly kind: "added-parts"; readonly config: ProjectConfig; readonly note: string }
  | { readonly kind: "no-parts"; readonly config: ProjectConfig; readonly note: string };

export function withLibraryParts(config: ProjectConfig, bundled: Readonly<Record<string, Parts>> = BUNDLED_PARTS): Migration {
  if (config.library.parts) return { kind: "unchanged", config };
  const { package: name, version } = config.library;
  const parts = bundled[`${name}@${version}`];
  if (!parts) {
    return {
      kind: "no-parts",
      config,
      note: `Project "${config.name}" uses ${name} ${version}, and this app has no description of that library's parts, so no prototype can be made or edited in it: its spec prototypes cannot be checked, and its TSX ones are read-only. Import a project file whose config has library.parts for ${name} ${version} to use specs.`,
    };
  }
  return {
    kind: "added-parts",
    config: { ...config, library: { ...config.library, parts } },
    note: `Project "${config.name}" was stored before spec prototypes, without a description of its library's parts. The app added the one it ships for ${name} ${version} (${Object.keys(parts).length} parts), so spec prototypes can be checked in it.`,
  };
}
