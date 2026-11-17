import type { Finding } from "../report";

/** What one rule produced: its findings, or why it did not run. */
export type Outcome = { readonly findings: readonly Finding[] } | { readonly notRun: string };
