import { Alert, Badge, Button, Field, Stack, Tabs, Text } from "@tounsoo/todae";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Finding, ProjectConfig, Prototype } from "@design-harness/core";
import { frameKey } from "../runtime/session";
import type { Store } from "../store/db";
import { exportFileName, exportProject, importProject, type Imported, type PrototypeRecord } from "../store/project-file";
import { Board } from "./Board";
import { ChatPanel } from "./ChatPanel";
import { ChecksPanel } from "./ChecksPanel";
import { CodePanel, MANIFEST_FILE } from "./CodePanel";
import { ProjectView } from "./ProjectView";
import { createSession } from "./runtime";

/** How long typing pauses before a new revision is checked and rendered. */
const EDIT_DEBOUNCE_MS = 300;

type Props = {
  readonly store: Store;
  readonly config: ProjectConfig;
  readonly prototypes: readonly PrototypeRecord[];
  readonly problems: readonly string[];
  readonly onImported: (imported: Imported) => Promise<void>;
};

/** Where the code view points: a file, and a line in it when a finding named one. */
export type CodeTarget = { readonly file: string; readonly line?: number; readonly column?: number };

export function Workspace({ store, config, prototypes: initial, problems, onImported }: Props) {
  const session = useMemo(() => createSession(), []);
  useEffect(() => () => session.dispose(), [session]);
  const state = useSyncExternalStore(session.subscribe, session.getState);

  const [records, setRecords] = useState(initial);
  const [currentId, setCurrentId] = useState(initial[0]?.id ?? "");
  const current = records.find((record) => record.id === currentId) ?? records[0];
  const [center, setCenter] = useState<"canvas" | "project">("canvas");
  const [side, setSide] = useState<"checks" | "code">("checks");
  const [selected, setSelected] = useState<Finding | null>(null);
  const [code, setCode] = useState<CodeTarget>({ file: firstFile(current?.prototype) });
  const [notice, setNotice] = useState<{ tone: "success" | "critical"; title: string; lines: readonly string[] } | null>(null);

  // A new revision for each settled edit; the first one at once.
  const prototype = current?.prototype;
  const first = useRef(true);
  useEffect(() => {
    if (!prototype) return;
    if (first.current) {
      first.current = false;
      session.update(config, prototype);
      return;
    }
    const timer = setTimeout(() => session.update(config, prototype), EDIT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [session, config, prototype]);

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
    [currentId],
  );

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

  const download = () => {
    const blob = new Blob([exportProject(config, records)], { type: "application/json" });
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
        <Tabs.Root value={center} onValueChange={(value) => setCenter(value === "project" ? "project" : "canvas")} className="app-center-tabs">
          <Tabs.List aria-label="Main view">
            <Tabs.Tab value="canvas">Canvas</Tabs.Tab>
            <Tabs.Tab value="project">Project</Tabs.Tab>
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
        <ChatPanel />
        <main className="app-main" aria-label={center === "canvas" ? "Canvas" : "Project"}>
          {/* The board stays laid out under the project view, so frames keep their viewport and keep measuring. */}
          <div className="app-main-pane" data-inactive={center === "canvas" ? undefined : ""} aria-hidden={center === "canvas" ? undefined : true}>
            <Board session={session} state={state} selected={selected} />
          </div>
          {center === "project" && (
            <div className="app-main-pane app-main-scroll">
              <ProjectView config={config} />
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
              <ChecksPanel state={state} measuredCount={measuredCount} selected={selected} onSelect={select} />
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

function firstFile(prototype: Prototype | undefined): string {
  if (!prototype) return MANIFEST_FILE;
  return prototype.pages[0]?.component.file ?? Object.keys(prototype.files).sort()[0] ?? MANIFEST_FILE;
}
