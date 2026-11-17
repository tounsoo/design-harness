/**
 * The HTML of one frame, set as its `srcdoc`. The iframe is sandboxed with
 * `allow-scripts` only: no `allow-same-origin`, so the document has an
 * opaque origin and cannot read the app's storage, cookies, DOM or origin;
 * no forms, popups, modals or top navigation. The document's own CSP lets
 * it run only its boot script, which carries the document's nonce, the
 * import map the boot script adds with that nonce, blob modules it builds
 * from code the app sends, and modules and styles from the package source's
 * origins. With a nonce and no 'unsafe-inline' or 'unsafe-eval', nothing in
 * the frame can turn a string into code: no eval, no Function, no inline
 * event handler attribute, no javascript: URL. Fetch and XHR are forbidden
 * outright.
 */

/** The sandbox tokens every frame gets. Nothing else, and never `allow-same-origin`. */
export const FRAME_SANDBOX = "allow-scripts";

export type FrameDocumentOptions = {
  /** The random channel the frame and the app tag their messages with. */
  readonly channel: string;
  /** A random nonce, new for each document: the only inline scripts that run carry it. */
  readonly nonce: string;
  /** The app's origin, the only target the frame posts to. */
  readonly parentOrigin: string;
  /** The boot script's code, an IIFE. */
  readonly boot: string;
  readonly scheme: "light" | "dark";
  /** The library's colour scheme attribute, set on the root to the view's scheme. */
  readonly schemeAttribute?: string;
  /** Origins modules, stylesheets and fonts may load from, such as a CDN. */
  readonly origins: readonly string[];
};

const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The frame's Content Security Policy. */
export function frameCsp(origins: readonly string[], nonce: string): string {
  const from = origins.map((origin) => ` ${new URL(origin).origin}`).join("");
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' blob:${from}`,
    `style-src 'unsafe-inline'${from}`,
    `font-src data:${from}`,
    "img-src data: blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * Animations and transitions run in no time, so a page is measured in its
 * final state rather than part way through a fade.
 */
const FRAME_CSS = `html, body { margin: 0; }
*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; caret-color: transparent !important; }`;

export function frameDocument(options: FrameDocumentOptions): string {
  if (!/^[A-Za-z0-9+/=_-]{16,}$/.test(options.nonce)) throw new Error("a frame's nonce must be at least 16 base64 or hex characters");
  const scheme = options.schemeAttribute && /^[a-z][a-z0-9-]*$/.test(options.schemeAttribute) ? ` ${options.schemeAttribute}="${options.scheme}"` : "";
  // A script's text ends at the first `</script`; the boot code never needs one literally.
  const boot = options.boot.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html lang="en" data-channel="${escapeAttribute(options.channel)}" data-parent-origin="${escapeAttribute(options.parentOrigin)}"${scheme} style="color-scheme: ${options.scheme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(frameCsp(options.origins, options.nonce))}">
<meta name="color-scheme" content="${options.scheme}">
<style>${FRAME_CSS}</style>
</head>
<body><div id="root"></div><script nonce="${options.nonce}">${boot}</script></body>
</html>`;
}
