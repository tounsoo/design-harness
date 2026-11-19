import type { TurnItem } from "../agent/controller";
import { humanize } from "./words";

type ToolItem = Extract<TurnItem, { kind: "tool" }>;
type ChecksItem = Extract<TurnItem, { kind: "checks" }>;

/** A prototype file in words: "pages/booking.tsx" is "the booking page". */
export function fileWords(path: string): string {
  if (path === "manifest.json") return "the prototype's pages and scenarios";
  const match = /^(pages|layouts|data|components)\/(.+?)(\.[a-z]+)?$/.exec(path);
  if (!match) return path;
  const [, folder, name = ""] = match;
  const words = humanize(name.replace(/\//g, " ")).toLowerCase();
  return folder === "pages" ? `the ${words} page` : folder === "layouts" ? `the ${words} layout` : folder === "data" ? `the ${words} data` : `the ${words} component`;
}

function inputPath(item: ToolItem): string | null {
  try {
    const value: unknown = JSON.parse(item.input || "{}");
    const path = typeof value === "object" && value !== null ? (value as { path?: unknown }).path : undefined;
    return typeof path === "string" ? path : null;
  } catch {
    // A tool's input streams in as partial JSON; its path is known once it is whole.
    const match = /"path"\s*:\s*"([^"]+)"/.exec(item.input);
    return match?.[1] ?? null;
  }
}

const CHANGES = new Set(["edit_file", "write_file", "write_spec", "patch_spec", "insert_layout", "set_layout_params"]);

/**
 * A tool call as one short line a person reads in the chat: "Changed the
 * booking page", "Looked at the project". The exact tool name, its title
 * from the app, its input and its result stay in the call's details.
 */
export function toolSummary(item: ToolItem): string {
  const path = inputPath(item);
  const thing = path ? fileWords(path) : null;
  const unchanged = item.title.endsWith("(unchanged)");
  if (item.status === "streaming") return CHANGES.has(item.name) && thing ? `Writing ${thing}…` : "Getting ready…";
  if (item.status === "error") {
    if (item.title.endsWith("stopped")) return "Stopped before it ran";
    return CHANGES.has(item.name) || item.name === "set_manifest" || item.name === "delete_file" ? `Could not change ${thing ?? "the prototype"}` : `${humanize(item.name)} did not work`;
  }
  const running = item.status === "running";
  switch (item.name) {
    case "read_project":
      return running ? "Reading the project…" : "Read the project's rules and parts";
    case "list_files":
      return running ? "Looking at the files…" : "Looked at the prototype's files";
    case "read_file":
      return running ? `Reading ${thing ?? "a file"}…` : `Looked at ${thing ?? "a file"}`;
    case "list_layouts":
      return running ? "Looking at the layouts…" : "Looked at the prototype's layouts";
    case "set_manifest":
      return running ? "Updating the pages and scenarios…" : "Updated the pages and scenarios";
    case "delete_file":
      return running ? `Removing ${thing ?? "a file"}…` : `Removed ${thing ?? "a file"}`;
    case "run_checks":
      return running ? "Checking the rules…" : "Checked the rules";
    case "draft_proposal":
      return running ? "Drafting a proposal…" : "Drafted a proposal";
    case "revise_proposal":
      return running ? "Revising the proposal…" : "Revised the proposal";
    default:
      if (CHANGES.has(item.name)) return running ? `Changing ${thing ?? "the prototype"}…` : unchanged ? `Left ${thing ?? "the prototype"} as it was` : `Changed ${thing ?? "the prototype"}`;
      return item.title || humanize(item.name);
  }
}

/** The checks the app ran after a change, in a line: "Checked the rules: all good". */
export function checksSummary(item: ChecksItem): string {
  if (item.status === "pass") return "Checked the rules: all good";
  if (item.status === "incomplete") return "Checked the rules: some could not run";
  const failing = /(\d+) rules?/.exec(item.title)?.[1];
  const count = failing ? Number(failing) : 0;
  return count > 0 ? `Checked the rules: ${count} ${count === 1 ? "thing" : "things"} to fix` : "Checked the rules: something to fix";
}
