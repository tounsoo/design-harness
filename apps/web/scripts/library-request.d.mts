/** Types for library-request.mjs, the library request workflow's logic, so the unit tests can import its pure parts. */
import type { LibraryDescription, RoleDraft, RoleMapping, RoleName } from "@design-harness/core";
import type { LibraryRequest } from "./library-request-input.mjs";

type PackageJson = { readonly dependencies?: Readonly<Record<string, string>>; readonly designHarness?: { readonly libraries?: unknown }; readonly [key: string]: unknown };

export const E2E_TEST: string;
export class RequestStop extends Error {
  readonly output: string;
  constructor(message: string, output?: string);
}
export type EventDecision =
  | { readonly go: true; readonly issue: number; readonly request: LibraryRequest }
  | { readonly go: false; readonly issue: number; readonly reason: string; readonly quiet?: undefined }
  | { readonly go: false; readonly issue: number | null; readonly quiet: string; readonly reason?: undefined };
export function requestFromEvent(event: unknown, eventName: string | undefined): EventDecision;
export function servedVersions(packageJson: PackageJson, name: string): string[];
export function addToPackageJson(packageJson: PackageJson, request: LibraryRequest): { packageJson: PackageJson & { dependencies: Record<string, string>; designHarness: { libraries: Record<string, Record<string, string[]>> } }; install: string };
export function descriptionPath(request: LibraryRequest): string;
export function registryId(request: LibraryRequest, taken: readonly string[]): string;
export function rootCandidates(description: LibraryDescription): string[];
export function needsChecking(description: LibraryDescription, draft: RoleDraft): string[];
export function registryEntry(request: LibraryRequest, description: LibraryDescription, draft: RoleDraft, where: { readonly id: string; readonly issue: number }): string;
export function addRegistryEntry(source: string, entry: string): string;
export function isListed(source: string, request: LibraryRequest): boolean;
export function registryIds(source: string): string[];
export function manifestProblems(manifest: unknown, request: LibraryRequest, react: string): string[];
export function plain(text: string): string;
export function stopComment(input: { readonly reason: string; readonly output?: string; readonly runUrl?: string }): string;
export type RequestSummary = {
  readonly parts: number;
  readonly families: number;
  readonly roles: readonly { readonly role: RoleName; readonly mapping: RoleMapping; readonly confidence: string }[];
  readonly missing: readonly { readonly role: RoleName; readonly why: string; readonly rules: readonly string[] }[];
  readonly excludedProps: { readonly count: number; readonly sets: readonly string[]; readonly confidence: string } | null;
  readonly check: readonly string[];
};
export function summaryOf(description: LibraryDescription, draft: RoleDraft, effects: readonly { readonly role: RoleName; readonly rules: readonly { readonly rule: string }[] }[]): RequestSummary;
export function pullRequestBody(input: { readonly request: LibraryRequest; readonly issue: number; readonly install: string; readonly before: string; readonly summary: RequestSummary; readonly runUrl: string; readonly files: { readonly description: string } }): string;
export function lockedVersion(lock: { readonly packages?: Readonly<Record<string, { readonly version?: string }>> }, install: string): string | null;
export function draftProblems(description: LibraryDescription, setup: { readonly react: string; readonly stylesheets: readonly string[] }, lib: unknown): { draft: RoleDraft | null; problems: string[] };
export function allowedChanges(request: LibraryRequest): string[];
export function changedPaths(status: string): string[];
export function reportText(input: { readonly parseReason?: string; readonly buildResult?: string; readonly outcome: unknown; readonly publishResult?: string; readonly publishReason?: string; readonly runUrl: string }): string | null;
