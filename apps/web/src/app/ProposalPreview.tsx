import { Text } from "@tounsoo/todae";
import { ArrowRight } from "lucide-react";
import { useId } from "react";
import { describeRule, type Finding, type ProjectConfig, type Proposal, type RenderedSnapshot } from "@design-harness/core";
import { CapChange, RuleFigure, SlotDiagram } from "../visual/project-figures";
import { previewLabel, proposalPreview, ruleBound, type ProposalPreview as Preview } from "../visual/project-model";
import { SpecimenStage, useSpecimen } from "./Palette";
import { humanize } from "./words";

/**
 * What a proposal would put in the project: the part it adds drawn live by
 * the project's library, a page type's slots, a length cap at its actual
 * size before and after, or its first rule's glyph when the rule is about
 * how the page looks. A count cap, a step budget, a state and any other
 * rule are words: the limit before and after with which way it moved. The
 * lead is chosen by the kind of its first change (`proposalPreview`).
 */

function LivePart({ config, component }: { readonly config: ProjectConfig; readonly component: string }) {
  const specimen = useSpecimen(config, component);
  return <SpecimenStage specimen={specimen} label={`${component}, drawn by ${config.library.package}`} />;
}

const steps = (count: number) => `${count} ${count === 1 ? "step" : "steps"}`;

function BudgetWords({ value }: { readonly value: number }) {
  return (
    <span className="count-words" data-testid="budget-words">
      at most {steps(value)}
    </span>
  );
}

export function PreviewFigure({ preview, config }: { readonly preview: Preview; readonly config: ProjectConfig }) {
  switch (preview.kind) {
    case "component":
      return (
        <div className="preview-part" data-removed={preview.removed ? "" : undefined}>
          <LivePart config={config} component={preview.name} />
          <Text.Root as="p" weight="medium">
            {preview.removed ? `${preview.name}, which it removes` : preview.name}
          </Text.Root>
        </div>
      );
    case "cap":
      return <CapChange name={preview.name} cap={preview.cap} before={preview.before} moved={preview.moved} />;
    case "budget":
      return (
        <div className="cap-change" data-testid="budget-change">
          <Text.Root as="p" weight="medium">
            {preview.task}
          </Text.Root>
          {preview.before !== undefined && (
            <>
              <BudgetWords value={preview.before} />
              <ArrowRight aria-hidden="true" className="cap-arrow" />
            </>
          )}
          <BudgetWords value={preview.after} />
          {preview.before !== undefined && preview.before !== preview.after && (
            <Text.Root as="span" weight="medium">
              {preview.after < preview.before ? "stricter: fewer steps" : "looser: more steps"}
            </Text.Root>
          )}
        </div>
      );
    case "page-type":
      return <SlotDiagram type={preview.pageType} />;
    case "flow-state":
      return (
        <span className="preview-state" data-removed={preview.removed ? "" : undefined}>
          {humanize(preview.state)}
        </span>
      );
    case "words":
      return (
        <div className="preview-words">
          <Text.Root as="span" tone="muted">
            {preview.label}
          </Text.Root>
          <Text.Root as="p" weight="medium">
            {preview.text}
          </Text.Root>
        </div>
      );
    case "rule":
      return (
        <div className="preview-rule">
          <RuleFigure rule={preview.rule} label={ruleBound(preview.rule, config)} />
          <Text.Root as="p">{describeRule(preview.rule, config)}</Text.Root>
        </div>
      );
    case "request":
      return (
        <div className="preview-plate">
          <Text.Root as="p" tone="muted">
            No figure yet: this needs a new rule type.
          </Text.Root>
        </div>
      );
    case "none":
      return (
        <Text.Root as="p" tone="muted">
          It changes nothing.
        </Text.Root>
      );
  }
}

