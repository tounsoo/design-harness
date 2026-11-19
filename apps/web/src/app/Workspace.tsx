import { Alert, Badge, Button, Field, Kbd, Link, Splitter, Stack, Tabs, Text, Toolbar, VisuallyHidden, useAnnouncer, useHotkey } from "@tounsoo/todae";
import { CircleCheck, CodeXml, Download, Expand, FileCode2, FolderPlus, PanelLeft, PanelLeftClose, PanelRight, PanelRightClose, Shapes, Shrink, Upload, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { NO_VARIANTS, flowFacts, variantLabel, type Finding, type LayoutUse, type PickRecord, type ProjectConfig, type Prototype, type Variant, type VariantState } from "@design-harness/core";
import { AgentController, type ChatRecord, type ChatStore } from "../agent/controller";
import { SpecStreamPreview } from "../agent/spec-stream";
import type { KeyVault } from "../agent/key-vault";
import { latestMeasured, waitForMeasured } from "../agent/measure";
import { detectPatterns, suggestion as suggestionOf, patternMessage } from "../agent/patterns";
import type { AgentSettings } from "../agent/models";
import { loadSettings, saveSettings } from "../agent/settings";
import type { AgentHost } from "../agent/tools";
import { frameKey, type SessionState } from "../runtime/session";
import { planOutline } from "../runtime/tags";
import type { Store } from "../store/db";
import type { LoadNote } from "../store/migrate";
import { exportFileName, exportProject, importProject, type Imported, type PrototypeRecord } from "../store/project-file";
import { Board, type BoardHandle } from "./Board";
import { ChatPanel } from "./ChatPanel";
import { ChecksPanel } from "./ChecksPanel";
import { CodePanel, MANIFEST_FILE } from "./CodePanel";
import { NewPrototype } from "./NewPrototype";
import { blankPrototype, prototypeId, type PrototypeFormat } from "./new-prototype";
import { ProjectView } from "./ProjectView";
import { ProposalPage } from "./ProposalPage";
import { ProposalsView } from "./ProposalsView";
import { PANEL_SIZES, usePanels } from "./panels";
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
  const [center, setCenter] = useState<"canvas" | "project" | "proposals" | "variants">("canvas");
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

  const { panels, resize, toggle } = usePanels();
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
    const target = moveFocus.current === "exit" ? exitButton.current : moveFocus.current === "toggle" ? canvasToggle.current : null;
    moveFocus.current = null;
    target?.focus();
  }, [canvasOnly]);
  useHotkey(SHORTCUTS.canvasOnly.keys, () => (canvasOnly ? leaveCanvasOnly() : enterCanvasOnly()));
  useHotkey(SHORTCUTS.leave.keys, leaveCanvasOnly, { enabled: canvasOnly });
  useHotkey(SHORTCUTS.chat.keys, () => {
    if (canvasOnly) leaveCanvasOnly();
    toggle("chat", canvasOnly ? true : undefined);
  });
  useHotkey(SHORTCUTS.side.keys, () => {
    if (canvasOnly) leaveCanvasOnly();
    toggle("side", canvasOnly ? true : undefined);
  });

  // A new revision for each settled edit; the first one at once. The agent's changes start theirs at once, so they are skipped here.
  const prototype = current?.prototype;
  const first = useRef(true);
  useEffect(() => {
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
  }, [session, config, prototype, checked]);

  // Edits are saved in the browser once typing pauses.
  useEffect(() => {
    if (!current || current.prototype === initial.find((record) => record.id === current.id)?.prototype) return;
    const timer = setTimeout(() => void store.putPrototype(current), EDIT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [store, current, initial]);

  const edit = useCallback(
    (next: Prototype) => {
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

  // The agent's view of the app, for the prototype open now: its changes are revisions at once, and its checks wait for every frame.
  const host = useMemo((): AgentHost => {
    const prototypeOf = () => recordsRef.current.find((record) => record.id === currentId)?.prototype ?? recordsRef.current[0]?.prototype;
    return {
      config: () => configRef.current,
      prototype: () => {
        const value = prototypeOf();
        if (!value) throw new Error("no prototype is open");
        return value;
      },
      apply: (next) => {
        setSelected(null);
        setRecords((items) => items.map((item) => (item.id === currentId ? { ...item, prototype: next } : item)));
        session.update(checked(configRef.current), next);
        const after = session.getState();
        return { revision: after.revision, compileProblems: after.compileProblems };
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
    };
  }, [currentId, session, setRecords, saveConfig, checked, recordOf, updateVariants]);

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
      toggle("side", true);
    }
  }, [toggle]);

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
    toggle("chat", true);
  }, [toggle]);
  /** "Ask the agent to fix": a message for the person to edit and send, about any finding. */
  const fix = useCallback(
    (finding: Finding) => {
      const place = finding.file !== undefined ? ` (${finding.file}${finding.line !== undefined ? `:${finding.line}` : ""})` : finding.scenario !== undefined ? ` (scenario ${finding.scenario}${finding.view !== undefined ? `, ${finding.view}` : ""})` : finding.page !== undefined ? ` (page ${finding.page})` : "";
      const text = `Please fix this so the prototype follows the project's rules.\n\nThe check "${finding.rule}" says: ${finding.message}${place}`;
      setPrefill((previous) => ({ text, nonce: (previous?.nonce ?? 0) + 1 }));
      setCanvasOnly(false);
      toggle("chat", true);
      // The loop counts asks per rule (agent/patterns.ts); a press tells the agent nothing by itself.
      void controller.record({ kind: "fix-asked", at: new Date().toISOString(), rule: finding.rule });
    },
    [toggle, controller],
  );
  /** The person's pick: the recombined page as a new revision, recorded with where each slot came from. Nothing but this view's Apply calls it. */
  const applyPick = useCallback(
    (pick: ApplyPick) => {
      const at = new Date().toISOString();
      const record: PickRecord = { at, page: pick.page, slots: pick.slots, notes: pick.notes, before: pick.before, after: pick.after };
      setSelected(null);
      updateVariants((state) => ({ ...state, picks: [...state.picks, record] }), pick.prototype);
      session.update(checked(configRef.current), pick.prototype);
      const from = Object.entries(pick.slots).map(([slot, source]) => `${slot} from ${variantLabel(source)}`).join(", ");
      void controller.note(`The person applied a pick to page "${pick.page}": ${from}. The page's file is that combination now; read it again before you change it.`);
      setNotice({ tone: "success", title: "Pick applied", lines: [`Page ${pick.page}: ${from}. It is a new revision; Undo is under Picks applied.`] });
    },
    [updateVariants, session, checked, controller],
  );
  const undoPick = useCallback(
    (index: number) => {
      const record = recordOf();
      const pick = record?.variants?.picks[index];
      const page = record?.prototype.pages.find((item) => item.id === pick?.page);
      if (!record || !pick || !page) return;
      const restored: Prototype = { ...record.prototype, files: { ...record.prototype.files, [page.component.file]: pick.before } };
      setSelected(null);
      updateVariants((state) => ({ ...state, picks: state.picks.map((item, at) => (at === index ? { ...item, undone: true } : item)) }), restored);
      session.update(checked(configRef.current), restored);
      void controller.note(`The person undid their pick on page "${pick.page}": the page is back to what it was before it.`);
    },
    [recordOf, updateVariants, session, checked, controller],
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
      toggle("chat", true);
    },
    [toggle],
  );

  const proposable = useCallback(
    (finding: Finding) => {
      const rule = configRef.current.rules.find((item) => item.id === finding.rule);
      return rule?.type === "membership" && rule.of !== "imports";
    },
    [],
  );

  /** A new, empty prototype in the format the person chose (spec by default), saved and opened on the board. */
  const createPrototype = useCallback(
    (name: string, format: PrototypeFormat) => {
      const record: PrototypeRecord = { projectId: initialConfig.id, id: prototypeId(name, recordsRef.current.map((item) => item.id)), name, prototype: blankPrototype(format) };
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
    const zipped = codeZip({ config: configRef.current, prototype: current.prototype, name: current.name, at: new Date().toISOString(), report: state.measured ? state.report : null });
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
  const verdict = verdictOf(state);
  const formatName = current?.prototype.format === "spec" ? "Spec" : "TSX";
  const prototypeName = current?.name ?? "No prototype";

  return (
    <div className="shell" data-canvas-only={canvasOnly ? "" : undefined}>
      <Stack.Root as="header" direction="row" align="center" gap="condensed" className="shell-header">
        <VisuallyHidden.Root focusable>
          <Link.Root href={`#${mainId}`} onClick={(event) => {
              event.preventDefault();
              document.getElementById(mainId)?.focus();
            }}>
            Skip to the canvas
          </Link.Root>
        </VisuallyHidden.Root>
        <Button.Root variant="ghost" aria-label={`Chat (${SHORTCUTS.chat.label})`} aria-keyshortcuts={ariaKeys(SHORTCUTS.chat)} aria-controls={chatId} aria-expanded={panels.chat.open} onClick={() => toggle("chat")} className="shell-toggle">
          <Button.Icon>{panels.chat.open ? <PanelLeftClose /> : <PanelLeft />}</Button.Icon>
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
                    {record.name}
                  </option>
                ))}
              </Field.Select>
            </Field.Root>
          ) : (
            <Text.Root as="span" weight="medium">
              {prototypeName}
            </Text.Root>
          )}
          {current && (
            <Badge.Root tone="neutral" data-testid="prototype-format" title={current.prototype.format === "spec" ? "A json-render spec prototype: pages and layouts as data" : "A TSX prototype: pages and layouts as React code"}>
              {formatName}
            </Badge.Root>
          )}
        </Stack.Root>
        <Tabs.Root
          value={center}
          onValueChange={(value) => {
            if (value === "proposals" && center === "proposals") setReviewing(null);
            setCenter(value === "project" ? "project" : value === "proposals" ? "proposals" : value === "variants" ? "variants" : "canvas");
          }}
          className="shell-views"
        >
          <Tabs.List aria-label="Main view">
            <Tabs.Tab value="canvas">Canvas</Tabs.Tab>
            <Tabs.Tab value="variants">
              Variants
              {variantCount > 0 && (
                <Badge.Root tone="neutral" className="shell-tab-count" data-testid="variant-count" aria-label={`${variantCount} variants`}>
                  {variantCount}
                </Badge.Root>
              )}
            </Tabs.Tab>
            <Tabs.Tab value="project">Project</Tabs.Tab>
            <Tabs.Tab value="proposals" onClick={() => center === "proposals" && setReviewing(null)}>
              Proposals
              {openCount > 0 && (
                <Badge.Root tone="warning" className="shell-tab-count" data-testid="open-proposals" aria-label={`${openCount} open`}>
                  {openCount}
                </Badge.Root>
              )}
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.Root>
        <Toolbar.Root aria-label="Prototype actions" className="shell-actions">
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
          <Button.Root ref={canvasToggle} variant="ghost" aria-label={`Canvas only (${SHORTCUTS.canvasOnly.label})`} aria-keyshortcuts={ariaKeys(SHORTCUTS.canvasOnly)} pressed={canvasOnly} onPressedChange={(next) => (next ? enterCanvasOnly() : leaveCanvasOnly())}>
            <Button.Icon>
              <Expand />
            </Button.Icon>
          </Button.Root>
          <Button.Root variant="ghost" aria-label={`Checks and code (${SHORTCUTS.side.label})`} aria-keyshortcuts={ariaKeys(SHORTCUTS.side)} aria-controls={sideId} aria-expanded={panels.side.open} onClick={() => toggle("side")}>
            <Button.Icon>{panels.side.open ? <PanelRightClose /> : <PanelRight />}</Button.Icon>
          </Button.Root>
        </Toolbar.Root>
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

      <Splitter.Root className="shell-body" show={canvasOnly ? "end" : "both"} value={panels.chat.open ? panels.chat.width : 0} onValueChange={(value) => resize("chat", value)} min={PANEL_SIZES.chat.min} max={PANEL_SIZES.chat.max} collapsible>
        <Splitter.Panel id={chatId} className="shell-panel">
          <ChatPanel controller={controller} vault={vault} settings={settings} onSettings={changeSettings} onOpenProposal={openProposal} onOpenVariants={() => setCenter("variants")} prefill={prefill} onClose={() => toggle("chat", false)} {...(offered ? { suggestion: { pattern: offered, onAccept: () => void answerSuggestion("accepted"), onDismiss: () => void answerSuggestion("dismissed") } } : {})} />
        </Splitter.Panel>
        <Splitter.Handle aria-label="Resize the chat" className="shell-handle" data-side="start" />
        <Splitter.Panel className="shell-panel">
          <Splitter.Root className="shell-inner" primary="end" show={canvasOnly ? "start" : "both"} value={panels.side.open ? panels.side.width : 0} onValueChange={(value) => resize("side", value)} min={PANEL_SIZES.side.min} max={PANEL_SIZES.side.max} collapsible>
            <Splitter.Panel className="shell-panel">
              <main id={mainId} tabIndex={-1} className="app-main" aria-label={center === "canvas" ? "Canvas" : center === "project" ? "Project" : center === "variants" ? "Variants" : "Proposals"}>
                {/* The board stays laid out under the project view, so frames keep their viewport and keep measuring. */}
                <div className="app-main-pane" data-inactive={center === "canvas" ? undefined : ""} aria-hidden={center === "canvas" ? undefined : true}>
                  {previewing && (
                    <Alert.Root tone="info" className="app-preview" data-testid="spec-preview">
                      <Alert.Title>Drawing the agent&apos;s change as it arrives</Alert.Title>
                      <Alert.Description>A draft, not saved yet. The checks judge it once it arrives whole.</Alert.Description>
                    </Alert.Root>
                  )}
                  <Board
                    ref={board}
                    session={session}
                    state={state}
                    selected={selected}
                    config={session.current()?.config}
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
                </div>
                {center === "variants" && (
                  <div className="app-main-pane app-main-scroll" data-testid="variants-pane">
                    <VariantsView key={current?.id ?? ""} config={checked(config)} record={current} agent={agent} onApply={applyPick} onUndo={undoPick} onDismiss={dismissVariant} onSend={(message) => void controller.send(message)} onPrefill={prefillChat} />
                  </div>
                )}
                {center === "project" && (
                  <div className="app-main-pane app-main-scroll">
                    <ProjectView config={config} onOpenProposal={openProposal} prototype={current} onGoToState={goToState} />
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
                    <Button.Root variant="ghost" aria-label="Hide checks and code" onClick={() => toggle("side", false)} className="panel-close">
                      <Button.Icon>
                        <X />
                      </Button.Icon>
                    </Button.Root>
                  </div>
                  <Tabs.Panel value="checks" keepMounted className="app-side-panel">
                    <ChecksPanel state={state} measuredCount={measuredCount} selected={selected} onSelect={select} onShowCode={(finding) => showCode(finding, true)} onFix={fix} {...(key.present ? { onAsk: ask } : {})} proposable={proposable} config={config} flow={flow} onGoToState={goToState} />
                  </Tabs.Panel>
                  <Tabs.Panel value="code" keepMounted className="app-side-panel">
                    {current && <CodePanel prototype={current.prototype} target={code} onTarget={setCode} onEdit={edit} problems={state.compileProblems} />}
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

function firstFile(prototype: Prototype | undefined): string {
  if (!prototype) return MANIFEST_FILE;
  return prototype.pages[0]?.component.file ?? Object.keys(prototype.files).sort()[0] ?? MANIFEST_FILE;
}
