import { version as REACT_VERSION } from "react";
import type { LibraryDescription, LibrarySetup } from "@design-harness/core";

/**
 * The component libraries this deployment ships: each is described
 * (`packages/core/libraries/<name>.json`, written by core's
 * `describe-library.mjs`) and vendored (`designHarness.libraries` in
 * package.json, built into `public/vendor/` by `npm run vendor`), so the
 * app can draft its roles and render it in frames with no backend.
 *
 * The app is a static site, so this list is fixed at build time. Adding a
 * library is a change to the repository, in four steps, which the wizard
 * spells out for the person:
 *
 * 1. add the package at an exact version to this app's dependencies;
 * 2. describe it: `node packages/core/scripts/describe-library.mjs <package> <version> --out packages/core/libraries/<name>.json`;
 * 3. list it and its stylesheets under `designHarness.libraries` in package.json, so the vendor build serves it;
 * 4. add an entry here.
 *
 * A designer asks for one from the wizard, and the library request
 * workflow (`.github/workflows/library-request.yml`, its logic in
 * `scripts/library-request.mjs`) does these four steps and opens a pull
 * request. It appends its entry to the end of this list, so the list stays
 * one array literal closed by `];` on a line of its own, each entry's
 * `package` line right above its `version` line.
 *
 * `registry.test.ts` holds each entry to the description file, to
 * package.json and to the version installed.
 */
export type ShippedLibrary = {
  readonly id: string;
  /** The name a person knows it by. */
  readonly name: string;
  readonly package: string;
  readonly version: string;
  /** One line on what it is. */
  readonly about: string;
  /** How a project loads it, and what its starter needs to follow the rules. */
  readonly setup: LibrarySetup;
  /** Anything about the setup a person should know, in a sentence each. */
  readonly notes: readonly string[];
  /** Its description, loaded when a person picks it: Mantine's is 3 MB. */
  readonly describe: () => Promise<LibraryDescription>;
};

/** The React this app renders frames with: the one version the local package source serves. */
export const FRAME_REACT = REACT_VERSION;

export const SHIPPED_LIBRARIES: readonly ShippedLibrary[] = [
  {
    id: "todae",
    name: "Todae",
    package: "@tounsoo/todae",
    version: "0.11.3",
    about: "The design system this app is built with. Parts are namespaced, such as Button.Root.",
    setup: {
      react: FRAME_REACT,
      stylesheets: ["dist/todae.css"],
      schemeAttribute: "data-appearance",
      rules: [
        {
          type: "prop-values",
          id: "text-as-heading-or-paragraph",
          select: { component: "Text.Root" },
          prop: "as",
          allowed: ["h1", "h2", "h3", "p", "span"],
          required: true,
          description: "Text.Root says what it is: a heading level, a paragraph or a span.",
        },
      ],
    },
    notes: ["Light and dark come from the data-appearance attribute on the page.", "One rule of its own: a Text.Root says whether it is a heading, a paragraph or a span."],
    describe: async () => (await import("../../../../packages/core/libraries/todae-0.11.3.json")).default as unknown as LibraryDescription,
  },
  {
    id: "mantine",
    name: "Mantine",
    package: "@mantine/core",
    version: "9.7.4",
    about: "A large React component library. Parts are plain components, such as Button.",
    setup: {
      react: FRAME_REACT,
      stylesheets: ["styles.css"],
      root: { component: "MantineProvider", schemeProp: "forceColorScheme" },
      rules: [
        {
          type: "prop-values",
          id: "title-order",
          select: { component: "Title" },
          prop: "order",
          allowed: [1, 2, 3],
          required: true,
          description: "A Title says its heading level, 1 to 3: Mantine draws a Title with no order as an h1.",
        },
      ],
      // Mantine's default blue under white text is 3.5:1, under WCAG AA; violet passes in light and dark.
      partProps: { Button: { color: "violet" } },
    },
    notes: [
      "Every page renders inside MantineProvider, which takes the view's light or dark scheme.",
      "One rule of its own: a Title says its heading level.",
      "The starter page's buttons are violet: Mantine's default blue under white text does not meet AA contrast, which the project's rules check.",
    ],
    describe: async () => (await import("../../../../packages/core/libraries/mantine-core-9.7.4.json")).default as unknown as LibraryDescription,
  },
  {
    // Added by the library request workflow from issue #32. A person must check:
    //   - The primary-action role was drafted at medium confidence: check it in New project.
    //   - Its `setup` (light and dark, root part, rules, part props) and `notes` are copied from the 0.11.3 entry: check they still hold for 0.11.2.
    //   - `about` is the workflow's words: say what the library is.
    id: "tounsoo-todae-0-11-2",
    name: "@tounsoo/todae",
    package: "@tounsoo/todae",
    version: "0.11.2",
    about: "Requested in issue #32. Parts are namespaced, such as Button.Root.",
    setup: {
      react: FRAME_REACT,
      stylesheets: ["dist/todae.css"],
      schemeAttribute: "data-appearance",
      rules: [
        {
          type: "prop-values",
          id: "text-as-heading-or-paragraph",
          select: { component: "Text.Root" },
          prop: "as",
          allowed: ["h1", "h2", "h3", "p", "span"],
          required: true,
          description: "Text.Root says what it is: a heading level, a paragraph or a span.",
        },
      ],
    },
    notes: ["Light and dark come from the data-appearance attribute on the page.", "One rule of its own: a Text.Root says whether it is a heading, a paragraph or a span."],
    describe: async () => (await import("../../../../packages/core/libraries/tounsoo-todae-0.11.2.json")).default as unknown as LibraryDescription,
  },
];
