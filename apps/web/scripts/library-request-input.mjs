/**
 * A request to add a component library to this deployment: what a designer
 * types in the New project wizard, the GitHub issue form it opens, and the
 * same fields read back out of that issue by the library request workflow.
 *
 * It is shared by the wizard, which runs it in the browser before it opens
 * the issue form, and by `library-request.mjs`, which runs it again on the
 * issue's text, which anyone can write: so it is pure, reads nothing, and
 * accepts only the narrow shapes the rest of the workflow relies on. A
 * package name, version or stylesheet path that passes here is safe as a
 * command-line argument (it never starts with `-`), as a git branch name,
 * as a path inside the repository, and as a JSON string.
 */

/** The repository whose issue form takes the request, and whose workflow answers it. */
export const REQUEST_REPOSITORY = "tounsoo/design-harness";
/** The issue form, `.github/ISSUE_TEMPLATE/library-request.yml`. */
export const REQUEST_TEMPLATE = "library-request.yml";
/** The label the issue form puts on every request, which the workflow runs on. */
export const REQUEST_LABEL = "library-request";
/** The form's fields: the query parameter that fills each (its `id`) and the heading GitHub writes it under in the issue (its `label`). */
export const REQUEST_FIELDS = {
  package: { id: "package", label: "Package" },
  version: { id: "version", label: "Exact version" },
  stylesheets: { id: "stylesheets", label: "Stylesheets" },
};

/** The longest input read: npm's own limit for a name, and room to spare for the rest. Anything longer is refused before it is matched. */
export const LIMITS = { package: 214, version: 64, stylesheets: 5, stylesheet: 200, field: 2000, body: 20000 };

// A package name npm accepts for a new package, narrowed: lowercase letters, digits, `-`, `.` and `_`, with an
// optional scope, neither starting with `.`, `_` or `-` (so it is never read as a flag), nor holding `..`, nor
// ending with `.` (so `library-request/<name>-<version>` is a valid branch name). npm also allows `~`, which a
// branch name cannot hold; this form does not.
const NAME_PART = "[a-z0-9][a-z0-9._-]*";
const NAME = new RegExp(`^(?:@${NAME_PART}/)?${NAME_PART}$`);
// An exact semantic version, no build metadata. A pre-release is lowercase, since the npm alias of a version,
// `<package>-<version>`, is a package name and must be.
const NUMBER = "(?:0|[1-9]\\d*)";
const PRE = `(?:${NUMBER}|\\d*[a-z-][0-9a-z-]*)`;
const EXACT = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-${PRE}(?:\\.${PRE})*)?$`);
// A stylesheet: a relative path inside the package to a .css file, each segment starting with a letter, digit,
// `_`, `@` or `-` (never `.`, so never `.` or `..`), no backslashes, no leading slash.
const SEGMENT = "[A-Za-z0-9_@-][A-Za-z0-9._@-]*";
const SHEET = new RegExp(`^(?:${SEGMENT}/)*${SEGMENT}\\.css$`);
const BLANK = "_No response_";

/** A value as it may be shown back to the person: one line, no backticks, at most 60 characters. */
export function shown(value) {
  // Control characters (below space, and DEL) and backticks become spaces.
  const text = [...String(value)].map((char) => (char < " " || char === "\u007f" || char === "`" ? " " : char)).join("").trim();
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function packageProblem(name) {
  if (name === "") return "Give the package's name on npm, such as @mantine/core.";
  if (name.length > LIMITS.package) return `A package name on npm is at most ${LIMITS.package} characters.`;
  if (/[A-Z]/.test(name) && NAME.test(name.toLowerCase())) return `npm package names are lowercase: "${shown(name.toLowerCase())}".`;
  if (/^https?:|^git[+:]|^file:|^npm:/.test(name)) return "Give the package's name on npm, not a URL or a path.";
  if (/@\d|@[\^~*<>=]|@latest|@next/.test(name.replace(/^@/, ""))) return "Give the name alone here, and the version in its own field.";
  if (!NAME.test(name) || name.includes("..") || /\.(?:\/|$)/.test(name) || name.endsWith(".lock") || name === "node_modules" || name === "favicon.ico") {
    return `"${shown(name)}" is not a package name this form takes: lowercase letters, digits, "-", "." and "_", with an optional @scope/ in front, such as @mantine/core.`;
  }
  return null;
}

function versionProblem(version) {
  if (version === "") return "Give the exact version, such as 9.7.4.";
  if (version.length > LIMITS.version) return "That is not a version: a version is a few numbers, such as 9.7.4.";
  if (EXACT.test(version)) return null;
  if (/^v\d/.test(version) && EXACT.test(version.slice(1))) return `Write the version without the "v": ${shown(version.slice(1))}.`;
  if (/^[\^~<>=*]|\|\||\s-\s|(?:^|\.)[xX*](?:\.|$)/.test(version) || /^\d+(?:\.\d+)?$/.test(version)) {
    return `"${shown(version)}" is a range, which can mean a different version tomorrow. Give one exact version, such as 9.7.4.`;
  }
  if (/^[a-z][a-z0-9-]*$/i.test(version)) return `"${shown(version)}" is a tag, which moves. Give the exact version it stands for today, such as 9.7.4.`;
  if (/\+/.test(version)) return "Give the version without build metadata (the part after +).";
  if (/[A-Z]/.test(version) && EXACT.test(version.toLowerCase())) return "This form takes pre-release versions in lowercase only, since the version becomes part of a package name.";
  return `"${shown(version)}" is not an exact version. Give one such as 9.7.4 or 2.0.0-beta.1.`;
}

