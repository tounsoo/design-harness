/// <reference types="vite/client" />

declare module "virtual:frame-runtime" {
  /** The frame's boot script, a classic IIFE inlined into each frame's document. */
  export const boot: string;
  /** The page kit, `@design-harness/page`, as one ES module. */
  export const kit: string;
}

interface ImportMetaEnv {
  /** `local` (default) or `esm.sh`: where frames load React and the library from. */
  readonly VITE_PACKAGE_SOURCE?: string;
}
