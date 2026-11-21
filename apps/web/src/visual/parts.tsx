import { createContext } from "react";

/**
 * What a figure may know beyond its finding's evidence: which scenarios
 * show each flow state, and how to go to a state's artboard. Without it a
 * figure draws from the evidence alone, as on a proposal's example. `plain`
 * asks a figure for names a designer reads in place of ids, where a figure
 * shows any: a flow map then names each step and its task in words.
 */
export type VisualContextValue = { readonly scenarios?: Readonly<Record<string, readonly string[]>> | undefined; readonly onOpenState?: ((state: string) => void) | undefined; readonly plain?: boolean | undefined };
export const VisualContext = createContext<VisualContextValue>({});
