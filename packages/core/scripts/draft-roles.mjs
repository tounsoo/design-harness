// Drafts a library's role mapping from its description, and confirms it.
//
//   node packages/core/scripts/draft-roles.mjs <description.json> [--json]
//   node packages/core/scripts/draft-roles.mjs <description.json> --confirm <confirmation.json>
//
// The first prints core's draft (draftRoles): each role's guess with its
// confidence and evidence, the roles it found no part for, and what each
// built-in rule that selects a missing role will do. It applies nothing.
//
// The second is the confirmation step: it reads a person's decisions (the
// roles they accept, and each correction with why; see RoleConfirmation in
// src/library/roles.ts), runs confirmRoles, and prints the `roles` a project
// config carries, or every reason it refuses and exits 1. The web app's
// wizard will call the same two core functions.
import { build } from "esbuild";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Core's role functions and built-in rules, bundled from source and loaded as a module: the same code the app calls. */
async function core() {
  const contents = 'export { confirmRoles, draftRoles, missingRoleEffects } from "./src/library/roles";\nexport { BUILT_IN_RULES } from "./src/builtins";\n';
  const result = await build({ stdin: { contents, resolveDir: join(here, ".."), loader: "ts" }, bundle: true, format: "esm", platform: "neutral", target: "es2022", write: false, logLevel: "silent" });
  const code = result.outputFiles[0]?.text ?? "";
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

const args = process.argv.slice(2);
const confirmAt = args.indexOf("--confirm");
const file = args.find((arg, index) => !arg.startsWith("--") && (confirmAt < 0 || index !== confirmAt + 1));
if (!file || (confirmAt >= 0 && !args[confirmAt + 1])) {
  process.stderr.write("usage: node packages/core/scripts/draft-roles.mjs <description.json> [--json | --confirm <confirmation.json>]\n");
  process.exit(2);
}
const description = JSON.parse(readFileSync(file, "utf8"));
const { draftRoles, confirmRoles, missingRoleEffects, BUILT_IN_RULES } = await core();

if (confirmAt >= 0) {
  const confirmation = JSON.parse(readFileSync(args[confirmAt + 1], "utf8"));
  const confirmed = confirmRoles(description, confirmation);
  if (!confirmed.ok) {
    for (const issue of confirmed.error) process.stderr.write(`${issue.path}: ${issue.message}\n`);
    process.exit(1);
  }
  for (const entry of confirmed.value.record) process.stderr.write(`${entry.role}: ${entry.decision}${entry.decision === "corrected" ? ` (${entry.why})` : ""}\n`);
  process.stdout.write(`${JSON.stringify(confirmed.value.roles, null, 2)}\n`);
} else {
  const draft = draftRoles(description);
  const effects = missingRoleEffects(BUILT_IN_RULES, draft.missing.map((item) => item.role));
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ ...draft, effects }, null, 2)}\n`);
  else {
    const lines = [`Draft roles for ${draft.package} ${draft.version}. Nothing is applied until it is confirmed.`, ""];
    for (const guess of draft.guesses) {
      lines.push(`${guess.role} (${guess.confidence}): ${JSON.stringify(guess.mapping)}`);
      for (const line of guess.evidence) lines.push(`  - ${line}`);
    }
    for (const item of draft.missing) {
      lines.push(`${item.role}: missing. ${item.why}`);
      for (const rule of effects.find((effect) => effect.role === item.role)?.rules ?? []) lines.push(`  - built-in rule ${rule.rule} ${rule.effect}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  }
}
