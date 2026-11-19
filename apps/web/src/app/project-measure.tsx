import { useMemo } from "react";
import type { ExistingPrototype, ProjectConfig } from "@design-harness/core";
import type { Session, SessionState } from "../runtime/session";
import { isSpecRecord, type PrototypeRecord, type SpecRecord } from "../store/project-file";
import { FrameCard } from "./Board";
import { measurementOf, useSessions, type Measured, type Measurement } from "./sessions";

/** The board's session, which measures the open prototype: its snapshots are that prototype's, so it is not measured twice. */
export type BoardSession = { readonly session: Session; readonly state: SessionState };

/**
 * Every spec prototype in the project with its measured snapshots (a stored
 * TSX one is checked by nothing, so it is left out), for core to
 * read under a config a proposal would make: the open prototype from the
 * board's own session, each other one from a session of its own. `existing`
 * is null until every one has answered; a prototype whose frames could not
 * all be measured is given with no snapshots, so rendered rules do not run
 * on it rather than run on part of it. `frames` must be mounted
 * (`MeasureFrames`) or the other prototypes' sessions wait forever. With
 * `live` false nothing is measured.
 */
export function useProjectExisting({ config, prototypes, openPrototypeId, board, live }: { readonly config: ProjectConfig; readonly prototypes: readonly PrototypeRecord[]; readonly openPrototypeId: string; readonly board: BoardSession; readonly live: boolean }): {
  readonly existing: readonly ExistingPrototype[] | null;
  readonly frames: readonly Measured[];
  readonly progress: { readonly answered: number; readonly total: number };
} {
  const others = useMemo(() => (live ? prototypes.filter(isSpecRecord).filter((record) => record.id !== openPrototypeId) : []), [live, prototypes, openPrototypeId]);
  const otherItems = useMemo(() => others.map((record) => ({ id: `prototype-${record.id}`, config, prototype: record.prototype })), [others, config]);
  const frames = useSessions(otherItems);
  const openRecord = prototypes.filter(isSpecRecord).find((record) => record.id === openPrototypeId);
  const boardCurrent = board.session.current();
  const openMeasurement: Measurement | null = !live || !openRecord ? null : boardCurrent?.prototype === openRecord.prototype && board.state.revision === boardCurrent.revision ? measurementOf(board.state) : { state: "measuring", answered: 0, total: board.state.frames.length };
  const existing: readonly ExistingPrototype[] | null = useMemo(() => {
    if (!live) return null;
    const out: ExistingPrototype[] = [];
    const add = (record: SpecRecord, measurement: Measurement) => out.push({ name: record.name, prototype: record.prototype, snapshots: measurement.state === "measured" ? measurement.snapshots : [] });
    if (openRecord && openMeasurement) {
      if (openMeasurement.state === "measuring") return null;
      add(openRecord, openMeasurement);
    }
    for (const [index, record] of others.entries()) {
      const measured = frames[index];
      if (!measured || measured.measurement.state === "measuring") return null;
      add(record, measured.measurement);
    }
    return out;
    // The measurements' states decide; their objects are new on every render.
  }, [live, openRecord, openMeasurement?.state, others, frames.map((item) => item.measurement.state).join(",")]);
  const states = [...(openMeasurement ? [openMeasurement] : []), ...frames.map((item) => item.measurement)];
  const progress = states.reduce((sum, state, index) => {
    const total = state.state === "measuring" ? state.total : index === 0 && openMeasurement ? board.state.frames.length : (frames[index - (openMeasurement ? 1 : 0)]?.state.frames.length ?? 0);
    return { answered: sum.answered + (state.state === "measuring" ? state.answered : total), total: sum.total + total };
  }, { answered: 0, total: 0 });
  return { existing, frames, progress };
}

/**
 * The frames that measure the project's other prototypes: laid out at their
 * views' sizes, so they measure as the board would, but not shown. Without
 * them those sessions would wait forever for frames.
 */
export function MeasureFrames({ items }: { readonly items: readonly Measured[] }) {
  return (
    <div className="impact-frames" aria-hidden="true" data-testid="impact-frames">
      {items.flatMap((item) =>
        item.state.frames.map((spec) => (
          <FrameCard key={`${item.key}:${spec.key}`} session={item.session} spec={spec} revision={item.state.revision} frameState={item.state.frameStates[spec.key] ?? { state: "waiting" }} scale={0.25} focused={false} hidden selected={false} label={item.id} />
        )),
      )}
    </div>
  );
}
