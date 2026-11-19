import { Alert, Button, Field, Label, Stack, Text } from "@tounsoo/todae";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatIssues, parsePrototype, type Prototype } from "@design-harness/core";
import type { CompileProblem } from "../runtime/transform";
import type { CodeTarget } from "./Workspace";

/** The manifest, edited as JSON beside the source files. */
export const MANIFEST_FILE = "manifest.json";

/** The prototype without its files: what `manifest.json` shows. */
function manifestOf(prototype: Prototype): string {
  const { files: _files, ...manifest } = prototype;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Index of the first character of `line` (from 1), and of the end of that line. */
export function lineRange(text: string, line: number): { start: number; end: number } {
  let start = 0;
  for (let current = 1; current < line; current += 1) {
    const next = text.indexOf("\n", start);
    if (next === -1) return { start: text.length, end: text.length };
    start = next + 1;
  }
  const end = text.indexOf("\n", start);
  return { start, end: end === -1 ? text.length : end };
}

/**
 * For a finding inside a spec layout instance, the places it is about: where
 * it is written, and each layout use that draws it, nearest first. Each opens
 * its file at its line, and the target keeps them all, so a person can go
 * from the layout's element to the page's use and back.
 */
function InstancePlaces({ target, onTarget }: { readonly target: CodeTarget; readonly onTarget: (target: CodeTarget) => void }) {
  const instance = target.instance;
  if (!instance) return null;
  const places = [
    { ...instance.at, label: instance.via[0]?.slot !== undefined ? "Written on the page" : "In the layout" },
    ...instance.via.map((use) => ({ file: use.file, line: use.line, column: use.column, label: use.slot !== undefined ? `Slot "${use.slot}" of layout ${use.layout}` : `Use of layout ${use.layout}` })),
  ];
  return (
    <Stack.Root direction="row" align="center" gap="condensed" wrap className="code-places" data-testid="instance-places" aria-label="Where this finding is">
      {places.map((place) => {
        const current = place.file === target.file && place.line === target.line;
        return (
          <Button.Root key={`${place.file}:${place.line}:${place.label}`} variant={current ? "secondary" : "ghost"} aria-pressed={current} onClick={() => onTarget({ file: place.file, line: place.line, column: place.column, instance })} data-place={`${place.file}:${place.line}`}>
            {/* One string: the button wraps each text child in a span of its own, which would split its name. */}
            {`${place.label}: ${place.file}:${place.line}`}
          </Button.Root>
        );
      })}
    </Stack.Root>
  );
}

/**
 * A plain code view: pick a file, edit it, and the board and the checks
 * follow. A finding with a file and line opens here with that line marked.
 * `readOnly` shows a TSX prototype's files as they are, with no way to
 * change them: TSX prototypes are no longer edited in the app.
 */
export function CodePanel({
  prototype,
  target,
  onTarget,
  onEdit,
  problems,
  readOnly = false,
}: {
  readonly prototype: Prototype;
  readonly target: CodeTarget;
  readonly onTarget: (target: CodeTarget) => void;
  readonly onEdit: (next: Prototype) => void;
  readonly problems: readonly CompileProblem[];
  readonly readOnly?: boolean;
}) {
  const files = useMemo(() => [...Object.keys(prototype.files).sort(), MANIFEST_FILE], [prototype.files]);
  const file = files.includes(target.file) ? target.file : (files[0] ?? MANIFEST_FILE);
  const isManifest = file === MANIFEST_FILE;
  // The manifest keeps its own draft, since a half-typed manifest is not a prototype yet.
  const [manifestDraft, setManifestDraft] = useState(() => manifestOf(prototype));
  const [manifestIssues, setManifestIssues] = useState<string | null>(null);
  const value = isManifest ? manifestDraft : (prototype.files[file] ?? "");
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!isManifest) setManifestDraft(manifestOf(prototype));
  }, [prototype, isManifest]);

  // Scroll the marked line into view and put the caret on it.
  useEffect(() => {
    const element = textarea.current;
    if (!element || target.line === undefined || target.file !== file) return;
    const { start } = lineRange(element.value, target.line);
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 18;
    element.scrollTop = Math.max(0, (target.line - 4) * lineHeight);
    element.setSelectionRange(start + Math.max(0, (target.column ?? 1) - 1), start + Math.max(0, (target.column ?? 1) - 1));
  }, [target, file]);

  const highlights = target.line !== undefined && target.file === file ? [{ ...lineRange(value, target.line), kind: "finding" }] : [];
  const fileProblems = problems.filter((problem) => problem.file === file);

  const change = (text: string) => {
    if (readOnly) return;
    if (isManifest) {
      setManifestDraft(text);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (error) {
        setManifestIssues(`Not JSON yet: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      // A prototype made here is a spec and stays one: the manifest cannot turn it into TSX.
      if (typeof json === "object" && json !== null && "format" in json && (json as { format?: unknown }).format !== "spec") {
        setManifestIssues('"format" is "spec": a prototype is written as specs here. Remove "format" or set it to "spec".');
        return;
      }
      const parsed = parsePrototype({ ...(json as object), format: "spec", files: prototype.files });
      if (!parsed.ok) {
        setManifestIssues(formatIssues(parsed.error));
        return;
      }
      setManifestIssues(null);
      onEdit(parsed.value);
      return;
    }
    onEdit({ ...prototype, files: { ...prototype.files, [file]: text } });
  };

  return (
    <Stack.Root gap="condensed" className="code">
      <Stack.Root direction="row" align="center" gap="condensed">
        <Label.Root htmlFor="code-file">File</Label.Root>
        <Field.Root id="code-file" className="code-file">
          <Field.Select value={file} onValueChange={(next) => onTarget({ file: next })}>
            {files.map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
          </Field.Select>
        </Field.Root>
        {target.line !== undefined && target.file === file && (
          <Text.Root as="span" tone="muted" data-testid="code-line">
            line {target.line}
            {target.column !== undefined ? `, column ${target.column}` : ""}
          </Text.Root>
        )}
      </Stack.Root>
      {readOnly && (
        <Text.Root as="p" tone="muted" data-testid="code-read-only">
          Read-only: TSX prototypes are no longer edited here.
        </Text.Root>
      )}
      {target.instance && <InstancePlaces target={target} onTarget={onTarget} />}
      {isManifest && manifestIssues && (
        <Alert.Root tone="warning">
          <Alert.Title>The manifest is not applied</Alert.Title>
          <Alert.Description>
            <Text.Root as="p" className="pre">
              {manifestIssues}
            </Text.Root>
          </Alert.Description>
        </Alert.Root>
      )}
      {fileProblems.map((problem, index) => (
        <Alert.Root key={index} tone="warning">
          <Alert.Description>
            <Text.Root as="p" className="pre">
              {problem.message}
            </Text.Root>
          </Alert.Description>
        </Alert.Root>
      ))}
      <Field.Root className="code-field" aria-label={`Source of ${file}`}>
        <Field.Textarea ref={textarea} value={value} onValueChange={change} readOnly={readOnly} highlights={highlights} spellCheck={false} autoCapitalize="off" autoComplete="off" className="code-text" rows={30} data-testid="code-editor" />
      </Field.Root>
    </Stack.Root>
  );
}
