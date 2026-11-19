/// <reference types="vite/client" />

declare module "virtual:frame-runtime" {
  /** The frame's boot script, a classic IIFE inlined into each frame's document. */
  export const boot: string;
  /** The page kit, `@design-harness/page`, as one ES module. */
  export const kit: string;
  /** The spec renderer, `@design-harness/spec`, as one ES module. */
  export const spec: string;
}

interface ImportMetaEnv {
  /** `local` (default) or `esm.sh`: where frames load React and the library from. */
  readonly VITE_PACKAGE_SOURCE?: string;
  /** `off` stops a person from loading one project's library version from esm.sh when the page's source does not serve it. */
  readonly VITE_ESM_FALLBACK?: string;
}