/** The top of a proposal's card: the kind of its first change, the picture of it, and how many more changes it has. */
export function ProposalLead({ proposal, config }: { readonly proposal: Proposal; readonly config: ProjectConfig }) {
  const preview = proposalPreview(proposal, config);
  const total = proposal.inventory.length + proposal.rules.add.length + proposal.rules.remove.length;
  return (
    <div className="preview" data-preview={preview.kind} data-testid="proposal-preview">
      <Text.Root as="span" tone="muted" className="preview-label">
        {previewLabel(proposal)}
      </Text.Root>
      <div className="preview-figure">
        <PreviewFigure preview={preview} config={config} />
      </div>
      {total > 1 && (
        <Text.Root as="span" tone="muted" className="preview-more">
          +{total - 1} more {total - 1 === 1 ? "change" : "changes"}
        </Text.Root>
      )}
    </div>
  );
}

/**
 * A page in miniature, from the boxes its frame measured: text as bars,
 * controls outlined, and what a finding flags hatched, so the miniature
 * shows where on the person's page the new failure is. A schematic, not the
 * page's pixels, and hidden from a screen reader: core's message is beside it.
 */
export function SnapshotThumb({ snapshot, view, flagged }: { readonly snapshot: RenderedSnapshot; readonly view: { readonly width: number; readonly height: number }; readonly flagged: readonly number[] }) {
  const id = useId();
  const height = Math.min(Math.max(view.height, 1), Math.max(snapshot.scrollHeight ?? view.height, 1));
  const shown = snapshot.elements.map((element, index) => ({ element, index })).filter(({ element }) => element.visible && element.rect.width > 0 && element.rect.height > 0 && element.rect.y < height);
  return (
    <svg className="vis-svg thumb" viewBox={`0 0 ${view.width} ${height}`} aria-hidden="true" data-testid="snapshot-thumb">
      <defs>
        <pattern id={`${id}h`} className="vis-hatch" patternUnits="userSpaceOnUse" width={view.width / 40} height={view.width / 40} patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2={view.width / 40} />
        </pattern>
      </defs>
      <rect className="vis-box" x="0" y="0" width={view.width} height={height} />
      {shown.map(({ element, index }) =>
        flagged.includes(index) ? null : element.interactive ? (
          <rect key={index} className="thumb-control" x={element.rect.x} y={element.rect.y} width={element.rect.width} height={element.rect.height} rx={view.width / 160} />
        ) : element.text ? (
          <rect key={index} className={element.headingLevel ? "thumb-heading" : "thumb-text"} x={element.rect.x} y={element.rect.y + element.rect.height * 0.3} width={element.rect.width} height={Math.max(element.rect.height * 0.4, 2)} rx={view.width / 320} />
        ) : null,
      )}
      {shown
        .filter(({ index }) => flagged.includes(index))
        .map(({ element, index }) => (
          <rect key={index} className="vis-fail-area vis-fail-edge thumb-flag" x={element.rect.x} y={element.rect.y} width={element.rect.width} height={element.rect.height} fill={`url(#${id}h)`} data-testid="thumb-flag" />
        ))}
    </svg>
  );
}

/**
 * The snapshot to show for a prototype's new findings, and the elements they
 * flag in it: the frame of the first finding that names an element. When no
 * finding names one there is nothing to mark on a miniature, so there is no
 * miniature (`null`): core's message stands alone.
 */
export function flaggedIn(findings: readonly Finding[], snapshots: readonly RenderedSnapshot[]): { readonly snapshot: RenderedSnapshot; readonly elements: readonly number[] } | null {
  const first = findings.find((finding) => finding.scenario !== undefined && finding.view !== undefined && finding.element !== undefined);
  if (first) {
    const snapshot = snapshots.find((item) => item.scenario === first.scenario && item.view === first.view);
    if (snapshot) return { snapshot, elements: findings.filter((finding) => finding.scenario === first.scenario && finding.view === first.view && finding.element !== undefined).map((finding) => finding.element as number) };
  }
  return null;
}
