import { Alert, Badge, Button, Code, DataList, Disclosure, Field, Label, Stack, Table, Text } from "@tounsoo/todae";
import { useEffect, useId, useState } from "react";
import { chooseLibrarySource, moveLibrary, planLibraryMove, reportChanges, type LibraryDescription, type LibraryEvent, type LibraryMovePlan, type ProjectConfig } from "@design-harness/core";
import { SHIPPED_LIBRARIES } from "../libraries/registry";
import { currentDescription, describedVersions } from "../libraries/versions";
import { sortVersions, type PackageSource } from "../runtime/package-source";
import type { SessionState } from "../runtime/session";
import { isSpecRecord, type PrototypeRecord } from "../store/project-file";
import { formatTime } from "../review/timeline";
import { ESM_FALLBACK, packageSources } from "./runtime";

/**
 * A project's library version: what the page serves, what to do when it
 * does not serve the project's version, and moving the project to another
 * version it serves, after a dry run and only on a confirm.
 *
 * Two places show it. Above the canvas, `PackagesNotice` says plainly when a
 * project's frames cannot load its library and offers what a person can do:
 * move the project to a version this app serves, or, when the deployment
 * allows it, load that exact version from esm.sh for this project. It also
 * stays up, quietly, while a project loads from esm.sh, so the choice is
 * never hidden. In the Project view, `LibraryVersionSection` holds the move:
 * core's comparison of the two versions' descriptions, whether every role
 * still holds, and how each prototype's report would change.
 */

/** The library by the name a person knows it: Todae, Mantine, or its package. */
export function libraryName(name: string): string {
  return SHIPPED_LIBRARIES.find((library) => library.package === name)?.name ?? name;
}

/** The versions of a package a source serves, once it has said; `any` for a CDN. */
function useServed(source: PackageSource, name: string): readonly string[] | "any" | null {
  const [served, setServed] = useState<{ readonly name: string; readonly versions: readonly string[] | "any" } | null>(null);
  useEffect(() => {
    let live = true;
    const ask = source.versions?.(name) ?? Promise.resolve("any" as const);
    ask.then(
      (versions) => live && setServed({ name, versions }),
      () => live && setServed({ name, versions: [] }),
    );
    return () => {
      live = false;
    };
  }, [source, name]);
  return served?.name === name ? served.versions : null;
}

/** The versions a project on `name` can move to here: described by the app, served by the page, not the one it is on. */
function moveTargets(name: string, current: string, served: readonly string[] | "any" | null): string[] {
  if (served === null) return [];
  return sortVersions(describedVersions(name).map((entry) => entry.version).filter((version) => version !== current && (served === "any" || served.includes(version)))).reverse();
}

const stamp = () => ({ at: new Date().toISOString(), by: "you" });

type NoticeProps = {
  readonly config: ProjectConfig;
  readonly packages: SessionState["packages"];
  /** Opens the Project view's library section, with a version picked. */
  readonly onMove: (target: string) => void;
  readonly onSave: (next: ProjectConfig) => void;
};

/**
 * Above the canvas: why this project's frames cannot load its library, and
 * what a person can do about it; or, while the project loads from esm.sh by
 * its own choice, that it does.
 */