/** The stylesheet paths in a field: one a line, or separated by commas. */
export function stylesheetList(text) {
  return text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function stylesheetProblems(list) {
  const problems = [];
  if (list.length > LIMITS.stylesheets) problems.push(`Name at most ${LIMITS.stylesheets} stylesheets.`);
  for (const path of list.slice(0, LIMITS.stylesheets)) {
    if (path.length > LIMITS.stylesheet) problems.push(`A stylesheet path is at most ${LIMITS.stylesheet} characters.`);
    else if (!path.endsWith(".css")) problems.push(`"${shown(path)}" is not a .css file. A frame loads a library's plain CSS file, such as dist/styles.css.`);
    else if (!SHEET.test(path)) problems.push(`"${shown(path)}" is not a path inside the package. Write it from the package's folder, such as dist/styles.css, with no "./", "..", leading "/" or "\\".`);
  }
  if (new Set(list).size !== list.length) problems.push("A stylesheet is named twice.");
  return problems;
}

/**
 * The request a person typed, checked. `fields` are the raw texts of the
 * three fields. Returns `{ ok: true, value }`, with the stylesheets as a
 * list, or `{ ok: false, errors }`, each error naming its field.
 *
 * @param {{ package?: unknown, version?: unknown, stylesheets?: unknown }} fields
 */
export function validateLibraryRequest(fields) {
  const text = (value) => (typeof value === "string" ? value : "");
  const errors = [];
  const raw = { package: text(fields.package), version: text(fields.version), stylesheets: text(fields.stylesheets) };
  for (const key of ["package", "version", "stylesheets"]) {
    if (raw[key].length > LIMITS.field) errors.push({ field: key, message: "That is far longer than this field ever needs." });
  }
  if (errors.length > 0) return { ok: false, errors };
  const name = raw.package.trim();
  const version = raw.version.trim();
  const stylesheets = stylesheetList(raw.stylesheets);
  const nameProblem = packageProblem(name);
  if (nameProblem) errors.push({ field: "package", message: nameProblem });
  const versionIssue = versionProblem(version);
  if (versionIssue) errors.push({ field: "version", message: versionIssue });
  for (const message of stylesheetProblems(stylesheets)) errors.push({ field: "stylesheets", message });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { package: name, version, stylesheets } };
}

/** The issue's title, which the issue search finds it by. */
export function requestTitle(request) {
  return `Library request: ${request.package} ${request.version}`;
}

/** The issue form on GitHub, filled in with the request. Nothing is filed until the person submits it there. */
export function requestIssueUrl(request) {
  const query = new globalThis.URLSearchParams({
    template: REQUEST_TEMPLATE,
    title: requestTitle(request),
    [REQUEST_FIELDS.package.id]: request.package,
    [REQUEST_FIELDS.version.id]: request.version,
    [REQUEST_FIELDS.stylesheets.id]: request.stylesheets.join("\n"),
  });
  return `https://github.com/${REQUEST_REPOSITORY}/issues/new?${query.toString()}`;
}

/** The branch the workflow pushes a request to. */
export function requestBranch(request) {
  return `library-request/${request.package}-${request.version}`;
}

/** Issues labelled as requests whose title names this package and version: where the request's issue is, once filed. */
export function requestIssuesUrl(request) {
  return `https://github.com/${REQUEST_REPOSITORY}/issues?q=${encodeURIComponent(`is:issue label:${REQUEST_LABEL} in:title "${request.package} ${request.version}"`)}`;
}

/** Pull requests from the request's branch: where the workflow's pull request is, once opened. */
export function requestPullsUrl(request) {
  return `https://github.com/${REQUEST_REPOSITORY}/pulls?q=${encodeURIComponent(`is:pr head:${requestBranch(request)}`)}`;
}

/**
 * The three fields out of the body GitHub writes for an issue made from the
 * form: each field's label as a `### ` heading, its answer below, and
 * `_No response_` for one left empty. A body that is too long, lacks a
 * field or holds one twice is refused; headings the form does not have are
 * ignored. The fields are then checked as the wizard checks them.
 *
 * @param {unknown} body
 */
export function parseRequestIssue(body) {
  if (typeof body !== "string" || body.trim() === "") return { ok: false, errors: [{ field: "issue", message: "The issue has no text. Open a request from the form, which fills in each field." }] };
  if (body.length > LIMITS.body) return { ok: false, errors: [{ field: "issue", message: `The issue's text is over ${LIMITS.body} characters, far longer than a request needs.` }] };
  const sections = new Map();
  let current = null;
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      sections.set(current, [...(sections.get(current) ?? []), []]);
    } else if (current !== null) sections.get(current).at(-1).push(line);
  }
  const errors = [];
  const fields = {};
  for (const [key, { label }] of Object.entries(REQUEST_FIELDS)) {
    const found = sections.get(label) ?? [];
    if (found.length === 0) errors.push({ field: key, message: `The issue has no "${label}" field. Open a request from the library request form, which writes each field under its own heading.` });
    else if (found.length > 1) errors.push({ field: key, message: `The issue has the "${label}" field ${found.length} times. Keep one.` });
    else {
      let value = found[0].join("\n").trim();
      const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(value);
      if (fenced) value = fenced[1].trim();
      fields[key] = value === BLANK ? "" : value;
    }
  }
  return errors.length > 0 ? { ok: false, errors } : validateLibraryRequest(fields);
}
