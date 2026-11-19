import type { LibraryDescription } from "../src/library/roles";

/** Types for describe-library.mjs, so the tests can import it. */
export declare const OVERRIDES: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
export declare function describeLibrary(pkgDir: string): LibraryDescription;
export declare function descriptionText(description: LibraryDescription): string;
export declare function installedDir(name: string, version: string, root?: string): string | null;
export declare function installLibrary(name: string, version: string, cache?: string): string;
export declare function onlyParts(description: LibraryDescription, exports: readonly string[]): LibraryDescription;
