import { Alert, Badge, Button, Field, Stack, Tabs, Text } from "@tounsoo/todae";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Finding, ProjectConfig, Prototype } from "@design-harness/core";
import { AgentController, type ChatRecord, type ChatStore } from "../agent/controller";
import type { KeyVault } from "../agent/key-vault";
import { waitForMeasured } from "../agent/measure";
import type { AgentSettings } from "../agent/models";
import { loadSettings, saveSettings } from "../agent/settings";
import type { AgentHost } from "../agent/tools";
import { frameKey } from "../runtime/session";
import type { Store } from "../store/db";
import { exportFileName, exportProject, importProject, type Imported, type PrototypeRecord } from "../store/project-file";
import { Board } from "./Board";
import { ChatPanel } from "./ChatPanel";
import { ChecksPanel } from "./ChecksPanel";
import { CodePanel, MANIFEST_FILE } from "./CodePanel";
import { ProjectView } from "./ProjectView";
import { ProposalPage } from "./ProposalPage";
import { ProposalsView } from "./ProposalsView";
import { createSession } from "./runtime";

/** How long typing pauses before a new revision is checked and rendered. */
const EDIT_DEBOUNCE_MS = 300;

type Props = {
  readonly store: Store;
  readonly vault: KeyVault;
  readonly config: ProjectConfig;
  readonly prototypes: readonly PrototypeRecord[];
  readonly problems: readonly string[];
  readonly onImported: (imported: Imported) => Promise<void>;
};

/** Where the code view points: a file, and a line in it when a finding named one. */
export type CodeTarget = { readonly file: string; readonly line?: number; readonly column?: number };

/** A prototype's chat, kept in the project store beside it. */
function chatStore(store: Store, projectId: string, prototypeId: string): ChatStore {
  return {
    // The controller checks the record's shape and reports one it cannot read.
    load: async () => (await store.chat(projectId, prototypeId)) as ChatRecord | null,
    save: (record) => store.putChat(projectId, prototypeId, record),
  };
}

