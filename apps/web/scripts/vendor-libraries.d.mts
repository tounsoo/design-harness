/** Types for vendor-libraries.mjs, which the vendor build runs with plain Node. */
export type VendoredLibrary = { readonly package: string; readonly version: string; readonly install: string; readonly stylesheets: readonly string[] };
export function aliasOf(name: string, version: string): string;
export function vendoredLibraries(packageJson: { readonly dependencies?: Readonly<Record<string, string>>; readonly designHarness?: { readonly libraries?: unknown } }): VendoredLibrary[];
export function satisfies(version: string, range: string): boolean;
export type VendorManifest = { packages: Record<string, { versions: Record<string, { modules: Record<string, string>; files: Record<string, string> }> }> };
export function vendorFileName(name: string, version: string, suffix: string): string;
export function fileInManifest(manifest: VendorManifest, entry: { readonly package: string; readonly version: string; readonly kind: "modules" | "files"; readonly key: string; readonly file: string }): VendorManifest;
export function unservedDescriptions(manifest: VendorManifest, descriptions: readonly { readonly package: string; readonly version: string }[]): string[];
