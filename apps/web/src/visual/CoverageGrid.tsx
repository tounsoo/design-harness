import { Button, Table, Text } from "@tounsoo/todae";
import { CircleAlert, CircleCheck, Minus } from "lucide-react";
import { humanize, scenarioLabel, screenTitle, viewLabel } from "../app/words";
import type { FrameKey } from "../runtime/session";
import type { Coverage, CoverageCell } from "./coverage";

/**
 * States against views, as a real table: each cell says what its artboard
 * has to fix, in words with a mark, and is a button that goes to it. A flow
 * state no scenario shows is a dashed row with nowhere to go, which is the
 * hole the state-coverage rule reports.
 */
export function CoverageGrid({ coverage, onGo }: { readonly coverage: Coverage; readonly onGo: (key: FrameKey) => void }) {
  return (
    <div className="coverage" data-testid="coverage-grid">
      <Table.Root className="coverage-table">
        <Table.Caption className="coverage-caption">
          Every state, every view: {coverage.covered} of {coverage.states} flow {coverage.states === 1 ? "state has" : "states have"} a scenario
        </Table.Caption>
        <Table.Head>
          <Table.Row>
            <Table.HeaderCell scope="col">State</Table.HeaderCell>
            {coverage.views.map((view) => (
              <Table.HeaderCell key={view} scope="col">
                {viewLabel(view)}
              </Table.HeaderCell>
            ))}
          </Table.Row>
        </Table.Head>
        <Table.Body>
          {coverage.rows.map((row) =>
            row.kind === "never-drawn" ? (
              <Table.Row key={`state ${row.state}`} data-state={row.state} data-testid="coverage-row">
                <Table.HeaderCell scope="row">
                  {humanize(row.state)}
                  <Text.Root as="span" tone="muted" className="coverage-sub">
                    No scenario yet
                  </Text.Root>
                </Table.HeaderCell>
                <Table.Cell colSpan={Math.max(1, coverage.views.length)}>
                  <span className="coverage-cell" data-kind="never-drawn" data-testid="coverage-never">
                    <span className="coverage-icon" aria-hidden="true">
                      <Minus />
                    </span>
                    Never drawn: add a scenario
                  </span>
                </Table.Cell>
              </Table.Row>
            ) : (
              <Table.Row key={row.scenario} data-state={row.state} data-scenario={row.scenario} data-testid="coverage-row">
                <Table.HeaderCell scope="row">
                  {screenTitle({ page: row.page || row.state, state: row.state })}
                  <Text.Root as="span" tone="muted" className="coverage-sub">
                    {scenarioLabel(row.scenario)}
                  </Text.Root>
                </Table.HeaderCell>
                {row.cells.map((cell, index) => (
                  <Table.Cell key={cell.key}>
                    <Button.Root variant="ghost" className="coverage-cell" data-kind={cell.kind} data-testid="coverage-cell" data-frame={cell.key} onClick={() => onGo(cell.key)} aria-label={`${cellWords(cell)}: show ${scenarioLabel(row.scenario)}, ${viewLabel(coverage.views[index] ?? "").toLowerCase()}`}>
                      <span className="coverage-icon" aria-hidden="true">
                        {cell.kind === "passes" ? <CircleCheck /> : cell.kind === "measuring" ? <Minus /> : <CircleAlert />}
                      </span>
                      {cellWords(cell)}
                    </Button.Root>
                  </Table.Cell>
                ))}
              </Table.Row>
            ),
          )}
        </Table.Body>
      </Table.Root>
    </div>
  );
}

export function cellWords(cell: CoverageCell): string {
  switch (cell.kind) {
    case "passes":
      return "Passes";
    case "to-fix":
      return `${cell.count} to fix`;
    case "measuring":
      return "Measuring";
    case "failed":
      return cell.why;
  }
}
