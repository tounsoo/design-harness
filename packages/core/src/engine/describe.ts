import type { RoleName, Selector } from "../rules/types";
import { textOf, type ConfigContext } from "./context";

const ROLE_WORDS: Record<RoleName, [string, string]> = {
  action: ["action", "actions"],
  "primary-action": ["primary action", "primary actions"],
  "secondary-action": ["secondary action", "secondary actions"],
  disclosure: ["disclosure", "disclosures"],
  "disclosure-summary": ["disclosure summary", "disclosure summaries"],
  question: ["question", "questions"],
};

type Options = { readonly plural?: boolean; readonly each?: string };

/** "a" or "an" for a phrase, by its first letter; names like `<button>` and `Button.Root` take "a". */
export function article(phrase: string): string {
  return /^[aeiou]/.test(phrase) ? `an ${phrase}` : `a ${phrase}`;
}

/** The noun a selector names, or null when it only qualifies (text, props, placement). */
function noun(selector: Selector, ctx: ConfigContext, options: Options): string | null {
  const plural = options.plural ?? false;
  let out: string | null = selector.role ? ROLE_WORDS[selector.role][plural ? 1 : 0] : null;
  if (selector.component !== undefined) {
    const names = (typeof selector.component === "string" ? [selector.component] : selector.component).map((name) => (/^[a-z]/.test(name) ? `<${name}>` : name));
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : (names[0] ?? "");
    out = out ? `${out} (${list})` : list;
  }
  if (selector.page) out = out ? `${out} that is a page` : plural ? "pages" : "page";
  if (selector.layout !== undefined) {
    const which = selector.layout === true ? (plural ? "layouts" : "layout") : `layout "${selector.layout}"`;
    out = out ? `${out} that is a ${which}` : which;
  }
  if (selector.anyOf) {
    const options_ = selector.anyOf.map((option) => describe(option, ctx, options));
    out = out ? `${out} that is ${options_.join(" or ")}` : options_.join(" or ");
  }
  return out;
}

/** What a selector requires besides its noun: `reading "Book room"`, `outside every disclosure`. */
function qualifiers(selector: Selector, ctx: ConfigContext, options: Options): string[] {
  const parts: string[] = [];
  if (selector.props) {
    for (const [name, value] of Object.entries(selector.props).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) parts.push(`with ${name}=${JSON.stringify(value)}`);
  }
  if (selector.hasProp) parts.push(`with a ${selector.hasProp} prop`);
  if (selector.text !== undefined) {
    const text = textOf(selector.text, ctx, options.each);
    parts.push(typeof selector.text === "object" && "rank" in selector.text ? `reading the rank-${selector.text.rank} action "${text}"` : `reading "${text}"`);
  }
  if (selector.inside) parts.push(`inside ${article(describe(selector.inside, ctx))}`);
  if (selector.notInside) parts.push(`outside every ${describe(selector.notInside, ctx)}`);
  if (selector.not) {
    const negated = noun(selector.not, ctx, {});
    parts.push(negated ? `that is not ${article(describe(selector.not, ctx))}` : `not ${qualifiers(selector.not, ctx, options).join(" ")}`);
  }
  return parts;
}

/** A selector in words, for messages: `primary action reading "Book room"`, `<button> or <a>`. */
export function describe(selector: Selector, ctx: ConfigContext, options: Options = {}): string {
  return [noun(selector, ctx, options) ?? (options.plural ? "elements" : "element"), ...qualifiers(selector, ctx, options)].join(" ");
}
