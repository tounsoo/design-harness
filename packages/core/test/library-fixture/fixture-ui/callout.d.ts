import type { ReactNode } from "react";

/** A namespace export's members are parts: Callout.Root and Callout.Text. */
export declare function Root(props: { tone?: "info" | "critical"; children?: ReactNode }): ReactNode;
export declare function Text(props: { children?: ReactNode }): ReactNode;
/** Lowercase: not a part. */
export declare function useCallout(): string;
