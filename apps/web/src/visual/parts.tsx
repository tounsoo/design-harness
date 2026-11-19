import { createContext } from "react";
import type { CountBar as CountBarModel } from "./geometry";

/**
 * What a figure may know beyond its finding's evidence: which scenarios
 * show each flow state, and how to go to a state's artboard. Without it a
 * figure draws from the evidence alone, as on a proposal's example.
 */
export type VisualContextValue = { readonly scenarios?: Readonly<Record<string, readonly string[]>> | undefined; readonly onOpenState?: ((state: string) => void) | undefined };
export const VisualContext = createContext<VisualContextValue>({});

/** Pips with a limit line: the picture of a count against its cap. */
export function Bar({ bar, limit = true, unit }: { readonly bar: CountBarModel; readonly limit?: boolean; readonly unit?: string }) {
  const before = bar.pips.slice(0, bar.limitAfter);
  const after = bar.pips.slice(bar.limitAfter);
  const pip = (kind: (typeof bar.pips)[number], index: number) => <i key={index} className="pip" data-pip={kind} />;
  return (
    <div className="count-bar" data-testid="figure-count">
      <span className="pips" role="img" aria-label={`${bar.words}${unit ? ` ${unit}` : ""}`}>
        {before.map(pip)}
        {limit && <i className="pip-limit" data-testid="figure-limit" />}
        {after.map((kind, index) => pip(kind, before.length + index))}
        {bar.more > 0 && <span className="pips-more">+{bar.more}</span>}
      </span>
      <span className="count-words" aria-hidden="true" data-testid="figure-count-words">
        {bar.words}
        {unit ? ` ${unit}` : ""}
      </span>
    </div>
  );
}