export function Workspace({ store, vault, config: initialConfig, prototypes: initial, problems, onImported }: Props) {
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
  const [center, setCenter] = useState<"canvas" | "project" | "proposals">("canvas");
  /** The proposal whose review page is open in the Proposals view, or null for the list. */
  const [reviewing, setReviewing] = useState<string | null>(null);
  /** Text put into the chat's message box for the person to edit and send; the nonce makes the same text land twice. */
  const [prefill, setPrefill] = useState<{ readonly text: string; readonly nonce: number } | null>(null);
  const [side, setSide] = useState<"checks" | "code">("checks");
  const [selected, setSelected] = useState<Finding | null>(null);
  const [code, setCode] = useState<CodeTarget>({ file: firstFile(current?.prototype) });
  const [notice, setNotice] = useState<{ tone: "success" | "critical"; title: string; lines: readonly string[] } | null>(null);

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
      now: () => new Date().toISOString(),
    };
  }, [currentId, session, setRecords, saveConfig, checked]);

  const controller = useMemo(
    () => new AgentController({ host, store: chatStore(store, initialConfig.id, currentId), key: () => vault.get(), settings: () => settingsRef.current }),
    [host, store, vault, initialConfig.id, currentId],
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

  const openProposal = useCallback((id: string) => {
    setReviewing(id);
    setCenter("proposals");
  }, []);

  const select = useCallback(
    (finding: Finding | null) => {
      setSelected(finding);
      for (const frame of session.getState().frames) session.highlight(frame.key, null);
      if (!finding) return;
      if (finding.scenario !== undefined && finding.view !== undefined) {
        const key = frameKey(finding.scenario, finding.view);
        session.highlight(key, finding.element ?? null);
        setCenter("canvas");
        document.querySelector(`[data-frame-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      if (finding.file !== undefined) {
        setCode({ file: finding.file, ...(finding.line !== undefined ? { line: finding.line } : {}), ...(finding.column !== undefined ? { column: finding.column } : {}) });
        if (finding.scenario === undefined) setSide("code");
      }
    },
    [session],
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
  }, []);
  const proposable = useCallback(
    (finding: Finding) => {
      const rule = configRef.current.rules.find((item) => item.id === finding.rule);
      return rule?.type === "membership" && rule.of !== "imports";
    },
    [],
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

  return (
    <div className="app">
      <header className="app-header">
        <Stack.Root direction="row" align="center" gap="normal" className="app-header-start">
          <Text.Root as="span" weight="bold">
            design-harness
          </Text.Root>
          <Text.Root as="span" tone="muted">
            {config.name} /
          </Text.Root>
          {records.length > 1 ? (
            <Field.Root aria-label="Prototype" className="app-prototype">
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
            <Text.Root as="span" tone="muted">
              {current?.name ?? "no prototype"}
            </Text.Root>
          )}
          <Badge.Root tone="neutral">
            {config.library.package} {config.library.version}
          </Badge.Root>
        </Stack.Root>
        <Tabs.Root
          value={center}
          onValueChange={(value) => {
            if (value === "proposals" && center === "proposals") setReviewing(null);
            setCenter(value === "project" ? "project" : value === "proposals" ? "proposals" : "canvas");
          }}
          className="app-center-tabs"
        >
          <Tabs.List aria-label="Main view">
            <Tabs.Tab value="canvas">Canvas</Tabs.Tab>
            <Tabs.Tab value="project">Project</Tabs.Tab>
            <Tabs.Tab value="proposals" onClick={() => center === "proposals" && setReviewing(null)}>
              Proposals
              {openCount > 0 && (
                <Badge.Root tone="info" className="app-tab-count" data-testid="open-proposals" aria-label={`${openCount} open`}>
                  {openCount}
                </Badge.Root>
              )}
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.Root>
        <Stack.Root direction="row" align="center" gap="condensed" className="app-header-end">
          <Button.Root variant="ghost" onClick={download}>
            Export
          </Button.Root>
          <Button.Root variant="ghost" onClick={() => fileInput.current?.click()}>
            Import
          </Button.Root>
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
      </header>

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
            <Alert.Root tone={notice.tone}>
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

      <div className="app-body">
        <ChatPanel controller={controller} vault={vault} settings={settings} onSettings={changeSettings} onOpenProposal={openProposal} prefill={prefill} />
        <main className="app-main" aria-label={center === "canvas" ? "Canvas" : center === "project" ? "Project" : "Proposals"}>
          {/* The board stays laid out under the project view, so frames keep their viewport and keep measuring. */}
          <div className="app-main-pane" data-inactive={center === "canvas" ? undefined : ""} aria-hidden={center === "canvas" ? undefined : true}>
            <Board session={session} state={state} selected={selected} />
          </div>
          {center === "project" && (
            <div className="app-main-pane app-main-scroll">
              <ProjectView config={config} onOpenProposal={openProposal} />
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
        <aside className="app-side" aria-label="Checks and code">
          <Tabs.Root value={side} onValueChange={(value) => setSide(value === "code" ? "code" : "checks")} className="app-side-tabs">
            <Tabs.List aria-label="Side panel">
              <Tabs.Tab value="checks">
                Checks{" "}
                {state.report && (
                  <Badge.Root tone={state.report.status === "pass" ? "success" : state.report.status === "fail" ? "critical" : "neutral"}>{state.report.status}</Badge.Root>
                )}
              </Tabs.Tab>
              <Tabs.Tab value="code">Code</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="checks" keepMounted className="app-side-panel">
              <ChecksPanel state={state} measuredCount={measuredCount} selected={selected} onSelect={select} {...(key.present ? { onAsk: ask } : {})} proposable={proposable} config={config} />
            </Tabs.Panel>
            <Tabs.Panel value="code" keepMounted className="app-side-panel">
              {current && <CodePanel prototype={current.prototype} target={code} onTarget={setCode} onEdit={edit} problems={state.compileProblems} />}
            </Tabs.Panel>
          </Tabs.Root>
        </aside>
      </div>
    </div>
  );
}

/** Everything in a config a check reads: all of it but the proposals. */
function checksKey(config: ProjectConfig): string {
  return JSON.stringify({ ...config, proposals: [] });
}

function firstFile(prototype: Prototype | undefined): string {
  if (!prototype) return MANIFEST_FILE;
  return prototype.pages[0]?.component.file ?? Object.keys(prototype.files).sort()[0] ?? MANIFEST_FILE;
}