export function PackagesNotice({ config, packages, onMove, onSave }: NoticeProps) {
  const { page } = packageSources();
  const { package: name, version, source } = config.library;
  const served = useServed(page, name);
  const targets = moveTargets(name, version, served);
  const label = `${libraryName(name)} ${version}`;
  const chooseEsm = () => onSave(chooseLibrarySource(config, "esm.sh", stamp()));
  const chooseDeployment = () => onSave(chooseLibrarySource(config, "deployment", stamp()));
  const moveButtons = targets.map((target) => (
    <Button.Root key={target} variant={target === targets[0] ? "primary" : "secondary"} onClick={() => onMove(target)}>
      {`Move the project to ${target}`}
    </Button.Root>
  ));

  if (packages.state === "ready" && source === "esm.sh") {
    return (
      <Alert.Root tone="info" className="packages-notice" data-testid="packages-notice" data-state="esm">
        <Alert.Title>{`${label} loads from esm.sh for this project`}</Alert.Title>
        <Alert.Description>
          <Stack.Root gap="condensed">
            <Text.Root as="p">You chose this because this app does not serve {label}. Its frames load that exact version from esm.sh, a public CDN outside this app; nothing else in them changes, and the checks are the same.</Text.Root>
            <Stack.Root direction="row" gap="condensed" wrap>
              {moveButtons}
              <Button.Root variant="secondary" onClick={chooseDeployment}>
                Stop loading from esm.sh
              </Button.Root>
            </Stack.Root>
          </Stack.Root>
        </Alert.Description>
      </Alert.Root>
    );
  }
  if (packages.state !== "failed") return null;

  const unserved = Array.isArray(served) && !served.includes(version);
  const fromEsm = source === "esm.sh" && ESM_FALLBACK;
  return (
    <Alert.Root tone="critical" className="packages-notice" data-testid="packages-notice" data-state={fromEsm ? "esm-failed" : unserved ? "unserved" : "failed"}>
      <Alert.Title>{fromEsm ? `${label} could not load from esm.sh` : unserved ? `This app does not serve ${label}` : `${label} could not load`}</Alert.Title>
      <Alert.Description>
        <Stack.Root gap="condensed">
          {unserved && !fromEsm && (
            <Text.Root as="p" data-testid="packages-missing">
              {`The project is on ${name} ${version}. This app serves ${Array.isArray(served) && served.length > 0 ? `${served.join(", ")} of it` : "no version of it"}, so no frame can render until the project loads ${version} from somewhere, or moves.`}
            </Text.Root>
          )}
          {source === "esm.sh" && !ESM_FALLBACK && <Text.Root as="p">The project is set to load {label} from esm.sh, and this deployment does not load packages from esm.sh.</Text.Root>}
          {fromEsm && <Text.Root as="p">The project is set to load {label} from esm.sh, and that did not work. The message below says why.</Text.Root>}
          <Text.Root as="p" weight="medium">
            What you can do
          </Text.Root>
          <ul className="packages-options">
            <li>
              {targets.length > 0 ? (
                <Stack.Root gap="condensed">
                  <Text.Root as="p">Move the project to a version this app serves. You see what changes, part by part and prototype by prototype, before anything moves.</Text.Root>
                  <Stack.Root direction="row" gap="condensed" wrap>
                    {moveButtons}
                  </Stack.Root>
                </Stack.Root>
              ) : (
                <Text.Root as="p">Move the project to another version: this app has no other version of {libraryName(name)} that it both describes and serves.</Text.Root>
              )}
            </li>
            {unserved && !fromEsm && (
              <li>
                {ESM_FALLBACK ? (
                  <Stack.Root gap="condensed">
                    <Text.Root as="p">{`Load ${version} from esm.sh, for this project only. Its frames would load that exact version from esm.sh, a public CDN outside this app; the choice is kept with the project and shown here while it lasts. This app has not been tested against esm.sh itself.`}</Text.Root>
                    <div>
                      <Button.Root variant="secondary" onClick={chooseEsm}>
                        {`Load ${version} from esm.sh`}
                      </Button.Root>
                    </div>
                  </Stack.Root>
                ) : (
                  <Text.Root as="p">This deployment does not load packages from esm.sh, so a version it does not serve can only be moved from.</Text.Root>
                )}
              </li>
            )}
            {fromEsm && (
              <li>
                <Button.Root variant="secondary" onClick={chooseDeployment}>
                  Stop loading from esm.sh
                </Button.Root>
              </li>
            )}
          </ul>
          <Disclosure.Root>
            <Disclosure.Summary>The message</Disclosure.Summary>
            <Text.Root as="p" className="pre" data-testid="packages-message">
              {packages.message}
            </Text.Root>
          </Disclosure.Root>
        </Stack.Root>
      </Alert.Description>
    </Alert.Root>
  );
}

type SectionProps = {
  readonly config: ProjectConfig;
  readonly prototypes: readonly PrototypeRecord[];
  readonly onSave: (next: ProjectConfig) => void;
  /** A version picked elsewhere (the notice above the canvas), to compare straight away. */
  readonly target?: string | undefined;
};

