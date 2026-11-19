import { createContext } from "react";

/**
 * What a figure may know beyond its finding's evidence: which scenarios
 * show each flow state, and how to go to a state's artboard. Without it a
 * figure draws from the evidence alone, as on a proposal's example.
 */
export type VisualContextValue = { readonly scenarios?: Readonly<Record<string, readonly string[]>> | undefined; readonly onOpenState?: ((state: string) => void) | undefined };
export const VisualContext = createContext<VisualContextValue>({});
