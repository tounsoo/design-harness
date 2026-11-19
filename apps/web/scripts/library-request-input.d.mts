/** Types for library-request-input.mjs, which the wizard and the library request workflow share. */
export type LibraryRequest = { readonly package: string; readonly version: string; readonly stylesheets: readonly string[] };
export type RequestField = "package" | "version" | "stylesheets";
export type RequestError = { readonly field: RequestField | "issue"; readonly message: string };
export type RequestResult = { readonly ok: true; readonly value: LibraryRequest } | { readonly ok: false; readonly errors: readonly RequestError[] };

export const REQUEST_REPOSITORY: string;
export const REQUEST_TEMPLATE: string;
export const REQUEST_LABEL: string;
export const REQUEST_FIELDS: Readonly<Record<RequestField, { readonly id: string; readonly label: string }>>;
export const LIMITS: { readonly package: number; readonly version: number; readonly stylesheets: number; readonly stylesheet: number; readonly field: number; readonly body: number };
export function shown(value: unknown): string;
export function stylesheetList(text: string): string[];
export function validateLibraryRequest(fields: { readonly package?: unknown; readonly version?: unknown; readonly stylesheets?: unknown }): RequestResult;
export function requestTitle(request: LibraryRequest): string;
export function requestIssueUrl(request: LibraryRequest): string;
export function requestBranch(request: LibraryRequest): string;
export function requestIssuesUrl(request: LibraryRequest): string;
export function requestPullsUrl(request: LibraryRequest): string;
export function parseRequestIssue(body: unknown): RequestResult;