type Compared = { readonly to: string; readonly from: LibraryDescription; readonly description: LibraryDescription; readonly stylesheets?: readonly string[]; readonly plan: LibraryMovePlan } | { readonly to: string; readonly error: string };

/** The Project view's library section: the version the project is on, where it loads from, and moving it. */
export function LibraryVersionSection({ config, prototypes, onSave, target }: SectionProps) {
  const { page } = packageSources();
  const { package: name, version, source } = config.library;
  const served = useServed(page, name);
  const targets = moveTargets(name, version, served);
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = picked !== null && targets.includes(picked) ? picked : target && targets.includes(target) ? target : (targets[0] ?? "");
  const [compared, setCompared] = useState<Compared | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const selectId = useId();

  const compare = async (to: string) => {
    const entry = describedVersions(name).find((item) => item.version === to);
    const from = await currentDescription(config);
    if (!entry || !from) {
      setCompared({ to, error: !entry ? `This app has no description of ${name} ${to}.` : `This app has no description of ${name} ${version}, the version the project is on, to compare with.` });
      return;
    }
    const description = await entry.describe();
    const shipped = SHIPPED_LIBRARIES.find((library) => library.package === name && library.version === to);
    const stylesheets = shipped?.setup.stylesheets;
    const plan = planLibraryMove(config, from, description, prototypes.filter(isSpecRecord).map((record) => ({ id: record.id, name: record.name, prototype: record.prototype })), stylesheets ? { stylesheets } : {});
    setCompared({ to, from, description, ...(stylesheets ? { stylesheets } : {}), plan });
  };

  // A version picked from the notice above the canvas is compared at once: the person asked to see the move.
  useEffect(() => {
    if (target && targets.includes(target)) void compare(target);
    // Only when the notice picks a version, or once the served versions are known.
  }, [target, served]);

  const confirm = (plan: Extract<Compared, { plan: LibraryMovePlan }>) => {
    const result = moveLibrary(config, plan.from, plan.description, stamp(), plan.stylesheets ? { stylesheets: plan.stylesheets } : {});
    if (!result.ok) {
      setCompared({ to: plan.to, error: result.error.join(" ") });
      return;
    }
    setMoved(`${version} → ${plan.to}`);
    setCompared(null);
    setPicked(null);
    onSave(result.value);
  };

  const isServed = served === "any" || (Array.isArray(served) && served.includes(version));
  return (
    <section aria-labelledby="project-library-version" data-testid="library-version">
      <div className="section-head">
        <Text.Root as="h2" id="project-library-version">
          Component library
        </Text.Root>
        <Text.Root as="p" tone="muted">
          The exact version every frame renders with. Moving to another version is your call: you see what changes first, and nothing moves until you confirm.
        </Text.Root>
      </div>
      <DataList.Root orientation="horizontal" className="project-facts">
        <DataList.Item>
          <DataList.Term>Library</DataList.Term>
          <DataList.Details>
            <span data-testid="library-version-current">{`${libraryName(name)} ${version}`}</span> <Code.Root>{name}</Code.Root>
          </DataList.Details>
        </DataList.Item>
        <DataList.Item>
          <DataList.Term>Loads from</DataList.Term>
          <DataList.Details>
            {source === "esm.sh" ? (
              <>
                <Badge.Root tone="info">esm.sh</Badge.Root> chosen for this project{" "}
                <Button.Root variant="ghost" onClick={() => onSave(chooseLibrarySource(config, "deployment", stamp()))}>
                  Stop loading from esm.sh
                </Button.Root>
              </>
            ) : served === null ? (
              "…"
            ) : isServed ? (
              `this app (${page.name === "local" ? "served with the app" : page.name})`
            ) : (
              <>
                <Badge.Root tone="critical">not served</Badge.Root> {`this app serves ${Array.isArray(served) && served.length > 0 ? served.join(", ") : "no version of it"}`}
              </>
            )}
          </DataList.Details>
        </DataList.Item>
      </DataList.Root>

      {moved && (
        <Alert.Root tone="success" data-testid="library-moved">
          <Alert.Title>{`Moved: ${libraryName(name)} ${moved}`}</Alert.Title>
          <Alert.Description>The move is recorded in the project&apos;s history below. The canvas renders and measures every frame again on the new version.</Alert.Description>
        </Alert.Root>
      )}

      {targets.length === 0 ? (
        <Text.Root as="p" tone="muted">
          {served === null ? "Reading which versions this app serves…" : `This app has no other version of ${libraryName(name)} that it both describes and serves.`}
        </Text.Root>
      ) : (
        <Stack.Root direction="row" align="end" gap="condensed" wrap className="library-move-pick">
          <Stack.Root gap="condensed">
            <Label.Root htmlFor={selectId}>Move to</Label.Root>
            <Field.Root id={selectId} className="review-picker">
              <Field.Select value={chosen} onValueChange={(value) => (setPicked(value), setCompared(null))} data-testid="library-move-target">
                {targets.map((item) => (
                  <option key={item} value={item}>
                    {`${libraryName(name)} ${item}`}
                  </option>
                ))}
              </Field.Select>
            </Field.Root>
          </Stack.Root>
          <Button.Root variant="secondary" onClick={() => void compare(chosen)} disabled={chosen === ""}>
            {`See what changes in ${chosen}`}
          </Button.Root>
        </Stack.Root>
      )}

      {compared && "error" in compared && (
        <Alert.Root tone="critical" data-testid="library-move-error">
          <Alert.Title>The move cannot be compared</Alert.Title>
          <Alert.Description>{compared.error}</Alert.Description>
        </Alert.Root>
      )}
      {compared && "plan" in compared && <MovePlan name={name} from={version} compared={compared} onConfirm={() => confirm(compared)} onCancel={() => setCompared(null)} />}

      <History events={config.library.history ?? []} />
    </section>
  );
}

