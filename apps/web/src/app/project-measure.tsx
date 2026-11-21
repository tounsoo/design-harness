import { useCallback, useMemo, useState } from "react";
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
 *
 * `items` says where each prototype's measurement stands, by name, for a
 * page to say what it still waits for; the open one is marked `board`.
 * `checkAgain` measures again, from scratch, every prototype whose frames
 * are not all measured: a new session for each other one, and a new
 * revision on the board for the open one when the board has not measured
 * the record as it is.
 */
export function useProjectExisting({ config, prototypes, openPrototypeId, board, live }: { readonly config: ProjectConfig; readonly prototypes: readonly PrototypeRecord[]; readonly openPrototypeId: string; readonly board: BoardSession; readonly live: boolean }): {
  readonly existing: readonly ExistingPrototype[] | null;
  readonly frames: readonly Measured[];
  readonly progress: { readonly answered: number; readonly total: number };
  readonly items: readonly ProjectMeasurement[];
  readonly checkAgain: () => void;
} {
  const others = useMemo(() => (live ? prototypes.filter(isSpecRecord).filter((record) => record.id !== openPrototypeId) : []), [live, prototypes, openPrototypeId]);
  const [attempts, setAttempts] = useState<Readonly<Record<string, number>>>({});
  const otherItems = useMemo(() => others.map((record) => ({ id: `prototype-${record.id}`, config, prototype: record.prototype, attempt: attempts[record.id] ?? 0 })), [others, config, attempts]);
  const frames = useSessions(otherItems);
  const openRecord = prototypes.filter(isSpecRecord).find((record) => record.id === openPrototypeId);
  const boardCurrent = board.session.current();
  // The board measures the open prototype; until it has drawn the record as it is now, its measurement is not this prototype's.
  const boardMatches = boardCurrent !== null && boardCurrent.prototype === openRecord?.prototype && board.state.revision === boardCurrent.revision;
  const openMeasurement: Measurement | null = !live || !openRecord ? null : boardMatches ? measurementOf(board.state) : { state: "measuring", answered: 0, total: board.state.frames.length };
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
  const items: ProjectMeasurement[] = [
    ...(openRecord && openMeasurement ? [{ name: openRecord.name, board: true, measurement: openMeasurement, screens: board.state.frames.length }] : []),
    ...others.map((record, index) => ({ name: record.name, board: false, measurement: frames[index]?.measurement ?? ({ state: "measuring", answered: 0, total: 0 } as const), screens: frames[index]?.state.frames.length ?? 0 })),
  ];
  const checkAgain = useCallback(() => {
    setAttempts((was) => {
      const next = { ...was };
      others.forEach((record, index) => {
        if (frames[index]?.measurement.state !== "measured") next[record.id] = (was[record.id] ?? 0) + 1;
      });
      return next;
    });
    // The board's own revision of the open prototype, drawn again, or drawn for the first time as the record is now.
    const running = board.session.current();
    if (running && openRecord && (!boardMatches || measurementOf(board.state).state !== "measured")) board.session.update(running.config, openRecord.prototype);
  }, [others, frames, board, openRecord, boardMatches]);
  return { existing, frames, progress, items, checkAgain };
}

/** Where one of the project's prototypes stands in being measured, by its name; `board` for the open one, which the board measures. */
export type ProjectMeasurement = { readonly name: string; readonly board: boolean; readonly measurement: Measurement; /** How many screens it has in all: one for each scenario in each view. */ readonly screens: number };

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
