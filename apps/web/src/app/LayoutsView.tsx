import { Badge, Card, Code, Disclosure, Stack, Table, Text } from "@tounsoo/todae";
import { useMemo } from "react";
import { layoutPreview, specLayouts, type LayoutSummary, type ProjectConfig } from "@design-harness/core";
import type { PrototypeRecord } from "../store/project-file";
import { FrameCard } from "./Board";
import { useSessions, type Measured } from "./sessions";
import { humanize } from "./words";

/** How a value reads in the table: short JSON. */
function shown(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/**
 * The open spec prototype's layouts, read from core: each one's parameters
 * (name, type in core's words, whether it is required, its default and
 * example, its description), where the prototype draws it, and a preview:
 * the layout alone, drawn with its examples in a frame of its own at the
 * project's first view, as core's `layoutPreview` writes it.
 */
export function LayoutsView({ config, record }: { readonly config: ProjectConfig; readonly record: PrototypeRecord }) {
  const layouts = useMemo(() => specLayouts(record.prototype, config), [record.prototype, config]);
  // One view, cut short, is enough to see a layout alone; the preview is a picture, and its checks are not shown.
  const previewConfig = useMemo(() => ({ ...config, views: config.views.slice(0, 1).map((view) => ({ ...view, height: Math.min(view.height, 480) })) }), [config]);
  const previews = useMemo(
    () =>
      layouts.flatMap((layout) => {
        const preview = layoutPreview(record.prototype, config, layout.id);
        return preview ? [{ id: layout.id, config: previewConfig, prototype: preview.prototype, missing: preview.missing }] : [];
      }),
    [layouts, record.prototype, config, previewConfig],
  );
  const measured = useSessions(previews);
  return (
    <section aria-labelledby="project-layouts" data-testid="project-layouts">
      <Stack.Root gap="normal">
        <div className="section-head">
          <Text.Root as="h2" id="project-layouts">
            Layouts of {record.name}
          </Text.Root>
          <Text.Root as="p" tone="muted">
            Reusable blocks a page draws with its own values. Each is shown alone with its example values; its parameters are under it.
          </Text.Root>
        </div>
        {layouts.length === 0 && <Text.Root as="p">This prototype has no layouts.</Text.Root>}
        {layouts.map((layout) => (
          <LayoutCard key={layout.id} layout={layout} preview={measured.find((item) => item.id === layout.id)} missing={previews.find((item) => item.id === layout.id)?.missing ?? []} />
        ))}
      </Stack.Root>
    </section>
  );
}

function LayoutCard({ layout, preview, missing }: { readonly layout: LayoutSummary; readonly preview: Measured | undefined; readonly missing: readonly string[] }) {
  const frame = preview?.state.frames[0];
  return (
    <Card.Root className="layout-card" data-layout={layout.id}>
      <Card.Header>
        <Stack.Root direction="row" align="center" gap="condensed" wrap>
          <Text.Root as="h3">{humanize(layout.id)}</Text.Root>
          <Badge.Root tone={layout.inventoried ? "success" : "warning"}>{layout.inventoried ? "In the inventory" : "Not in the inventory"}</Badge.Root>
        </Stack.Root>
      </Card.Header>
      <Card.Body>
        <div className="layout-card-body">
          <div className="layout-card-preview" data-testid="layout-preview">
            {preview && frame ? (
              <FrameCard session={preview.session} spec={frame} revision={preview.state.revision} frameState={preview.state.frameStates[frame.key] ?? { state: "waiting" }} scale={0.36} focused={false} hidden={false} selected={false} label={`${layout.id} preview`} />
            ) : (
              <Text.Root as="p" tone="muted">
                No preview: the project has no page type with a body to draw it in.
              </Text.Root>
            )}
            {missing.length > 0 && (
              <Text.Root as="p" tone="muted">
                Drawn without {missing.join(", ")}, which {missing.length === 1 ? "has" : "have"} no example or default.
              </Text.Root>
            )}
          </div>
          <Text.Root as="p" tone="muted">
            {layout.uses.length === 0 ? "No page draws it." : `Drawn at ${layout.uses.map((use) => `${use.file}:${use.line}`).join(", ")}.`}
          </Text.Root>
          <Disclosure.Root className="layout-card-params">
            <Disclosure.Summary>{layout.params.length === 0 ? "No parameters" : `Parameters (${layout.params.length})`}</Disclosure.Summary>
            <Stack.Root gap="condensed">
              <Text.Root as="p" tone="muted">
                <Code.Root>{layout.id}</Code.Root> in <Code.Root>{layout.file}</Code.Root>
              </Text.Root>
              {layout.params.length === 0 ? (
                <Text.Root as="p">No parameters: every instance draws the same thing.</Text.Root>
              ) : (
                <Table.Root className="project-table" aria-label={`Parameters of ${layout.id}`}>
                  <Table.Head>
                    <Table.Row>
                      <Table.HeaderCell>Parameter</Table.HeaderCell>
                      <Table.HeaderCell>Type</Table.HeaderCell>
                      <Table.HeaderCell>Required</Table.HeaderCell>
                      <Table.HeaderCell>Default or example</Table.HeaderCell>
                    </Table.Row>
                  </Table.Head>
                  <Table.Body>
                    {layout.params.map((param) => (
                      <Table.Row key={param.name} data-param={param.name}>
                        <Table.Cell>
                          <Code.Root>{param.name}</Code.Root>
                          {param.description ? ` ${param.description}` : ""}
                        </Table.Cell>
                        <Table.Cell>{param.words}</Table.Cell>
                        <Table.Cell>{param.required ? "yes" : "no"}</Table.Cell>
                        <Table.Cell>{param.default !== undefined ? `default ${shown(param.default)}` : param.example !== undefined ? `e.g. ${shown(param.example)}` : "none"}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              )}
            </Stack.Root>
          </Disclosure.Root>
        </div>
      </Card.Body>
    </Card.Root>
  );
}