function MovePlan({ name, from, compared, onConfirm, onCancel }: { readonly name: string; readonly from: string; readonly compared: Extract<Compared, { plan: LibraryMovePlan }>; readonly onConfirm: () => void; readonly onCancel: () => void }) {
  const { plan, to } = compared;
  const { diff } = plan;
  const changing = plan.prototypes.filter(reportChanges);
  const parts = [
    diff.added.length > 0 ? `${diff.added.length} added` : null,
    diff.removed.length > 0 ? `${diff.removed.length} removed` : null,
    diff.renamed.length > 0 ? `${diff.renamed.length} renamed` : null,
    diff.changed.length > 0 ? `${diff.changed.length} changed` : null,
    `${diff.unchanged} the same`,
  ].filter((item): item is string => item !== null);
  return (
    <Stack.Root gap="normal" className="library-move-plan" data-testid="library-move-plan" data-to={to}>
      <Text.Root as="h3">{`From ${from} to ${to}: what changes`}</Text.Root>
      <Text.Root as="p" data-testid="library-move-parts">
        {`Parts: ${parts.join(", ")}.`}
      </Text.Root>
      {(diff.changed.length > 0 || diff.added.length > 0 || diff.removed.length > 0 || diff.renamed.length > 0) && (
        <Table.Root className="project-table" aria-label="Parts that change">
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Part</Table.HeaderCell>
              <Table.HeaderCell>Change</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {diff.removed.map((part) => (
              <Table.Row key={`removed-${part}`} data-part={part}>
                <Table.Cell>
                  <Code.Root>{part}</Code.Root>
                </Table.Cell>
                <Table.Cell>{`removed in ${to}`}</Table.Cell>
              </Table.Row>
            ))}
            {diff.renamed.map((pair) => (
              <Table.Row key={`renamed-${pair.from}`} data-part={pair.from}>
                <Table.Cell>
                  <Code.Root>{pair.from}</Code.Root>
                </Table.Cell>
                <Table.Cell>
                  most likely renamed <Code.Root>{pair.to}</Code.Root>: described exactly alike
                </Table.Cell>
              </Table.Row>
            ))}
            {diff.added.map((part) => (
              <Table.Row key={`added-${part}`} data-part={part}>
                <Table.Cell>
                  <Code.Root>{part}</Code.Root>
                </Table.Cell>
                <Table.Cell>{`new in ${to}`}</Table.Cell>
              </Table.Row>
            ))}
            {diff.changed.map((change) => (
              <Table.Row key={`changed-${change.part}`} data-part={change.part}>
                <Table.Cell>
                  <Code.Root>{change.part}</Code.Root>
                </Table.Cell>
                <Table.Cell>
                  {[change.added.length > 0 ? `adds ${change.added.join(", ")}` : "", change.removed.length > 0 ? `drops ${change.removed.join(", ")}` : "", change.changed.length > 0 ? `changes ${change.changed.join(", ")}` : "", ...change.other].filter(Boolean).join("; ")}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      )}
      <Text.Root as="p" data-testid="library-move-roles">
        {plan.roles.every((role) => role.problems.length === 0) ? `Every role still holds: each part the project maps a role to is in ${to}, with the props and values it names.` : `${plan.roles.filter((role) => role.problems.length > 0).length} roles no longer hold.`}
      </Text.Root>
      {plan.styleProps.length > 0 && (
        <Text.Root as="p" tone="muted">
          {`${to} has style props the project does not exclude: ${plan.styleProps.join(", ")}. A spec may set them until a proposal excludes them.`}
        </Text.Root>
      )}
      {plan.refusals.length > 0 ? (
        <Alert.Root tone="critical" data-testid="library-move-refused">
          <Alert.Title>This move cannot be made</Alert.Title>
          <Alert.Description>
            <ul className="packages-options">
              {plan.refusals.map((refusal) => (
                <li key={refusal}>{refusal}</li>
              ))}
            </ul>
          </Alert.Description>
        </Alert.Root>
      ) : (
        <>
          <Text.Root as="p" data-testid="library-move-reports">
            {changing.length === 0 ? `No prototype's report changes: core checks all ${plan.prototypes.length} the same on ${to}.` : `${changing.length} of ${plan.prototypes.length} prototypes' reports change.`}{" "}
            <Text.Root as="span" tone="muted">
              Checked by code without measuring; the canvas measures the rendered rules again after the move.
            </Text.Root>
          </Text.Root>
          <Table.Root className="project-table" aria-label="Prototypes' reports">
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell>Prototype</Table.HeaderCell>
                <Table.HeaderCell>Report</Table.HeaderCell>
                <Table.HeaderCell>What changes</Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {plan.prototypes.map((change) => (
                <Table.Row key={change.id} data-prototype={change.id} data-changes={reportChanges(change) ? "" : undefined}>
                  <Table.Cell>{change.name}</Table.Cell>
                  <Table.Cell>
                    <Badge.Root tone={reportChanges(change) ? "warning" : "neutral"}>{reportChanges(change) ? "changes" : "the same"}</Badge.Root>
                  </Table.Cell>
                  <Table.Cell>
                    {reportChanges(change)
                      ? [
                          ...change.rules.map((rule) => `${rule.rule}: ${rule.before} → ${rule.after}`),
                          ...change.added.map((finding) => `new: ${finding.message}`),
                          ...change.removed.map((finding) => `gone: ${finding.message}`),
                        ].join("; ")
                      : "nothing"}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
          <Stack.Root direction="row" gap="condensed" wrap>
            <Button.Root variant="primary" onClick={onConfirm} data-testid="library-move-confirm">
              {`Move ${libraryName(name)} to ${to}`}
            </Button.Root>
            <Button.Root variant="secondary" onClick={onCancel}>
              Cancel
            </Button.Root>
          </Stack.Root>
        </>
      )}
    </Stack.Root>
  );
}

function History({ events }: { readonly events: readonly LibraryEvent[] }) {
  if (events.length === 0) return null;
  return (
    <Stack.Root gap="condensed" data-testid="library-history">
      <Text.Root as="h3">History</Text.Root>
      <ul className="packages-options">
        {events.map((event, index) => (
          <li key={`${event.at}-${index}`}>
            {event.kind === "moved" ? `Moved from ${event.from} to ${event.to}` : event.source === "esm.sh" ? `Set ${event.version} to load from esm.sh` : `Set ${event.version} back to this app's packages`}
            {event.by ? ` by ${event.by}` : ""}, <time dateTime={event.at}>{formatTime(event.at)}</time>
            {event.kind === "moved" && event.note ? `: ${event.note}` : ""}
          </li>
        ))}
      </ul>
    </Stack.Root>
  );
}
