import { Alert, Badge, Button, Field, Kbd, Link, Menu, Splitter, Stack, Tabs, Text, ToggleGroup, Toolbar, VisuallyHidden, useAnnouncer, useHotkey } from "@tounsoo/todae";
import { CircleCheck, CodeXml, Download, Ellipsis, Expand, FileCode2, FolderPlus, PanelLeft, PanelLeftClose, PanelRight, PanelRightClose, Shapes, Shrink, Upload, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { NO_VARIANTS, flowFacts, variantLabel, type Finding, type LayoutUse, type PickRecord, type ProjectConfig, type Prototype, type Variant, type VariantState } from "@design-harness/core";
import { AgentController, type ChatRecord, type ChatStore } from "../agent/controller";
import { SpecStreamPreview } from "../agent/spec-stream";
import type { KeyVault } from "../agent/key-vault";
import { latestMeasured, waitForMeasured } from "../agent/measure";
import { detectPatterns, suggestion as suggestionOf, patternMessage } from "../agent/patterns";
import type { AgentSettings } from "../agent/models";
import { loadSettings, saveSettings } from "../agent/settings";
import { TSX_READ_ONLY, type AgentHost } from "../agent/tools";
import { frameKey, type SessionState } from "../runtime/session";
import { planOutline } from "../runtime/tags";
import type { Store } from "../store/db";
import type { LoadNote } from "../store/migrate";
import { exportFileName, exportProject, importProject, isSpecRecord, specOf, type Imported, type PrototypeRecord, type StoredPrototype } from "../store/project-file";
import { fingerprint, reanchor, type FrameMeasure } from "../pins/anchor";
import { NO_PINS, addPin, closePin, editPin, openPins, reopenPin, type Pin, type PinResult, type PinState } from "../pins/model";
import { PinNotes, type NoteFrame } from "../pins/PinNotes";
import { carriedWords, carryWithPick, returnFromPick, returnedWords, type CarriedNote } from "../pins/pick";
import type { PinActions } from "../pins/PinLayer";
import { Board, FramesShown, type BoardHandle, type BoardPins } from "./Board";
import { ChatPanel } from "./ChatPanel";
import { ChecksPanel } from "./ChecksPanel";
import { CodePanel, MANIFEST_FILE } from "./CodePanel";
import { NewPrototype } from "./NewPrototype";
import { blankPrototype, cannotCreate, prototypeId } from "./new-prototype";
import { ProjectView } from "./ProjectView";
import { PackagesNotice } from "./LibraryVersion";
import { ProposalPage } from "./ProposalPage";
import { ProposalsView } from "./ProposalsView";
import { PANEL_SIZES, usePanels, type PanelName } from "./panels";
import { panesAt, useShellWidth } from "./shell-width";
import { frameName } from "./words";
import type { ProjectEntry } from "./projects";
import { createSession } from "./runtime";
import { SHORTCUTS, ariaKeys } from "./shortcuts";
import { codeZip } from "../export/code-zip";
import { VariantsView, type ApplyPick } from "./VariantsView";

/** How long typing pauses before a new revision is checked and rendered. */
const EDIT_DEBOUNCE_MS = 300;

type Props = {
  readonly store: Store;
  readonly vault: KeyVault;
  readonly config: ProjectConfig;
  readonly prototypes: readonly PrototypeRecord[];
  readonly problems: readonly string[];
  /** What the app changed or found about stored data on load. */
  readonly notes?: readonly LoadNote[];
  readonly onImported: (imported: Imported) => Promise<void>;
  /** Every project in the store, for the switcher. */
  readonly projects: readonly ProjectEntry[];
  readonly onOpenProject: (id: string) => void;
  /** Opens the New project wizard. */
  readonly onNewProject: () => void;
};

/**
 * Where the code view points: a file, and a line in it when a finding named
 * one. `instance` is set for a finding inside a spec layout instance: where
 * the finding is and the layout uses that draw it, so the code view can show
 * the layout's element and the page's use of it, one after the other.
 */
export type CodeTarget = { readonly file: string; readonly line?: number; readonly column?: number; readonly instance?: { readonly at: { readonly file: string; readonly line: number; readonly column: number }; readonly via: readonly LayoutUse[] } };

/** A prototype's chat, kept in the project store beside it. */
function chatStore(store: Store, projectId: string, prototypeId: string): ChatStore {
  return {
    // The controller checks the record's shape and reports one it cannot read.
    load: async () => (await store.chat(projectId, prototypeId)) as ChatRecord | null,
    save: (record) => store.putChat(projectId, prototypeId, record),
  };
}

export function Workspace({ store, vault, config: initialConfig, prototypes: initial, problems, notes: loadNotes = [], onImported, projects, onOpenProject, onNewProject }: Props) {
  const session = useMemo(() => createSession(), []);
  useEffect(() => () => session.dispose(), [session]);
  const state = useSyncExternalStore(session.subscribe, session.getState);

  // The config changes when the agent drafts a proposal. Refs hold the newest values for the agent's tools between renders.
  const [config, setConfigState] = useState(initialConfig);
  const configRef = useRef(config);
  /**
   * The config the checks run with: the same object for as long as nothing
   * a check reads changes. Drafting, revising, approving or declining a
   * proposal changes only the proposals, which no check reads, so the board
   * keeps its revision and its measured frames; adopting one changes the
   * rules, and the board checks again.
   */
  const checkedRef = useRef(config);
  const checked = useCallback((next: ProjectConfig): ProjectConfig => {
    if (next !== checkedRef.current && checksKey(next) !== checksKey(checkedRef.current)) checkedRef.current = next;
    return checkedRef.current;
  }, []);
  const [records, setRecordsState] = useState(initial);
  const recordsRef = useRef(records);
  const setRecords = useCallback((update: (items: readonly PrototypeRecord[]) => readonly PrototypeRecord[]) => {
    recordsRef.current = update(recordsRef.current);
    setRecordsState(recordsRef.current);
  }, []);
  const [currentId, setCurrentId] = useState(initial[0]?.id ?? "");
  const current = records.find((record) => record.id === currentId) ?? records[0];
  const [settings, setSettings] = useState<AgentSettings>(() => loadSettings());
  const settingsRef = useRef(settings);
  const [center, setCenterState] = useState<"canvas" | "project" | "proposals" | "variants">("canvas");
  /** A library version the canvas's packages notice picked, for the Project view to compare. */
  const [libraryTarget, setLibraryTarget] = useState<string | undefined>(undefined);
  // The version is for the visit the notice opened; the Project view opened later starts with nothing compared.
  useEffect(() => {
    if (center !== "project") setLibraryTarget(undefined);
  }, [center]);
  /** The proposal whose review page is open in the Proposals view, or null for the list. */
  const [reviewing, setReviewing] = useState<string | null>(null);
  /** Text put into the chat's message box for the person to edit and send; the nonce makes the same text land twice. */
  const [prefill, setPrefill] = useState<{ readonly text: string; readonly nonce: number } | null>(null);
  const [side, setSide] = useState<"checks" | "code">("checks");
  const [selected, setSelected] = useState<Finding | null>(null);
  const [code, setCode] = useState<CodeTarget>({ file: firstFile(current?.prototype) });
  const [notice, setNotice] = useState<{ tone: "success" | "critical" | "info" | "warning"; title: string; lines: readonly string[] } | null>(() => {
    const [first] = loadNotes;
    return first ? { tone: first.tone, title: first.title, lines: [first.text] } : null;
  });

  const { panels, resize, toggle, setWidth } = usePanels();
  /**
   * The window's width decides how many panes sit side by side. With room for
   * all three, each panel is open or closed as the viewer left it (`panels`).
   * With less, at most one panel shows, `beside`: next to the canvas on a
   * tablet, and in place of it on a phone, where the canvas shows when no
   * panel does. `beside` lasts for the visit and leaves what is stored alone.
   */
  const width = useShellWidth();
  const panes = panesAt(width);
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const [beside, setBeside] = useState<PanelName | null>(() => (panes !== 2 ? null : panels.chat.open ? "chat" : panels.side.open ? "side" : null));
  const open = { chat: panes === 3 ? panels.chat.open : beside === "chat", side: panes === 3 ? panels.side.open : beside === "side" };
  /** Shows or hides a panel: the one way a button, a shortcut or a link to the chat or the code does it, at any width. */
  const showPanel = useCallback(
    (name: PanelName, next?: boolean) => {
      if (panesRef.current === 3) toggle(name, next);
      else setBeside((current) => (next ?? current !== name ? name : current === name ? null : current));
    },
    [toggle],
  );
  /** A handle's drag or key. With fewer than three panes it keeps the width and leaves the stored open state alone. */
  const resizePanel = (name: PanelName, value: number) => {
    if (panes === 3) resize(name, value);
    else if (panes === 2 && value > 0) {
      setWidth(name, value);
      setBeside(name);
    } else if (panes === 2) setBeside((current) => (current === name ? null : current));
  };
  /** On a phone a panel covers the main view, so going to the main view puts the panel away. */
  const revealMain = useCallback(() => {
    if (panesRef.current === 1) setBeside(null);
  }, []);
  const setCenter = useCallback(
    (next: "canvas" | "project" | "proposals" | "variants") => {
      setCenterState(next);
      revealMain();
    },
    [revealMain],
  );
  const mainId = useId();
  const chatId = useId();
  const sideId = useId();
  const announce = useAnnouncer();

  /**
   * Canvas only: the header and both panels step aside and a floating bar
   * keeps the prototype's name, zoom, a quiet verdict and the way back.
   * Focus goes to that way back on entering, and back to the toggle on
   * leaving, so it never falls to the page.
   */
  const [canvasOnly, setCanvasOnly] = useState(false);
  const canvasToggle = useRef<HTMLButtonElement>(null);
  const exitButton = useRef<HTMLButtonElement>(null);
  /** The More menu's button: where Canvas only lives on a phone, so where focus comes back to there. */
  const moreTrigger = useRef<HTMLButtonElement>(null);
  /** New prototype's dialog, when the menu opens it. */
  const [naming, setNaming] = useState(false);
  const moveFocus = useRef<"exit" | "toggle" | null>(null);
  const enterCanvasOnly = useCallback(() => {
    setCenter("canvas");
    setCanvasOnly(true);
    moveFocus.current = "exit";
    announce("Canvas only. Press Escape to show the panels.");
  }, [announce]);
  const leaveCanvasOnly = useCallback(() => {
    setCanvasOnly(false);
    moveFocus.current = "toggle";
    announce("Panels shown.");
  }, [announce]);
  useEffect(() => {
    const target = moveFocus.current === "exit" ? exitButton.current : moveFocus.current === "toggle" ? (canvasToggle.current ?? moreTrigger.current) : null;
    moveFocus.current = null;
    target?.focus();
  }, [canvasOnly]);
  useHotkey(SHORTCUTS.canvasOnly.keys, () => (canvasOnly ? leaveCanvasOnly() : enterCanvasOnly()));
  /** "Pin a note" mode, and whether the board holds Escape for it or for an open note. */
  const [pinning, setPinningState] = useState(false);
  const [boardHolds, setBoardHolds] = useState(false);
  const [variantsHold, setVariantsHold] = useState(false);
  const setPinning = useCallback(
    (next: boolean) => {
      // Notes are pinned on the canvas, and on the Variants view's frames; from anywhere else, the canvas comes up.
      const record = recordsRef.current.find((item) => item.id === currentId) ?? recordsRef.current[0];
      const spec = record !== undefined && isSpecRecord(record);
      // A TSX prototype has no frames to pin on: no new note is pinned on it.
      if (next && !spec) {
        setNotice({ tone: "info", title: "No notes on a TSX prototype", lines: [TSX_READ_ONLY] });
        return;
      }
      setPinningState(next);
      if (next) {
        setCenterState((now) => (now === "variants" && spec ? now : "canvas"));
        // On a phone, a panel covering the main view steps aside, as for any way to the frames.
        revealMain();
      }
      announce(next ? "Pin a note: click a spot on a frame, or pick an element from a frame's list. Press Escape to leave." : "Left pin a note.");
    },
    [announce, currentId, revealMain],
  );
  // Pin mode belongs to the views that show frames to pin on: opening another one leaves it.
  useEffect(() => {
    if (pinning && center !== "canvas" && center !== "variants") setPinningState(false);
  }, [pinning, center]);
  useHotkey(SHORTCUTS.pin.keys, () => setPinning(!pinning));
  // Escape leaves pin mode or closes a note's card first, and canvas only after that.
  useHotkey(SHORTCUTS.leave.keys, leaveCanvasOnly, { enabled: canvasOnly && !pinning && !boardHolds && !variantsHold });
  useHotkey(SHORTCUTS.chat.keys, () => {
    if (canvasOnly) leaveCanvasOnly();
    showPanel("chat", canvasOnly ? true : undefined);
  });
  useHotkey(SHORTCUTS.side.keys, () => {
    if (canvasOnly) leaveCanvasOnly();
    showPanel("side", canvasOnly ? true : undefined);
  });

  // A new revision for each settled edit; the first one at once. The agent's changes start theirs at once, so they are skipped here.
  // A stored TSX prototype is no revision at all: nothing renders or checks it, so the board and the checks show nothing for it.
  const prototype = current ? (specOf(current.prototype) ?? undefined) : undefined;
  const tsxOpen = current !== undefined && prototype === undefined;
  const first = useRef(true);
  useEffect(() => {
    if (tsxOpen) {
      first.current = false;
      if (session.current()) session.clear();
      return;
    }
    if (!prototype) return;
    const checks = checked(config);
    const running = session.current();
    if (running && running.prototype === prototype && running.config === checks) return;
    if (first.current) {
      first.current = false;
      session.update(checks, prototype);
      return;
    }
    const timer = setTimeout(() => session.update(checks, prototype), EDIT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [session, config, prototype, tsxOpen, checked]);

  // Edits are saved in the browser once typing pauses.
  useEffect(() => {
    if (!current || current.prototype === initial.find((record) => record.id === current.id)?.prototype) return;
    const timer = setTimeout(() => void store.putPrototype(current), EDIT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [store, current, initial]);

  const edit = useCallback(
    (next: Prototype) => {
      // A TSX prototype is read-only: the code view does not offer an edit, and none is taken here.
      const record = recordsRef.current.find((item) => item.id === currentId);
      if (record && !isSpecRecord(record)) return;
      setSelected(null);
      setRecords((items) => items.map((item) => (item.id === currentId ? { ...item, prototype: next } : item)));
    },
    [currentId, setRecords],
  );

  /** The one way the config changes: a proposal drafted or revised by the agent, or a review step by the person. */
  const saveConfig = useCallback(
    async (next: ProjectConfig) => {
      configRef.current = next;
      setConfigState(next);
      await store.putProject(next);
    },
    [store],
  );

  const recordOf = useCallback(() => recordsRef.current.find((record) => record.id === currentId) ?? recordsRef.current[0], [currentId]);
  /** Changes the open prototype's variants and picks, and saves the record at once. */
  const updateVariants = useCallback(
    (change: (state: VariantState) => VariantState, prototype?: Prototype) => {
      const record = recordOf();
      if (!record) return;
      const next: PrototypeRecord = { ...record, ...(prototype ? { prototype } : {}), variants: change(record.variants ?? NO_VARIANTS) };
      setRecords((items) => items.map((item) => (item.id === record.id ? next : item)));
      void store.putPrototype(next);
    },
    [recordOf, setRecords, store],
  );

  /** Changes the open prototype's pinned notes, and saves the record at once. The prototype itself is never touched, so no revision starts and no check runs. */
  const updatePins = useCallback(
    (change: (state: PinState) => PinState) => {
      const record = recordOf();
      if (!record) return;
      const before = record.pins ?? NO_PINS;
      const pins = change(before);
      if (pins === before) return;
      const next: PrototypeRecord = { ...record, pins };
      setRecords((items) => items.map((item) => (item.id === record.id ? next : item)));
      void store.putPrototype(next);
    },
    [recordOf, setRecords, store],
  );

  // The agent's view of the app, for the prototype open now: its changes are revisions at once, and its checks wait for every frame.
  const host = useMemo((): AgentHost => {
    const storedOf = () => recordsRef.current.find((record) => record.id === currentId)?.prototype ?? recordsRef.current[0]?.prototype;
    // The open spec; never a TSX prototype, which the controller and every tool refuse before asking (`tsx`).
    const prototypeOf = () => {
      const stored = storedOf();
      return stored ? specOf(stored) : undefined;
    };
    return {
      config: () => configRef.current,
      prototype: () => {
        const value = prototypeOf();
        if (!value) throw new Error(storedOf() ? "the open prototype is TSX" : "no prototype is open");
        return value;
      },
      tsx: () => {
        const stored = storedOf();
        return stored !== undefined && specOf(stored) === null;
      },
      apply: (next) => {
        setSelected(null);
        setRecords((items) => items.map((item) => (item.id === currentId ? { ...item, prototype: next } : item)));
        session.update(checked(configRef.current), next);
        return { revision: session.getState().revision };
      },
      saveConfig: (next) => saveConfig(next),
      measured: (signal) =>
        waitForMeasured(
          session,
          () => {
            const value = prototypeOf();
            if (!value) throw new Error("no prototype is open");
            return { config: checked(configRef.current), prototype: value };
          },
          signal,
        ),
      checked: () => {
        const value = prototypeOf();
        return value ? latestMeasured(session, () => ({ config: checked(configRef.current), prototype: value })) : null;
      },
      now: () => new Date().toISOString(),
      variants: () => recordOf()?.variants ?? NO_VARIANTS,
      // Only the list of variants: the picks are kept as they are, and the prototype is not touched.
      saveVariants: (next: readonly Variant[]) => updateVariants((state) => ({ ...state, variants: next })),
      pins: () => recordOf()?.pins ?? NO_PINS,
      savePins: (next: PinState) => updatePins(() => next),
    };
  }, [currentId, session, setRecords, saveConfig, checked, recordOf, updateVariants, updatePins]);

  // A spec prototype's patch_spec draws its draft on the canvas while it streams, in place; the board then returns to the prototype as it is.
  const [previewing, setPreviewing] = useState(false);
  const preview = useMemo(
    () =>
      new SpecStreamPreview(
        (draft) => {
          const real = host.prototype();
          setPreviewing(draft !== null);
          // A draft is drawn in place in frames that have rendered; only before they have does it take a revision of its own.
          if (draft) {
            if (!session.redraw(checked(configRef.current), draft)) session.update(checked(configRef.current), draft);
          } else if (session.current()?.prototype !== real) session.update(checked(configRef.current), real);
          else session.restore();
        },
        () => host.prototype(),
      ),
    [host, session, checked],
  );
  const controller = useMemo(
    () => new AgentController({ host, store: chatStore(store, initialConfig.id, currentId), key: () => vault.get(), settings: () => settingsRef.current, preview }),
    [host, store, vault, initialConfig.id, currentId, preview],
  );
  useEffect(() => {
    void controller.load();
    return () => controller.stop();
  }, [controller]);
  const changeSettings = useCallback((next: AgentSettings) => {
    settingsRef.current = next;
    setSettings(next);
    saveSettings(next);
  }, []);

  const key = useSyncExternalStore(vault.subscribe, vault.getState);
  const agentState = useSyncExternalStore(controller.subscribe, controller.getState);
  const agent = !key.present
    ? { ready: false, why: "Enter your Anthropic API key in the chat to send a proposal back to the agent." }
    : agentState.running
      ? { ready: false, why: "The agent is working on something now; send it back once it stops." }
      : { ready: agentState.loaded, why: "The chat is still loading." };

  // What keeps coming up, read from this prototype's history by app code; offered quietly while the agent is idle, never acted on alone.
  const patterns = useMemo(() => detectPatterns({ turns: agentState.turns, log: agentState.log, proposals: config.proposals }), [agentState.turns, agentState.log, config.proposals]);
  const offered = agentState.running || !agentState.loaded ? undefined : suggestionOf(patterns, agentState.log);
  const answerSuggestion = useCallback(
    async (answer: "accepted" | "dismissed") => {
      if (!offered) return;
      await controller.record({ kind: "suggestion", at: new Date().toISOString(), key: offered.key, answer, evidence: offered.evidence });
      if (answer === "accepted") await controller.send(patternMessage(offered, configRef.current));
    },
    [offered, controller],
  );

  const openProposal = useCallback((id: string) => {
    setReviewing(id);
    setCenter("proposals");
  }, []);

  /** Opens a finding's file at its line, and for one inside a spec layout instance, the layout's element with its uses. */
  const showCode = useCallback((finding: Finding, open: boolean) => {
    if (finding.file === undefined) return;
    const instance = finding.via && finding.via.length > 0 && finding.line !== undefined ? { instance: { at: { file: finding.file, line: finding.line, column: finding.column ?? 1 }, via: finding.via } } : {};
    setCode({ file: finding.file, ...(finding.line !== undefined ? { line: finding.line } : {}), ...(finding.column !== undefined ? { column: finding.column } : {}), ...instance });
    if (open) {
      setSide("code");
      showPanel("side", true);
    }
  }, [showPanel]);

  const board = useRef<BoardHandle>(null);
  /** Core's facts about the flow of the revision the board shows, for the flow map and its way to an artboard. */
  const flow = useMemo(() => {
    const now = session.current();
    return now ? flowFacts(now.config, now.prototype) : null;
    // The session's config and prototype change only with its revision.
  }, [session, state.revision]);
  const goToState = useCallback(
    (flowState: string) => {
      const frame = session.getState().frames.find((item) => item.scenario.state === flowState);
      if (!frame) return;
      setCenter("canvas");
      // After the canvas is the view on top again.
      requestAnimationFrame(() => board.current?.goTo(frame.key));
    },
    [session],
  );

  const select = useCallback(
    (finding: Finding | null) => {
      setSelected(finding);
      const state = session.getState();
      for (const frame of state.frames) session.highlight(frame.key, null);
      if (!finding) return;
      // A finding about elements is outlined in every frame that drew them; a rendered one, at its index in its frame.
      const plan = planOutline(finding, state.frames, state.frameStates);
      const first = plan ? plan.frames[0]?.key : finding.scenario !== undefined && finding.view !== undefined ? frameKey(finding.scenario, finding.view) : undefined;
      if (plan) for (const frame of plan.frames) session.outline(frame.key, frame.tags);
      else if (first !== undefined) session.highlight(first, finding.element ?? null);
      if (plan || first !== undefined) setCenter("canvas");
      if (first !== undefined) document.querySelector(`[data-frame-key="${CSS.escape(first)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      // The code stays one click away ("Show in code"); a finding nothing on the canvas can show opens there at once.
      showCode(finding, !plan && finding.scenario === undefined);
    },
    [session, showCode],
  );

  /** Opens a prototype on the board, pointing at a finding when one is given. */
  const openPrototype = useCallback(
    (id: string, finding?: Finding) => {
      const next = recordsRef.current.find((record) => record.id === id);
      if (!next) return;
      setCenter("canvas");
      if (id !== currentId) {
        setSelected(null);
        setCurrentId(id);
        setCode({ file: firstFile(next.prototype) });
        return;
      }
      if (finding) select(finding);
    },
    [currentId, select],
  );

  /** "Ask the agent to propose this": a message for the person to edit and send, about a finding outside the inventories. */
  const ask = useCallback((finding: Finding) => {
    const place = finding.file !== undefined ? ` (${finding.file}${finding.line !== undefined ? `:${finding.line}` : ""})` : finding.page !== undefined ? ` (page ${finding.page})` : "";
    const text = `The check "${finding.rule}" says: ${finding.message}${place}\n\nIf the prototype needs this, draft a proposal that adds it to the inventory, with a rule that governs it and examples that pass and fail. If it does not, change the prototype to use what the inventory has.`;
    setPrefill((previous) => ({ text, nonce: (previous?.nonce ?? 0) + 1 }));
    setCanvasOnly(false);
    showPanel("chat", true);
  }, [showPanel]);
  /** "Ask the agent to fix": a message for the person to edit and send, about any finding. */
  const fix = useCallback(
    (finding: Finding) => {
      const place = finding.file !== undefined ? ` (${finding.file}${finding.line !== undefined ? `:${finding.line}` : ""})` : finding.scenario !== undefined ? ` (scenario ${finding.scenario}${finding.view !== undefined ? `, ${finding.view}` : ""})` : finding.page !== undefined ? ` (page ${finding.page})` : "";
      const text = `Please fix this so the prototype follows the project's rules.\n\nThe check "${finding.rule}" says: ${finding.message}${place}`;
      setPrefill((previous) => ({ text, nonce: (previous?.nonce ?? 0) + 1 }));
      setCanvasOnly(false);
      showPanel("chat", true);
      // The loop counts asks per rule (agent/patterns.ts); a press tells the agent nothing by itself.
      void controller.record({ kind: "fix-asked", at: new Date().toISOString(), rule: finding.rule });
    },
    [showPanel, controller],
  );
  /** The person's pick: the recombined page as a new revision, recorded with where each slot came from. Nothing but this view's Apply calls it. */
  const applyPick = useCallback(
    (pick: ApplyPick) => {
      const at = new Date().toISOString();
      const record: PickRecord = { at, page: pick.page, slots: pick.slots, notes: pick.notes, before: pick.before, after: pick.after };
      setSelected(null);
      updateVariants((state) => ({ ...state, picks: [...state.picks, record] }), pick.prototype);
      // The notes pinned on what the pick took from a variant are the prototype's now. Only their place changes: no report reads them.
      const scenarios = pick.prototype.scenarios.filter((scenario) => scenario.page === pick.page).map((scenario) => scenario.id);
      let moved: readonly CarriedNote[] = [];
      updatePins((pins) => {
        const carried = carryWithPick(pins, { scenarios, slots: pick.slots, keyOf: pick.keyOf }, at);
        moved = carried.moved;
        return carried.state;
      });
      session.update(checked(configRef.current), pick.prototype);
      const from = Object.entries(pick.slots).map(([slot, source]) => `${slot} from ${variantLabel(source)}`).join(", ");
      const cameAlong = carriedWords(moved);
      void controller.note(
        `The person applied a pick to page "${pick.page}": ${from}. The page's file is that combination now; read it again before you change it.${moved.length > 0 ? ` Their ${moved.length === 1 ? "note" : "notes"} ${moved.map((item) => item.note).join(", ")} on what was picked ${moved.length === 1 ? "is" : "are"} on the prototype's page now, not on a variant.` : ""}`,
      );
      setNotice({ tone: "success", title: "Pick applied", lines: [`Page ${pick.page}: ${from}. It is a new revision; Undo is under Picks applied.`, ...(cameAlong ? [cameAlong] : [])] });
    },
    [updateVariants, updatePins, session, checked, controller],
  );
  const undoPick = useCallback(
    (index: number) => {
      const record = recordOf();
      const pick = record?.variants?.picks[index];
      const page = record?.prototype.pages.find((item) => item.id === pick?.page);
      if (!record || !isSpecRecord(record) || !pick || !page) return;
      const restored: Prototype = { ...record.prototype, files: { ...record.prototype.files, [page.component.file]: pick.before } };
      setSelected(null);
      updateVariants((state) => ({ ...state, picks: state.picks.map((item, at) => (at === index ? { ...item, undone: true } : item)) }), restored);
      // The notes that came with the pick go back to their variants, as one step with the page.
      let returned: readonly CarriedNote[] = [];
      updatePins((pins) => {
        const back = returnFromPick(pins, pick.at, new Date().toISOString());
        returned = back.returned;
        return back.state;
      });
      session.update(checked(configRef.current), restored);
      const wentBack = returnedWords(returned);
      void controller.note(
        `The person undid their pick on page "${pick.page}": the page is back to what it was before it.${returned.length > 0 ? ` Their ${returned.length === 1 ? "note" : "notes"} ${returned.map((item) => item.note).join(", ")} that came with it ${returned.length === 1 ? "is" : "are"} back on ${returned.length === 1 ? "its variant" : "their variants"}.` : ""}`,
      );
      if (wentBack) setNotice({ tone: "info", title: "Pick undone", lines: [`Page ${pick.page} is as it was before the pick.`, wentBack] });
    },
    [recordOf, updateVariants, updatePins, session, checked, controller],
  );
  /** Dismisses a variant; a note on why is kept for the loop, which notices notes that repeat. */
  const dismissVariant = useCallback(
    (id: string, note = "") => {
      const variant = recordOf()?.variants?.variants.find((item) => item.id === id);
      updateVariants((state) => ({ ...state, variants: state.variants.filter((item) => item.id !== id) }));
      if (variant) void controller.record({ kind: "variant-rejected", at: new Date().toISOString(), page: variant.page, variant: id, note: note.trim() });
    },
    [recordOf, updateVariants, controller],
  );
  const prefillChat = useCallback(
    (text: string) => {
      setPrefill((previous) => ({ text, nonce: (previous?.nonce ?? 0) + 1 }));
      showPanel("chat", true);
    },
    [showPanel],
  );

  // ---- Pinned notes: the person's feedback on the open prototype's frames. Never a check: nothing below reads or changes a report. ----
  const pinState = current?.pins ?? NO_PINS;
  const pinActions = useMemo((): PinActions => {
    const run = (change: (state: PinState) => PinResult): boolean => {
      const record = recordOf();
      if (record && !isSpecRecord(record)) {
        setNotice({ tone: "info", title: "The note was not changed", lines: [TSX_READ_ONLY] });
        return false;
      }
      const result = change(record?.pins ?? NO_PINS);
      if (!result.ok) {
        setNotice({ tone: "warning", title: "The note was not changed", lines: [result.error] });
        return false;
      }
      updatePins(() => result.value);
      return true;
    };
    const at = () => new Date().toISOString();
    return {
      create: (anchor, note) => {
        const number = (recordOf()?.pins ?? NO_PINS).next;
        return run((state) => addPin(state, anchor, note, at())) ? number : null;
      },
      edit: (number, note) => void run((state) => editPin(state, number, note, at())),
      close: (number) => void run((state) => closePin(state, number, at())),
      reopen: (number) => void run((state) => reopenPin(state, number, at())),
    };
  }, [recordOf, updatePins]);
  const pinRevision = useMemo(() => (prototype ? fingerprint(prototype) : ""), [prototype]);
  // Each time frames are measured for the prototype as it is now, every pin on its own frames is placed again: on its element where that
  // still exists, "moved or gone" where it does not. Everything that decides is in the pin and in the measurement (`pins/anchor.ts`), so
  // nothing is remembered here between revisions. A note on a variant is placed by the Variants view, on that variant's frames.
  useEffect(() => {
    const record = recordOf();
    const running = session.current();
    // A TSX prototype is no revision, so `running` is never it: its notes stay as they were stored.
    if (!record || !isSpecRecord(record) || !running || running.prototype !== record.prototype) return;
    if (!record.pins || record.pins.pins.length === 0) return;
    const revision = fingerprint(record.prototype);
    const frames: Record<string, FrameMeasure> = {};
    for (const frame of state.frames) {
      const value = state.frameStates[frame.key];
      if (value?.state === "measured") frames[frame.key] = { snapshot: value.snapshot, places: value.places ?? [], width: frame.view.width, height: frame.view.height };
    }
    const next = reanchor(record.pins, frames, revision);
    if (next !== record.pins) updatePins((latest) => reanchor(latest, frames, revision));
  }, [state.frames, state.frameStates, session, recordOf, updatePins, pinState]);
  const boardPins = useMemo((): BoardPins => ({ prototype: current?.id ?? "", state: pinState, pinning, onPinning: setPinning, actions: pinActions, revision: pinRevision, onHold: setBoardHolds }), [current?.id, pinState, pinning, setPinning, pinActions, pinRevision]);
  const variantsPins = useMemo((): BoardPins => ({ ...boardPins, onHold: setVariantsHold }), [boardPins]);
  const keptVariants = current?.variants?.variants;
  /** A note's frame in words, and what became of it when it is no longer there: the prototype's own frame, or a variant's. */
  const pinFrame = useCallback(
    (pin: Pin): NoteFrame => {
      const { scenario, view, variant } = pin.anchor;
      const frame = state.frames.find((item) => item.scenario.id === scenario && item.view.name === view);
      const words = frame ? frameName(frame.scenario, frame.view.name) : `${scenario} at ${view}`;
      const name = variant !== undefined ? `${variantLabel(variant)} · ${words}` : words;
      if (variant !== undefined && !keptVariants?.some((item) => item.id === variant)) return { name, gone: `Moved or gone: ${variantLabel(variant)} is no longer among the variants. The note is kept.` };
      return frame ? { name, gone: null } : { name, gone: "Moved or gone: the prototype no longer has this note's frame. The note is kept." };
    },
    [state.frames, keptVariants],
  );
  /** A note on a variant to show in the Variants view. */
  const [variantShow, setVariantShow] = useState<{ readonly number: number; readonly nonce: number } | null>(null);
  const showPin = useCallback(
    (number: number) => {
      const pin = (recordOf()?.pins ?? NO_PINS).pins.find((item) => item.number === number);
      if (pin?.anchor.variant !== undefined) {
        setCenter("variants");
        setVariantShow((before) => ({ number, nonce: (before?.nonce ?? 0) + 1 }));
        return;
      }
      setCenter("canvas");
      // After the canvas is the view on top again.
      requestAnimationFrame(() => board.current?.showPin(number));
    },
    [recordOf],
  );
  /** "Ask the agent to address them": a message for the person to edit and send; the open notes ride with it. */
  const askAboutNotes = useCallback(() => {
    const open = openPins(recordOf()?.pins ?? NO_PINS).length;
    setPrefill((previous) => ({ text: open === 1 ? "Please address my pinned note." : `Please address my ${open} pinned notes.`, nonce: (previous?.nonce ?? 0) + 1 }));
    setCanvasOnly(false);
    showPanel("chat", true);
  }, [recordOf, showPanel]);

  const proposable = useCallback(
    (finding: Finding) => {
      const rule = configRef.current.rules.find((item) => item.id === finding.rule);
      return rule?.type === "membership";
    },
    [],
  );

  /** A new, empty spec prototype, saved and opened on the board. */
  const createPrototype = useCallback(
    (name: string) => {
      const record: PrototypeRecord = { projectId: initialConfig.id, id: prototypeId(name, recordsRef.current.map((item) => item.id)), name, prototype: blankPrototype() };
      setRecords((items) => [...items, record]);
      void store.putPrototype(record);
      setSelected(null);
      setCurrentId(record.id);
      setCode({ file: MANIFEST_FILE });
      setCenter("canvas");
    },
    [initialConfig.id, setRecords, store],
  );

  const openCount = config.proposals.filter((proposal) => proposal.status === "open").length;

  const download = () => {
    const blob = new Blob([exportProject(configRef.current, recordsRef.current)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName(config);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  /** Code export: the open prototype as a runnable React project, zipped in the browser. */
  const downloadCode = () => {
    if (!current) return;
    // A stored TSX prototype goes out with its files as they are, and no report: nothing checked it.
    const zipped = codeZip({ config: configRef.current, prototype: current.prototype, name: current.name, at: new Date().toISOString(), report: isSpecRecord(current) && state.measured ? state.report : null });
    if (!zipped.ok) {
      setNotice({ tone: "critical", title: "The code was not exported", lines: [zipped.error] });
      return;
    }
    const url = URL.createObjectURL(new Blob([zipped.value.bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = zipped.value.fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (zipped.value.notes.length > 0) setNotice({ tone: "info", title: `Exported ${zipped.value.fileName}, with notes`, lines: zipped.value.notes });
  };
  const variantCount = current?.variants?.variants.length ?? 0;

  const fileInput = useRef<HTMLInputElement>(null);
  const upload = async (file: File) => {
    const result = importProject(await file.text());
    if (!result.ok) {
      setNotice({ tone: "critical", title: `${file.name} was not imported`, lines: result.error });
      return;
    }
    await onImported(result.value);
  };

  const measuredCount = state.frames.filter((frame) => state.frameStates[frame.key]?.state === "measured").length;
  const verdict = tsxOpen ? NOT_CHECKED : verdictOf(state);
  /** The open prototype is TSX: its files kept and shown, never rendered, checked or changed here. */
  const readOnly = tsxOpen;
  const prototypeName = current?.name ?? "No prototype";

  return (
    <div className="shell" data-width={width} data-canvas-only={canvasOnly ? "" : undefined}>
      <Stack.Root as="header" direction="row" align="center" gap="condensed" className="shell-header">
        <VisuallyHidden.Root focusable>
          <Link.Root href={`#${mainId}`} onClick={(event) => {
              event.preventDefault();
              document.getElementById(mainId)?.focus();
            }}>
            Skip to the canvas
          </Link.Root>
        </VisuallyHidden.Root>
        <Button.Root variant="ghost" aria-label={`Chat (${SHORTCUTS.chat.label})`} aria-keyshortcuts={ariaKeys(SHORTCUTS.chat)} aria-controls={chatId} aria-expanded={open.chat} onClick={() => showPanel("chat")} className="shell-toggle">
          <Button.Icon>{open.chat ? <PanelLeftClose /> : <PanelLeft />}</Button.Icon>
        </Button.Root>
        <Stack.Root direction="row" align="center" gap="condensed" className="shell-title">
          <span className="shell-mark" aria-hidden="true">
            <Shapes />
          </span>
          {projects.length > 1 ? (
            <Field.Root aria-label="Project" className="shell-project-picker">
              <Field.Select value={config.id} onValueChange={(id) => id !== config.id && onOpenProject(id)}>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Field.Select>
            </Field.Root>
          ) : (
            <Text.Root as="span" weight="bold" className="shell-project">
              {config.name}
            </Text.Root>
          )}
          <span className="shell-slash" aria-hidden="true">
            /
          </span>
          {records.length > 1 ? (
            <Field.Root aria-label="Prototype" className="shell-prototype">
              <Field.Select
                value={current?.id ?? ""}
                onValueChange={(id) => {
                  const next = records.find((record) => record.id === id);
                  setSelected(null);
                  setCurrentId(id);
                  if (next) setCode({ file: firstFile(next.prototype) });
                }}
              >
                {records.map((record) => (
                  <option key={record.id} value={record.id}>
                    {isSpecRecord(record) ? record.name : `${record.name} (TSX, read-only)`}
                  </option>
                ))}
              </Field.Select>
            </Field.Root>
          ) : (
            <Text.Root as="span" weight="medium" className="shell-prototype-name">
              {prototypeName}
            </Text.Root>
          )}
          {readOnly && (
            <Badge.Root tone="neutral" data-testid="prototype-format" title="A TSX prototype: pages and layouts as React code, kept read-only and no longer rendered or checked">
              TSX, read-only
            </Badge.Root>
          )}
        </Stack.Root>
        {/* Which main view shows is a mode, not tabbed content, so it is a toggle group: one button pressed. A press on the pressed button asks for none, which the app never has, so the view stays; on a phone that press still brings the main view forward. */}
        <ToggleGroup.Root
          aria-label="Main view"
          value={center}
          onValueChange={(value) => {
            if (value === "canvas" || value === "variants" || value === "project" || value === "proposals") setCenter(value);
          }}
          onClick={revealMain}
          className="shell-views"
        >
          <ToggleGroup.Item value="canvas">Canvas</ToggleGroup.Item>
          <ToggleGroup.Item value="variants">
            Variants
            {variantCount > 0 && (
              <Badge.Root tone="neutral" data-testid="variant-count" aria-label={`${variantCount} variants`}>
                {variantCount}
              </Badge.Root>
            )}
          </ToggleGroup.Item>
          <ToggleGroup.Item value="project">Project</ToggleGroup.Item>
          <ToggleGroup.Item value="proposals" onClick={() => center === "proposals" && setReviewing(null)}>
            Proposals
            {openCount > 0 && (
              <Badge.Root tone="warning" data-testid="open-proposals" aria-label={`${openCount} open`}>
                {openCount}
              </Badge.Root>
            )}
          </ToggleGroup.Item>
        </ToggleGroup.Root>
        <Toolbar.Root aria-label="Prototype actions" className="shell-actions">
          {width === "desktop" ? (
            <>
              <NewPrototype config={config} onCreate={createPrototype} />
              <Button.Root variant="ghost" onClick={onNewProject}>
                <Button.Icon>
                  <FolderPlus />
                </Button.Icon>
                New project
              </Button.Root>
              <Toolbar.Separator />
              {/* The project file out and in, and the prototype as a runnable React project: icons, named in their tooltips. */}
              <Button.Root variant="ghost" onClick={download} aria-label="Export">
                <Button.Icon>
                  <Download />
                </Button.Icon>
              </Button.Root>
              <Button.Root variant="ghost" onClick={() => fileInput.current?.click()} aria-label="Import">
                <Button.Icon>
                  <Upload />
                </Button.Icon>
              </Button.Root>
              <Button.Root variant="ghost" onClick={downloadCode} data-testid="export-code" aria-label="Export code">
                <Button.Icon>
                  <FileCode2 />
                </Button.Icon>
              </Button.Root>
              <Toolbar.Separator />
            </>
          ) : (
            <Menu.Root>
              <Menu.Trigger ref={moreTrigger} variant="ghost" aria-label="More actions" data-testid="more-actions">
                <Button.Icon>
                  <Ellipsis />
                </Button.Icon>
              </Menu.Trigger>
              <Menu.Content>
                <Menu.Item onSelect={() => setNaming(true)}>New prototype</Menu.Item>
                <Menu.Item onSelect={onNewProject}>New project</Menu.Item>
                <Menu.Separator />
                <Menu.Item onSelect={download}>Export</Menu.Item>
                <Menu.Item onSelect={() => fileInput.current?.click()}>Import</Menu.Item>
                <Menu.Item onSelect={() => void downloadCode()} data-testid="export-code">
                  Export code
                </Menu.Item>
                {width === "phone" && (
                  <>
                    <Menu.Separator />
                    <Menu.Item onSelect={enterCanvasOnly} aria-keyshortcuts={ariaKeys(SHORTCUTS.canvasOnly)} textValue="Canvas only" className="shell-menu-keys">
                      Canvas only <Kbd.Root>{SHORTCUTS.canvasOnly.label}</Kbd.Root>
                    </Menu.Item>
                  </>
                )}
              </Menu.Content>
            </Menu.Root>
          )}
          {width !== "phone" && (
            <Button.Root ref={canvasToggle} variant="ghost" aria-label={`Canvas only (${SHORTCUTS.canvasOnly.label})`} aria-keyshortcuts={ariaKeys(SHORTCUTS.canvasOnly)} pressed={canvasOnly} onPressedChange={(next) => (next ? enterCanvasOnly() : leaveCanvasOnly())}>
              <Button.Icon>
                <Expand />
              </Button.Icon>
            </Button.Root>
          )}
          <Button.Root variant="ghost" aria-label={`Checks and code (${SHORTCUTS.side.label})`} aria-keyshortcuts={ariaKeys(SHORTCUTS.side)} aria-controls={sideId} aria-expanded={open.side} onClick={() => showPanel("side")}>
            <Button.Icon>{open.side ? <PanelRightClose /> : <PanelRight />}</Button.Icon>
          </Button.Root>
        </Toolbar.Root>
        {width !== "desktop" && <NewPrototype config={config} onCreate={createPrototype} dialog={{ open: naming, onOpenChange: setNaming }} />}
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          data-testid="import-file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void upload(file);
          }}
        />
      </Stack.Root>

      {(problems.length > 0 || notice) && (
        <div className="app-notices">
          {problems.length > 0 && (
            <Alert.Root tone="warning">
              <Alert.Title>Some stored data was not loaded</Alert.Title>
              <Alert.Description>
                <Text.Root as="p" className="pre">
                  {problems.join("\n\n")}
                </Text.Root>
              </Alert.Description>
            </Alert.Root>
          )}
          {notice && (
            <Alert.Root tone={notice.tone} data-testid="notice">
              <Alert.Title>{notice.title}</Alert.Title>
              <Alert.Description>
                <Text.Root as="p" className="pre">
                  {notice.lines.join("\n")}
                </Text.Root>
              </Alert.Description>
              <Alert.Close onClick={() => setNotice(null)} aria-label="Dismiss" />
            </Alert.Root>
          )}
        </div>
      )}

      <Splitter.Root className="shell-body" show={canvasOnly ? "end" : panes === 1 ? (open.chat ? "start" : "end") : "both"} value={open.chat ? panels.chat.width : 0} onValueChange={(value) => resizePanel("chat", value)} min={PANEL_SIZES.chat.min} max={PANEL_SIZES.chat.max} collapsible>
        <Splitter.Panel id={chatId} className="shell-panel">
          <ChatPanel controller={controller} vault={vault} settings={settings} {...(readOnly ? { readOnly: TSX_READ_ONLY } : {})} onSettings={changeSettings} onOpenProposal={openProposal} onOpenVariants={() => setCenter("variants")} prefill={prefill} onClose={() => showPanel("chat", false)} {...(offered ? { suggestion: { pattern: offered, onAccept: () => void answerSuggestion("accepted"), onDismiss: () => void answerSuggestion("dismissed") } } : {})} />
        </Splitter.Panel>
        <Splitter.Handle aria-label="Resize the chat" className="shell-handle" data-side="start" />
        <Splitter.Panel className="shell-panel">
          <Splitter.Root className="shell-inner" primary="end" show={canvasOnly ? "start" : panes === 1 ? (open.side ? "end" : "start") : "both"} value={open.side ? panels.side.width : 0} onValueChange={(value) => resizePanel("side", value)} min={PANEL_SIZES.side.min} max={PANEL_SIZES.side.max} collapsible>
            <Splitter.Panel className="shell-panel">
              <main id={mainId} tabIndex={-1} className="app-main" aria-label={center === "canvas" ? "Canvas" : center === "project" ? "Project" : center === "variants" ? "Variants" : "Proposals"}>
                {/* The board stays laid out under the project view, so frames keep their viewport and keep measuring; out of sight, they are parked once measured. */}
                <div className="app-main-pane" data-inactive={center === "canvas" ? undefined : ""} aria-hidden={center === "canvas" ? undefined : true}>
                  {readOnly && current && <TsxNotice name={current.name} unavailable={cannotCreate(config)} onExport={downloadCode} onStart={() => createPrototype(`${current.name} (spec)`)} />}
                  {!readOnly && (
                  <>
                  <PackagesNotice
                    config={config}
                    packages={state.packages}
                    onSave={(next) => void saveConfig(next)}
                    onMove={(target) => {
                      setLibraryTarget(target);
                      setCenter("project");
                    }}
                  />
                  {previewing && (
                    <Alert.Root tone="info" className="app-preview" data-testid="spec-preview">
                      <Alert.Title>Drawing the agent&apos;s change as it arrives</Alert.Title>
                      <Alert.Description>A draft, not saved yet. The checks judge it once it arrives whole.</Alert.Description>
                    </Alert.Root>
                  )}
                  <FramesShown value={center === "canvas"}>
                  <Board
                    ref={board}
                    session={session}
                    state={state}
                    selected={selected}
                    config={session.current()?.config}
                    pins={current ? boardPins : undefined}
                    floating={
                      canvasOnly
                        ? {
                            start: (
                              <Text.Root as="span" weight="medium" className="floating-name">
                                {prototypeName}
                              </Text.Root>
                            ),
                            end: (
                              <>
                                <span className="floating-status" data-tone={verdict.tone} role="status" data-testid="canvas-status">
                                  <span className="floating-dot" aria-hidden="true" />
                                  {verdict.short}
                                </span>
                                <Button.Root ref={exitButton} variant="secondary" aria-label="Show panels" aria-keyshortcuts="Escape" onClick={leaveCanvasOnly}>
                                  <Button.Icon>
                                    <Shrink />
                                  </Button.Icon>
                                  Show panels <Kbd.Root>{SHORTCUTS.leave.label}</Kbd.Root>
                                </Button.Root>
                              </>
                            ),
                          }
                        : undefined
                    }
                  />
                  </FramesShown>
                  </>
                  )}
                </div>
                {center === "variants" && (
                  <div className="app-main-pane app-main-scroll" data-testid="variants-pane">
                    <VariantsView key={current?.id ?? ""} config={checked(config)} record={current} agent={agent} onApply={applyPick} onUndo={undoPick} onDismiss={dismissVariant} onSend={(message) => void controller.send(message)} onPrefill={prefillChat} pins={current ? variantsPins : undefined} onReanchor={updatePins} show={variantShow} />
                  </div>
                )}
                {center === "project" && (
                  <div className="app-main-pane app-main-scroll">
                    <ProjectView
                      config={config}
                      onOpenProposal={openProposal}
                      onOpenProposals={() => {
                        setReviewing(null);
                        setCenter("proposals");
                      }}
                      prototype={current}
                      onGoToState={goToState}
                      prototypes={records}
                      onSave={(next) => void saveConfig(next)}
                      libraryTarget={libraryTarget}
                      board={{ session, state }}
                      agent={agent}
                      onStartProposal={(next, id, message) => {
                        void saveConfig(next).then(() => {
                          openProposal(id);
                          if (message !== undefined) prefillChat(message);
                        });
                      }}
                      onAskAgent={prefillChat}
                    />
                  </div>
                )}
                {center === "proposals" && (
                  <div className="app-main-pane app-main-scroll" data-testid="proposals-pane">
                    {reviewing === null ? (
                      <ProposalsView config={config} onOpen={openProposal} />
                    ) : (
                      <ProposalPage
                        key={reviewing}
                        config={config}
                        id={reviewing}
                        prototypes={records}
                        openPrototypeId={current?.id ?? ""}
                        board={{ session, state }}
                        agent={agent}
                        onBack={() => setReviewing(null)}
                        onSave={saveConfig}
                        onSendBack={(message) => void controller.send(message)}
                        onOpenPrototype={openPrototype}
                        onOpenProposal={openProposal}
                      />
                    )}
                  </div>
                )}
              </main>
            </Splitter.Panel>
            <Splitter.Handle aria-label="Resize checks and code" className="shell-handle" data-side="end" />
            <Splitter.Panel id={sideId} className="shell-panel">
              <aside className="app-side" aria-label="Checks and code">
                <Tabs.Root value={side} onValueChange={(value) => setSide(value === "code" ? "code" : "checks")} className="app-side-tabs">
                  <div className="panel-head side-head">
                    <Tabs.List aria-label="Side panel">
                      <Tabs.Tab value="checks">
                        Checks
                        {verdict.count > 0 ? (
                          <Badge.Root tone={verdict.tone === "critical" ? "critical" : "warning"} className="side-count">
                            {verdict.count}
                          </Badge.Root>
                        ) : verdict.tone === "success" ? (
                          <span className="side-ok" aria-hidden="true">
                            <CircleCheck />
                          </span>
                        ) : null}
                      </Tabs.Tab>
                      <Tabs.Tab value="code">
                        <span className="side-code-icon" aria-hidden="true">
                          <CodeXml />
                        </span>
                        Code
                      </Tabs.Tab>
                    </Tabs.List>
                    <Button.Root variant="ghost" aria-label="Hide checks and code" onClick={() => showPanel("side", false)} className="panel-close">
                      <Button.Icon>
                        <X />
                      </Button.Icon>
                    </Button.Root>
                  </div>
                  <Tabs.Panel value="checks" keepMounted className="app-side-panel">
                    {readOnly ? (
                      <Text.Root as="p" tone="muted" className="checks-waiting" data-testid="checks-tsx">
                        No checks: TSX prototypes are no longer edited or checked here. Start a spec version to check it against the project&apos;s rules.
                      </Text.Root>
                    ) : (
                      <ChecksPanel state={state} measuredCount={measuredCount} selected={selected} onSelect={select} onShowCode={(finding) => showCode(finding, true)} onFix={fix} {...(key.present ? { onAsk: ask } : {})} proposable={proposable} config={config} flow={flow} onGoToState={goToState} />
                    )}
                    {current && <PinNotes state={pinState} frameOf={pinFrame} actions={pinActions} onShow={showPin} onStart={() => setPinning(true)} onAsk={askAboutNotes} />}
                  </Tabs.Panel>
                  <Tabs.Panel value="code" keepMounted className="app-side-panel">
                    {/* One code view per prototype: the manifest's draft belongs to the prototype it was opened on. */}
                    {current && <CodePanel key={current.id} prototype={current.prototype} target={code} onTarget={setCode} onEdit={edit} />}
                  </Tabs.Panel>
                </Tabs.Root>
              </aside>
            </Splitter.Panel>
          </Splitter.Root>
        </Splitter.Panel>
      </Splitter.Root>
    </div>
  );
}

/**
 * What the canvas shows for a TSX prototype, in place of its board: it is
 * kept for its files, which the code view shows read-only, and nothing
 * renders, checks or changes it. Its code can be exported, and a spec
 * version started beside it, empty, for the agent to build.
 */
function TsxNotice({ name, unavailable, onExport, onStart }: { readonly name: string; readonly unavailable: string | null; readonly onExport: () => void; readonly onStart: () => void }) {
  return (
    <Alert.Root tone="info" className="app-preview" data-testid="tsx-notice">
      <Alert.Title>TSX prototypes are no longer edited or checked here</Alert.Title>
      <Alert.Description>
        <Stack.Root gap="condensed">
          <Text.Root as="p">
            {name} is written in TSX, which this app no longer reads: it is not drawn on the canvas, no rule checks it, and nothing changes it here, not the agent, the code view, variants or notes. Its files are in the code view, read-only. Export its code to keep working on it as React, or start a spec version, an empty spec prototype in this project, and describe it to the agent.
          </Text.Root>
          {unavailable !== null && <Text.Root as="p">{unavailable}</Text.Root>}
          <Stack.Root direction="row" gap="condensed" wrap>
            <Button.Root variant="secondary" onClick={onExport}>
              Export code
            </Button.Root>
            <Button.Root variant="primary" onClick={onStart} disabled={unavailable !== null}>
              Start a spec version
            </Button.Root>
          </Stack.Root>
        </Stack.Root>
      </Alert.Description>
    </Alert.Root>
  );
}

/** What the header and the canvas-only bar say for a TSX prototype: nothing checks it. */
const NOT_CHECKED = { tone: "neutral", short: "Not checked", count: 0 } as const;

/** The prototype's state in a few words, for the Checks tab and the canvas-only bar: core's report, counted. */
function verdictOf(state: SessionState): { readonly tone: "success" | "critical" | "warning" | "neutral"; readonly short: string; readonly count: number } {
  const report = state.report;
  if (!report) return { tone: "neutral", short: "Checking", count: 0 };
  const failing = report.rules.filter((rule) => rule.status === "fail" && rule.findings.length > 0);
  const toFix = failing.filter((rule) => rule.findings.some((finding) => finding.kind === "violation")).length;
  if (toFix > 0) return { tone: "critical", short: `${toFix} to fix`, count: toFix };
  if (failing.length > 0) return { tone: "warning", short: `${failing.length} not checked`, count: failing.length };
  if (report.status === "pass") return { tone: "success", short: "Follows the rules", count: 0 };
  return { tone: "neutral", short: "Checking", count: 0 };
}

/** Everything in a config a check reads: all of it but the proposals. */
function checksKey(config: ProjectConfig): string {
  return JSON.stringify({ ...config, proposals: [] });
}

function firstFile(prototype: StoredPrototype | undefined): string {
  if (!prototype) return MANIFEST_FILE;
  return prototype.pages[0]?.component.file ?? Object.keys(prototype.files).sort()[0] ?? MANIFEST_FILE;
}
