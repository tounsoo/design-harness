import type { Prototype } from "@design-harness/core";
import type * as JsonRenderCore from "@json-render/core";
import type { SpecStreamCompiler } from "@json-render/core";

/**
 * The canvas follows a patch_spec call while its input streams. With eager
 * input streaming the API sends the tool input as JSON fragments; the
 * `patches` string inside it is json-render's SpecStream (one JSON Patch per
 * line), so the part that has arrived is fed to json-render's
 * `createSpecStreamCompiler`, seeded with the file as it is, and each time a
 * line completes the draft is shown: a preview revision of the prototype
 * with the draft spec in that file, rendered by the same frames.
 *
 * A preview is only a picture. It is not saved, not undoable and never what
 * the agent's checks report: when the call runs, patch_spec checks the whole
 * input against the catalog and applies it or refuses it, and the board
 * returns to the prototype as it really is.
 */

/** The part of a JSON string literal that has arrived, decoded; `raw` starts just after its opening quote. */
export function partialString(raw: string): string {
  let end = 0;
  while (end < raw.length) {
    const char = raw[end];
    if (char === '"') break;
    if (char === "\\") {
      const next = raw[end + 1];
      if (next === undefined) break;
      if (next === "u") {
        if (!/^[0-9a-fA-F]{4}$/.test(raw.slice(end + 2, end + 6))) break;
        end += 6;
      } else end += 2;
      continue;
    }
    end += 1;
  }
  try {
    return JSON.parse(`"${raw.slice(0, end)}"`) as string;
  } catch {
    return "";
  }
}

/** The `path` and the arrived part of `patches` in a patch_spec input that is still streaming. */
export function streamedPatchInput(json: string): { readonly path: string | null; readonly patches: string } {
  const path = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(json);
  const start = /"patches"\s*:\s*"/.exec(json);
  return { path: path ? partialString(`${path[1]}"`) : null, patches: start ? partialString(json.slice(start.index + start[0].length)) : "" };
}

type Stream = { readonly path: string; readonly base: Prototype; readonly compiler: SpecStreamCompiler<Record<string, unknown>>; fed: number; shown: number; timer: ReturnType<typeof setTimeout> | null; draft: Prototype | null };

export class SpecStreamPreview {
  private stream: Stream | null = null;
  private loading: Promise<typeof JsonRenderCore> | null = null;
  private input = "";
  private active = false;

  /**
   * `show` puts a draft on the board, or, with null, the prototype as it is.
   * `prototype` is the prototype the patch applies to. `everyMs` spaces the
   * preview revisions, since each one renders every frame afresh.
   */
  constructor(
    private readonly show: (draft: Prototype | null) => void,
    private readonly prototype: () => Prototype,
    private readonly everyMs = 250,
  ) {}

  /** A tool call started streaming. Only a spec prototype's patch_spec is followed. */
  start(name: string): void {
    this.finish();
    if (name !== "patch_spec" || this.prototype().format !== "spec") return;
    this.active = true;
    this.input = "";
    this.loading ??= import("@json-render/core");
  }

  /** More of the call's input arrived. */
  delta(partialJson: string): void {
    if (!this.active) return;
    this.input += partialJson;
    void this.feed();
  }

  private async feed(): Promise<void> {
    const { path, patches } = streamedPatchInput(this.input);
    if (path === null || !this.loading) return;
    const library = await this.loading;
    if (!this.active) return;
    if (!this.stream) {
      const base = this.prototype();
      const text = base.files[path];
      if (text === undefined) return;
      let seed: Record<string, unknown>;
      try {
        seed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      this.stream = { path, base, compiler: library.createSpecStreamCompiler(seed), fed: 0, shown: 0, timer: null, draft: null };
    }
    const stream = this.stream;
    if (patches.length <= stream.fed) return;
    const { result, newPatches } = stream.compiler.push(patches.slice(stream.fed));
    stream.fed = patches.length;
    if (newPatches.length === 0) return;
    stream.draft = { ...stream.base, files: { ...stream.base.files, [stream.path]: `${JSON.stringify(result, null, 2)}\n` } };
    stream.timer ??= setTimeout(() => {
      stream.timer = null;
      if (this.stream === stream && stream.draft) this.show(stream.draft);
    }, this.everyMs);
  }

  /** The call's input is complete, or the turn ended: the board goes back to the prototype as it is, once the call has run. */
  finish(): void {
    const had = this.stream !== null;
    if (this.stream?.timer) clearTimeout(this.stream.timer);
    this.stream = null;
    this.active = false;
    this.input = "";
    if (had) this.show(null);
  }
}
