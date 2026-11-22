// The headers every response of the app carries, in production (scripts/vercel-output.mjs)
// and in the end-to-end tests' preview server (apps/web/e2e/run.mjs), so the tests run under them.
//
// The Content-Security-Policy limits where the page that holds the API key and the docs
// servers' tokens can send anything: to its own origin and to api.anthropic.com alone.
// It sets no script-src, style-src or font-src on purpose. A frame's document is a srcdoc,
// which inherits this policy on top of its own, and the frame's own policy already allows
// only its nonce, blob: and its package source's origin (src/runtime/frame-document.ts).
export const APP_CSP = [
  "connect-src 'self' https://api.anthropic.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const APP_HEADERS = {
  "Content-Security-Policy": APP_CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};
