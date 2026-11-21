import { describe, expect, it } from "vitest";
import { MAX_SOURCES, docSignature, nameProblem, parseDocSources, sourceProblems, suggestName, urlProblem, websiteDomain, websiteDomains, type DocSource } from "./sources";

const SITE: DocSource = { kind: "website", url: "https://todae.design/docs", label: "Todae docs" };
const SERVER: DocSource = { kind: "mcp", url: "https://mcp.todae.design/mcp", name: "todae-docs" };

describe("a doc source's address", () => {
  it("takes a whole https address on a public host", () => {
    expect(urlProblem("https://todae.design/docs/components/button", "website")).toBeNull();
    expect(urlProblem("  https://docs.example.com  ", "website")).toBeNull();
    expect(urlProblem("https://docs.example.com:443/mcp", "mcp")).toBeNull();
  });

  it("refuses what is not one, saying why in plain words", () => {
    expect(urlProblem("", "website")).toBe("Enter the address.");
    expect(urlProblem("todae.design", "website")).toBe("That is not a whole web address. It starts with https://.");
    expect(urlProblem("http://todae.design", "website")).toBe("Use an https:// address.");
    expect(urlProblem("ftp://todae.design", "mcp")).toBe("Use an https:// address.");
    expect(urlProblem("https://todae.design/a b", "website")).toBe("An address has no spaces.");
    expect(urlProblem("https://10.0.0.1/docs", "website")).toBe("Use the site's name, not an IP address.");
    expect(urlProblem("https://[::1]/mcp", "mcp")).toBe("Use the site's name, not an IP address.");
    expect(urlProblem("https://localhost/mcp", "mcp")).toMatch(/^Anthropic cannot reach an address on your own computer/);
    expect(urlProblem("https://intranet/docs", "website")).toBe("Use the site's full name, such as docs.example.com.");
    expect(urlProblem("https://docs.example.com:8443/", "website")).toBe("Use the standard https port.");
  });

  it("keeps a credential out of an address: a docs server's goes in its token", () => {
    expect(urlProblem("https://me:secret@docs.example.com/mcp", "mcp")).toBe("Leave the user name and password out of the address. Put a token in the token field instead.");
    expect(urlProblem("https://me@docs.example.com/", "website")).toBe("Leave the user name and password out of the address.");
  });

  it("limits a website's address to what web fetch can open", () => {
    const long = `https://docs.example.com/${"a".repeat(240)}`;
    expect(urlProblem(long, "website")).toMatch(/longer than 250 characters/);
    expect(urlProblem(long, "mcp")).toBeNull();
  });
});

describe("the domains a website lets the agent read", () => {
  it("is the address's host, lowercase, with no scheme or path", () => {
    expect(websiteDomain("https://Todae.Design/docs/button?x=1#top")).toBe("todae.design");
    expect(websiteDomain("https://www.example.com/")).toBe("www.example.com");
  });

  it("lists each website's host once, sorted, and no docs server's", () => {
    expect(websiteDomains([SITE, SERVER, { kind: "website", url: "https://todae.design/blog" }, { kind: "website", url: "https://brand.example.com" }])).toEqual(["brand.example.com", "todae.design"]);
    expect(websiteDomains([SERVER])).toEqual([]);
  });
});

describe("a docs server's name", () => {
  it("is a slug, suggested from its label or its address", () => {
    expect(nameProblem("todae-docs")).toBeNull();
    expect(nameProblem("")).toBe("Give the server a short name.");
    expect(nameProblem("Todae Docs")).toMatch(/^Use lowercase letters/);
    expect(suggestName("https://mcp.todae.design/mcp")).toBe("todae");
    expect(suggestName("Design docs!")).toBe("design-docs");
    expect(suggestName("***")).toBe("docs");
  });
});

describe("stored and imported sources", () => {
  it("reads a project from before doc sources as having none", () => {
    expect(parseDocSources(undefined)).toEqual({ ok: true, value: [] });
  });

  it("reads sources back trimmed, an empty label left out", () => {
    expect(parseDocSources([{ kind: "website", url: " https://todae.design/docs ", label: "Todae docs" }, SERVER])).toEqual({ ok: true, value: [SITE, SERVER] });
  });

  it("refuses a source with a token, or any field it does not know", () => {
    const parsed = parseDocSources([{ ...SERVER, authorization_token: "secret-token" }, { ...SITE, token: "x" }]);
    expect(parsed).toEqual({ ok: false, error: ['$[0]: has unknown fields "authorization_token"', '$[1]: has unknown fields "token"'] });
  });

  it("lists every problem with where it is: kinds, addresses, names, duplicates and the limit", () => {
    expect(parseDocSources("nope")).toEqual({ ok: false, error: ["$: expected a list of doc sources"] });
    expect(sourceProblems([{ kind: "feed", url: "https://a.example.com" }, { kind: "website", url: "http://a.example.com" }, SITE, SITE, SERVER, { ...SERVER, url: "https://other.example.com/mcp" }, { kind: "mcp", url: "https://b.example.com", name: "Bad Name" }, { kind: "website", url: "https://c.example.com", label: "" }])).toEqual([
      '$[0].kind: expected "website" or "mcp"',
      "$[1].url: Use an https:// address.",
      "$[3].url: this address is already a source",
      '$[5].name: another docs server is named "todae-docs"',
      "$[6].name: Use lowercase letters, numbers and single dashes, such as design-docs.",
      "$[7].label: expected text of 1 to 80 characters",
    ]);
    const many = Array.from({ length: MAX_SOURCES + 1 }, (_, index) => ({ kind: "website", url: `https://site${index}.example.com` }));
    expect(sourceProblems(many)).toEqual([`$: at most ${MAX_SOURCES} sources`]);
  });

  it("signs the sources the agent is told about, the same for the same sources", () => {
    expect(docSignature([SITE, SERVER])).toBe(docSignature([{ ...SITE, url: ` ${SITE.url} ` }, SERVER]));
    expect(docSignature([SITE])).not.toBe(docSignature([SITE, SERVER]));
    expect(docSignature([])).toBe("[]");
  });
});
