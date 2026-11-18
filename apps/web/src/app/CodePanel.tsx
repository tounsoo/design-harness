import { Alert, Field, Label, Stack, Text } from "@tounsoo/todae";
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
 * A plain code view: pick a file, edit it, and the board and the checks
 * follow. It stands in for the agent until the agent arrives. A finding with
 * a file and line opens here with that line marked.
 */
export function CodePanel({
  prototype,
  target,
  onTarget,
  onEdit,
  problems,
}: {
  readonly prototype: Prototype;
  readonly target: CodeTarget;
  readonly onTarget: (target: CodeTarget) => void;
  readonly onEdit: (next: Prototype) => void;
  readonly problems: readonly CompileProblem[];
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
    if (isManifest) {
      setManifestDraft(text);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (error) {
        setManifestIssues(`Not JSON yet: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const parsed = parsePrototype({ ...(json as object), files: prototype.files });
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
        <Field.Textarea ref={textarea} value={value} onValueChange={change} highlights={highlights} spellCheck={false} autoCapitalize="off" autoComplete="off" className="code-text" rows={30} data-testid="code-editor" />
      </Field.Root>
    </Stack.Root>
  );
}
