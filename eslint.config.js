import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/** Names library code must never reach: they tie it to one runtime or make a check depend on when or where it runs. */
const environmentGlobals = ["window", "document", "navigator", "location", "localStorage", "sessionStorage", "fetch", "XMLHttpRequest", "process", "require", "Buffer", "__dirname", "__filename", "setTimeout", "setInterval", "performance", "crypto", "Date", "Intl"].map((name) => ({
  name,
  message: "Library code is pure and environment-neutral: no clock, randomness, network, file system or runtime globals. Take the value as an argument instead.",
}));

export default tseslint.config(
  { ignores: ["**/dist/**", "node_modules/**", "coverage/**", "packages/*/examples/**/prototypes/**", "apps/web/public/vendor/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/scripts/**/*.mjs", "apps/web/e2e/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly", setTimeout: "readonly", clearTimeout: "readonly", URL: "readonly", Headers: "readonly", Response: "readonly", ReadableStream: "readonly", TextEncoder: "readonly" } },
  },
  {
    // End-to-end tests also pass functions to the browser, which run with its globals.
    files: ["apps/web/e2e/**/*.mjs"],
    languageOptions: { globals: { window: "readonly", self: "readonly", document: "readonly", localStorage: "readonly", sessionStorage: "readonly", indexedDB: "readonly", fetch: "readonly" } },
  },
  {
    files: ["packages/core/src/**/*.ts"],
    ignores: ["packages/core/src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["node:*", "fs", "path", "os", "url", "child_process", "crypto", "util"], message: "Library code runs in a browser too: no Node built-ins." }] }],
      "no-restricted-globals": ["error", ...environmentGlobals],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Checks are deterministic: no randomness." },
        { property: "localeCompare", message: "localeCompare depends on the runtime's locale; compare code units for a stable order." },
      ],
    },
  },
);
