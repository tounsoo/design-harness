import { describe, expect, it } from "vitest";
import { nook } from "../../../../packages/core/examples/nook/project";
import { esmShPackageSource, localPackageSource, resolvePackages } from "./package-source";

const manifest = {
  packages: {
    react: { version: "19.3.1", modules: { react: "react.js", "react/jsx-runtime": "react-jsx-runtime.js" }, files: {} },
    "react-dom": { version: "19.3.1", modules: { "react-dom": "react-dom.js", "react-dom/client": "react-dom-client.js" }, files: {} },
    "@tounsoo/todae": { version: "0.11.3", modules: { "@tounsoo/todae": "library.js" }, files: { "dist/todae.css": "todae.css" } },
  },
};

function fakeFetch() {
  const asked: string[] = [];
  const fetchText = (url: string) => {
    asked.push(url);
    const file = url.replace("https://app.example/vendor/", "");
    const text = file === "manifest.json" ? JSON.stringify(manifest) : file === "missing.js" ? null : `/* ${file} */`;
    return Promise.resolve({ ok: text !== null, status: text === null ? 404 : 200, text: () => Promise.resolve(text ?? "") });
  };
  return { asked, fetchText };
}

describe("the local package source", () => {
  it("serves every module and stylesheet a frame needs as code, reading each file once", async () => {
    const { asked, fetchText } = fakeFetch();
    const source = localPackageSource("https://app.example/vendor", fetchText);
    const packages = await resolvePackages(nook.library, source);
    expect(Object.keys(packages.modules)).toEqual(["react", "react/jsx-runtime", "react-dom", "react-dom/client", "@tounsoo/todae"]);
    expect(packages.modules["@tounsoo/todae"]).toEqual({ code: "/* library.js */" });
    expect(packages.styles).toEqual([{ css: "/* todae.css */" }]);
    await resolvePackages(nook.library, source);
    expect(asked.filter((url) => url.endsWith("manifest.json"))).toHaveLength(1);
    expect(source.origins).toEqual([]);
  });

  it("refuses a version it does not have, naming both", async () => {
    const source = localPackageSource("https://app.example/vendor/", fakeFetch().fetchText);
    await expect(resolvePackages({ ...nook.library, version: "0.10.1" }, source)).rejects.toThrow("the local package source has @tounsoo/todae 0.11.3, but the project asks for 0.10.1");
    await expect(resolvePackages({ ...nook.library, react: "18.3.1" }, source)).rejects.toThrow("has react 19.3.1, but the project asks for 18.3.1");
    await expect(resolvePackages({ ...nook.library, package: "@acme/ui" }, source)).rejects.toThrow("has no @acme/ui");
    await expect(source.module("@tounsoo/todae/stack", { package: "@tounsoo/todae", version: "0.11.3" })).rejects.toThrow("serves only @tounsoo/todae of @tounsoo/todae");
  });
});

describe("the esm.sh package source", () => {
  it("points every module at esm.sh by exact version, with React kept external", async () => {
    const source = esmShPackageSource();
    const packages = await resolvePackages(nook.library, source);
    expect(packages.modules).toEqual({
      react: { url: "https://esm.sh/react@19.3.1" },
      "react/jsx-runtime": { url: "https://esm.sh/react@19.3.1/jsx-runtime" },
      "react-dom": { url: "https://esm.sh/react-dom@19.3.1?external=react,react-dom" },
      "react-dom/client": { url: "https://esm.sh/react-dom@19.3.1/client?external=react,react-dom" },
      "@tounsoo/todae": { url: "https://esm.sh/@tounsoo/todae@0.11.3?external=react,react-dom" },
    });
    expect(packages.styles).toEqual([{ url: "https://esm.sh/@tounsoo/todae@0.11.3/dist/todae.css" }]);
    expect(source.origins).toEqual(["https://esm.sh"]);
  });
});

describe("the json-render renderer spec frames load", () => {
  it("is the exact version the app pins and installs", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { JSON_RENDER } = await import("./package-source");
    const app = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const installed = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "node_modules", "@json-render", "react", "package.json"), "utf8")) as { version: string };
    expect(app.dependencies["@json-render/react"]).toBe(JSON_RENDER.version);
    expect(installed.version).toBe(JSON_RENDER.version);
  });
});
