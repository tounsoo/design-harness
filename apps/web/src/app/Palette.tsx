import { Badge, Card, Code, Text, VisuallyHidden, useAppearance } from "@tounsoo/todae";
import { Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { partSpecimen, unplacedRoles, type PartSpecimen, type ProjectConfig, type RoleName, type SpecimenSample } from "@design-harness/core";
import { SHIPPED_LIBRARIES } from "../libraries/registry";
import { FrameViewport } from "./Board";
import { useSessions } from "./sessions";
import { ROLE_WORDS } from "./wizard-model";

/**
 * The project's components as a palette: each one drawn by the project's
 * own library and version in a sandboxed frame, from the specimen core
 * writes (`partSpecimen`), with the roles the rules know its parts by named
 * under it. The app never draws a part itself: a component core cannot
 * compose shows its name and "No specimen", with core's reason.
 *
 * A tile's frame is made only once the tile has been scrolled to, and it
 * renders through the app's shared render slots like every other frame, so
 * a long palette costs what is on screen.
 */

/** True once the element has come near the scrolling area's view, and from then on. */
export function useSeen<T extends Element>(): [(element: T | null) => void, boolean] {
  const [seen, setSeen] = useState(false);
  const observer = useRef<IntersectionObserver | null>(null);
  const ref = useCallback((element: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") return setSeen(true);
    observer.current = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setSeen(true);
        observer.current?.disconnect();
      },
      { rootMargin: "160px" },
    );
    observer.current.observe(element);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, seen];
}

/** Props this deployment gives a shipped library's parts beside their own, as the New project wizard does. */
function partPropsOf(config: ProjectConfig) {
  // By package: a project may have moved to another version of a library this deployment ships.
  return SHIPPED_LIBRARIES.find((library) => library.package === config.library.package)?.setup.partProps;
}

/** A component's specimen in the app's own colour scheme, so the tile reads as part of the page. */
export function useSpecimen(config: ProjectConfig, component: string): PartSpecimen {
  const scheme = useAppearance();
  return useMemo(() => partSpecimen(config, component, scheme, partPropsOf(config)), [config, component, scheme]);
}

/** A role as a tag with a pointer: which role the rules know a part by. Never a status, so never a tone. */
export function RoleTag({ role }: { readonly role: RoleName }) {
  return (
    <span className="role-tag" data-role={role}>
      {ROLE_WORDS[role].title.toLowerCase()}
    </span>
  );
}

/** The specimen itself: the frame, drawn once scrolled to, or why there is none. */
export function SpecimenStage({ specimen, label }: { readonly specimen: PartSpecimen; readonly label: string }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const items = useMemo(() => (specimen.ok && seen ? [{ id: `specimen:${specimen.component}`, config: specimen.config, prototype: specimen.prototype }] : []), [specimen, seen]);
  const [measured] = useSessions(items);
  const frame = measured?.state.frames[0];
  const frameState = measured && frame ? (measured.state.frameStates[frame.key] ?? { state: "waiting" as const }) : undefined;
  return (
    <div className="specimen-stage" ref={ref} data-testid="specimen-stage" data-state={!specimen.ok ? "none" : (frameState?.state ?? "unseen")}>
      {!specimen.ok ? (
        <div className="specimen-none">
          <Text.Root as="p" weight="medium">
            No specimen
          </Text.Root>
          <Text.Root as="p" tone="muted">
            {specimen.why}
          </Text.Root>
        </div>
      ) : measured && frame && frameState ? (
        <FrameViewport session={measured.session} spec={frame} revision={measured.state.revision} frameState={frameState} scale={1} hidden={false} name={label} fit />
      ) : null}
    </div>
  );
}

function sampleCount(specimen: PartSpecimen): string {
  const parts = `${specimen.parts} ${specimen.parts === 1 ? "part" : "parts"}`;
  return specimen.ok && specimen.samples.length > 1 ? `${parts}; ${specimen.samples.length} drawn` : parts;
}

function SampleLine({ sample }: { readonly sample: SpecimenSample }) {
  return (
    <li className="specimen-sample" data-sample={sample.label}>
      <span className="specimen-sample-name">
        {sample.rank !== undefined && (
          <span className="rank" data-testid="specimen-rank">
            <VisuallyHidden.Root>Rank </VisuallyHidden.Root>
            {sample.rank}
          </span>
        )}
        <span>&ldquo;{sample.label}&rdquo;</span>
      </span>
      <span className="specimen-sample-roles">
        {sample.roles.length === 0 ? (
          <Text.Root as="span" tone="muted">
            no role
          </Text.Root>
        ) : (
          sample.roles.map((item) => (
            <span key={item.role} className="specimen-role">
              <RoleTag role={item.role} />
              {/* A part's own name says nothing a designer needs; a prop's value does. */}
              {item.how !== sample.part && <span className="specimen-how">{item.how}</span>}
            </span>
          ))
        )}
      </span>
    </li>
  );
}

export type TileMark = "new" | "removed";

/**
 * One component of the palette: its specimen on the library's own ground,
 * and under it, on the app's, its name, how many parts it has, and each
 * drawn sample with the roles it carries.
 */
export function SpecimenTile({ config, component, mark, children }: { readonly config: ProjectConfig; readonly component: string; readonly mark?: TileMark | undefined; readonly children?: ReactNode }) {
  const specimen = useSpecimen(config, component);
  const samples = specimen.ok ? specimen.samples : [];
  const roled = samples.some((sample) => sample.roles.length > 0 || sample.rank !== undefined);
  const id = `specimen-${component}`;
  return (
    <Card.Root className="specimen" data-component={component} data-mark={mark} role="group" aria-labelledby={id}>
      <SpecimenStage specimen={specimen} label={`${component}, drawn by ${config.library.package}`} />
      <div className="specimen-foot">
        <div className="specimen-head">
          <Text.Root as="h4" id={id} className="figure-title">
            {component}
          </Text.Root>
          {mark === "new" && (
            <Badge.Root tone="success" data-testid="specimen-mark">
              <Plus aria-hidden="true" /> New
            </Badge.Root>
          )}
          {mark === "removed" && (
            <Badge.Root tone="critical" data-testid="specimen-mark">
              <Minus aria-hidden="true" /> Removed
            </Badge.Root>
          )}
        </div>
        <Text.Root as="p" tone="muted">
          {sampleCount(specimen)}
        </Text.Root>
        {roled && (
          <ul className="specimen-samples" aria-label={`What is drawn for ${component}, top to bottom, and the role each has`}>
            {samples.map((sample, index) => (
              <SampleLine key={index} sample={sample} />
            ))}
          </ul>
        )}
        {specimen.ok && specimen.standIn !== undefined && (
          <Text.Root as="p" tone="muted" data-testid="specimen-stand-in">
            It draws no ink of its own: the three <Code.Root>{specimen.standIn}</Code.Root> inside are stand-ins that show how it places things.
          </Text.Root>
        )}
        {specimen.ok && samples.some((sample) => sample.roles.some((item) => item.role === "disclosure")) && (
          <Text.Root as="p" tone="muted">
            Shown closed, as a page opens it.
          </Text.Root>
        )}
        {children}
      </div>
    </Card.Root>
  );
}

/** Every inventoried component as a tile, and each role no tile can carry, in words. */
export function Palette({ config }: { readonly config: ProjectConfig }) {
  const unplaced = useMemo(() => unplacedRoles(config), [config]);
  const { components } = config.inventories;
  if (components.length === 0) {
    return (
      <Text.Root as="p" tone="muted">
        No components yet.
      </Text.Root>
    );
  }
  return (
    <div className="palette-wrap" data-testid="palette">
      <ul className="evidence-legend">
        <li>
          <RoleTag role="primary-action" /> a role the rules select by
        </li>
        <li>
          <span className="rank" aria-hidden="true">
            1
          </span>
          its rank in the project&apos;s ranking
        </li>
      </ul>
      <ul className="palette" aria-label="Components">
        {components.map((component) => (
          <li key={component}>
            <SpecimenTile config={config} component={component} />
          </li>
        ))}
      </ul>
      {unplaced.length > 0 && (
        <ul className="palette-unplaced" data-testid="palette-unplaced" aria-label="Roles no component here carries">
          {unplaced.map((item) => (
            <li key={item.role}>
              <RoleTag role={item.role} /> {item.why}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
