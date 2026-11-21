import { Badge, Button, Checkbox, Dialog, ErrorMessage, Field, Label, Stack, Text } from "@tounsoo/todae";
import { BookOpen, Globe, Pencil, Plus, Server, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { MAX_SOURCES, cleanSource, nameProblem, sourceProblems, sourceTitle, suggestName, urlProblem, websiteDomain, type DocSource } from "../docs/sources";
import { tokenProblem, type DocTokens } from "../docs/token-vault";
import { KEY_DB } from "../agent/key-vault";

/**
 * The project's docs: websites, such as the design system's docs site, and
 * docs servers (remote MCP servers) the agent reads when it designs,
 * proposes or answers. A person adds, edits and removes them, in the Project
 * view's section or in the dialog the chat opens, both drawing the same
 * `DocsManager` over the workspace's one list; the agent never does. They
 * are context for the agent, never a rule: no check reads them. A docs
 * server's token is kept as the API key is, in this tab's memory and, if the
 * person asks, on this device, and never with the project.
 */
export type DocsProps = {
  readonly sources: readonly DocSource[];
  readonly tokens: DocTokens;
  readonly onSave: (next: readonly DocSource[]) => Promise<void>;
};

/** Which source the form edits: a new one of a kind, or the one at an index. */
type Editing = { readonly kind: DocSource["kind"]; readonly index: number | null };

const DOCS_TITLE = "Docs the agent reads";
const DOCS_LEAD = "Add your design system's docs site, or a docs server, and the agent reads them when it designs, proposes or answers: a component's documented usage before it uses or proposes one. Docs are context, not rules: the checks still decide.";

/** The Project view's section. */
export function DocsSection({ projectId, ...docs }: DocsProps & { readonly projectId: string }) {
  return (
    <section aria-labelledby="project-docs" data-testid="project-docs" className="docs">
      <div className="section-head">
        <Text.Root as="h2" id="project-docs">
          {DOCS_TITLE}
        </Text.Root>
        <Text.Root as="p" tone="muted">
          {DOCS_LEAD}
        </Text.Root>
      </div>
      <DocsManager projectId={projectId} {...docs} />
    </section>
  );
}

/**
 * The same docs beside the chat, in a dialog: the list and its forms have
 * the room a narrow chat panel lacks, a phone included. The chat puts focus
 * back where it was when the dialog closes.
 */
export function DocsDialog({ projectId, onClose, ...docs }: DocsProps & { readonly projectId: string; readonly onClose: () => void }) {
  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()} className="docs-dialog" data-testid="chat-docs">
      <Dialog.Header>
        <Dialog.Title>{DOCS_TITLE}</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body className="docs-dialog-body">
        <Dialog.Description>{DOCS_LEAD}</Dialog.Description>
        <DocsManager projectId={projectId} {...docs} />
      </Dialog.Body>
      <Dialog.Footer>
        <Dialog.Close variant="primary">Done</Dialog.Close>
      </Dialog.Footer>
    </Dialog.Root>
  );
}

/** The list of sources, the form that adds or edits one, and how they are kept. */
function DocsManager({ projectId, sources, tokens, onSave }: DocsProps & { readonly projectId: string }) {
  useSyncExternalStore(tokens.subscribe, tokens.getVersion);
  const [editing, setEditingState] = useState<Editing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // A form takes focus when it opens (its address field). When it closes, focus goes back to what opened it:
  // the row's Edit button, or the Add button of its kind, or the first Add button when that row is gone.
  const root = useRef<HTMLDivElement>(null);
  const [back, setBack] = useState<Editing | null>(null);
  const setEditing = (next: Editing | null) => {
    if (next === null) setBack(editing);
    setEditingState(next);
  };
  useEffect(() => {
    if (!back) return;
    setBack(null);
    const within = root.current;
    if (!within || (within.contains(document.activeElement) && document.activeElement !== within)) return;
    const row = back.index === null ? null : within.querySelectorAll<HTMLElement>("[data-docs-edit]")[back.index];
    (row ?? within.querySelector<HTMLElement>(`[data-docs-add="${back.kind}"]:not(:disabled)`) ?? within.querySelector<HTMLElement>("[data-docs-add]:not(:disabled)"))?.focus();
  }, [back]);
  const full = sources.length >= MAX_SOURCES;

  const save = async (next: readonly DocSource[]) => {
    try {
      await onSave(next);
      setProblem(null);
      return true;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  const remove = async (index: number) => {
    const source = sources[index];
    if (!source) return;
    if (await save(sources.filter((_, at) => at !== index))) {
      if (source.kind === "mcp") await tokens.forget(projectId, source.name);
      setEditing(null);
      // The row and its buttons are gone: focus goes to adding one of its kind.
      setBack({ kind: source.kind, index: null });
    }
  };

  return (
    <div className="docs" ref={root}>
      {sources.length === 0 ? (
        <Text.Root as="p" tone="muted" className="docs-empty" data-testid="docs-empty">
          No docs yet. The agent works from the project&apos;s parts and rules alone.
        </Text.Root>
      ) : (
        <ul className="docs-list" aria-label="Docs">
          {sources.map((source, index) => (
            <li key={`${source.kind} ${source.url}`} className="docs-item" data-source-kind={source.kind} data-testid="doc-source">
              {editing?.index === index ? (
                <DocForm
                  projectId={projectId}
                  kind={source.kind}
                  initial={source}
                  others={sources.filter((_, at) => at !== index)}
                  tokens={tokens}
                  onCancel={() => setEditing(null)}
                  onSave={async (next) => {
                    const ok = await save(sources.map((item, at) => (at === index ? next : item)));
                    if (ok) setEditing(null);
                    return ok;
                  }}
                />
              ) : (
                <SourceRow projectId={projectId} source={source} tokens={tokens} onEdit={() => setEditing({ kind: source.kind, index })} onRemove={() => void remove(index)} />
              )}
            </li>
          ))}
        </ul>
      )}

      {editing?.index === null ? (
        <div className="docs-item docs-new" data-testid="doc-new">
          <DocForm
            projectId={projectId}
            kind={editing.kind}
            others={sources}
            tokens={tokens}
            onCancel={() => setEditing(null)}
            onSave={async (next) => {
              const ok = await save([...sources, next]);
              if (ok) setEditing(null);
              return ok;
            }}
          />
        </div>
      ) : (
        <Stack.Root direction="row" gap="condensed" wrap className="docs-add">
          <Button.Root type="button" variant="secondary" disabled={full} data-docs-add="website" onClick={() => setEditing({ kind: "website", index: null })}>
            <Button.Icon>
              <Plus />
            </Button.Icon>
            Add a docs site
          </Button.Root>
          <Button.Root type="button" variant="secondary" disabled={full} data-docs-add="mcp" onClick={() => setEditing({ kind: "mcp", index: null })}>
            <Button.Icon>
              <Plus />
            </Button.Icon>
            Add a docs server
          </Button.Root>
        </Stack.Root>
      )}
      {full && (
        <Text.Root as="p" tone="muted" className="chat-small">
          A project takes at most {MAX_SOURCES} docs. Remove one to add another.
        </Text.Root>
      )}
      {problem && (
        <ErrorMessage.Root role="alert" data-testid="docs-problem">
          {problem}
        </ErrorMessage.Root>
      )}

      <Text.Root as="p" tone="muted" className="chat-small docs-privacy" data-testid="docs-privacy">
        The agent opens pages only on these sites, and calls only these servers. Anthropic makes those requests for it, not this browser, and what comes back goes into the chat. A docs server&apos;s token is kept like your API key: in this tab&apos;s memory, and on this device only if you ask, never in the project, an export or the chat.
      </Text.Root>
    </div>
  );
}

function SourceRow({ projectId, source, tokens, onEdit, onRemove }: { readonly projectId: string; readonly source: DocSource; readonly tokens: DocTokens; readonly onEdit: () => void; readonly onRemove: () => void }) {
  const title = sourceTitle(source);
  const token = source.kind === "mcp" ? tokens.state(projectId, source.name) : null;
  return (
    <div className="docs-row">
      <span className="docs-icon" aria-hidden="true">
        {source.kind === "website" ? <Globe /> : <Server />}
      </span>
      <div className="docs-text">
        <Stack.Root direction="row" align="center" gap="condensed" wrap>
          <Text.Root as="span" weight="medium" className="docs-title">
            {title}
          </Text.Root>
          <Badge.Root tone="neutral">{source.kind === "website" ? "Docs site" : "Docs server"}</Badge.Root>
        </Stack.Root>
        {title !== source.url && (
          <Text.Root as="span" tone="muted" className="chat-small docs-url">
            {source.url}
          </Text.Root>
        )}
        <Text.Root as="p" tone="muted" className="chat-small" data-testid="doc-source-reach">
          {source.kind === "website"
            ? `The agent can read pages on ${websiteDomain(source.url)}.`
            : `The agent can call this server's tools, as "${source.name}". ${token?.present ? `Token ${token.hint}: ${token.remembered ? "remembered on this device." : "in this tab's memory only."}` : "No token."}`}
        </Text.Root>
      </div>
      <div className="docs-actions">
        <Button.Root type="button" variant="ghost" onClick={onEdit} aria-label={`Edit ${title}`} data-docs-edit="">
          <Button.Icon>
            <Pencil />
          </Button.Icon>
          Edit
        </Button.Root>
        <Button.Root type="button" variant="ghost" onClick={onRemove} aria-label={`Remove ${title}`}>
          <Button.Icon>
            <Trash2 />
          </Button.Icon>
          Remove
        </Button.Root>
      </div>
    </div>
  );
}

/** Adds or edits one source. Every field is checked before anything is saved; a problem is said next to its field. */
function DocForm({
  projectId,
  kind,
  initial,
  others,
  tokens,
  onSave,
  onCancel,
}: {
  readonly projectId: string;
  readonly kind: DocSource["kind"];
  readonly initial?: DocSource;
  readonly others: readonly DocSource[];
  readonly tokens: DocTokens;
  readonly onSave: (next: DocSource) => Promise<boolean>;
  readonly onCancel: () => void;
}) {
  const id = useId();
  const [url, setUrl] = useState(initial?.url ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const initialName = initial?.kind === "mcp" ? initial.name : "";
  const [name, setName] = useState(initialName);
  const [nameTouched, setNameTouched] = useState(initialName !== "");
  const kept = initial?.kind === "mcp" ? tokens.state(projectId, initial.name) : null;
  const [token, setToken] = useState("");
  const [remember, setRemember] = useState(kept?.remembered ?? false);
  const [forgetToken, setForgetToken] = useState(false);
  const [problems, setProblems] = useState<{ url?: string; name?: string; label?: string; token?: string }>({});
  const server = kind === "mcp";
  const address = useRef<HTMLInputElement>(null);
  useEffect(() => address.current?.focus(), []);
  const shownName = nameTouched ? name : url.trim() || label.trim() ? suggestName(label.trim() || url) : "";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: DocSource = cleanSource(server ? { kind: "mcp", url, name: shownName.trim(), ...(label.trim() ? { label } : {}) } : { kind: "website", url, ...(label.trim() ? { label } : {}) });
    const found: { url?: string; name?: string; label?: string; token?: string } = {};
    const urlWhy = urlProblem(url, kind);
    if (urlWhy) found.url = urlWhy;
    if (server) {
      const nameWhy = nameProblem(shownName.trim());
      if (nameWhy) found.name = nameWhy;
    }
    if (label.trim().length > 80) found.label = "A name shown to you is at most 80 characters.";
    if (server && token !== "") {
      const tokenWhy = tokenProblem(token);
      if (tokenWhy) found.token = tokenWhy;
    }
    if (!found.url && !found.name) {
      // The rest of the list decides duplicates: the same address twice, or two servers with one name.
      const list = sourceProblems([...others, next]);
      const last = `$[${others.length}]`;
      const clash = list.find((line) => line.startsWith(`${last}.url`) || line.startsWith(`${last}.name`));
      if (clash?.startsWith(`${last}.url`)) found.url = "This address is already one of the project's docs.";
      if (clash?.startsWith(`${last}.name`)) found.name = "Another docs server has this name.";
    }
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    if (!(await onSave(next))) return;
    if (next.kind !== "mcp") return;
    if (initial?.kind === "mcp" && initial.name !== next.name) await tokens.rename(projectId, initial.name, next.name);
    if (forgetToken) await tokens.forget(projectId, next.name);
    else if (token !== "") await tokens.set(projectId, next.name, token, remember);
    else if (kept?.present && remember !== kept.remembered) {
      const current = tokens.get(projectId, next.name);
      if (current) await tokens.set(projectId, next.name, current, remember);
    }
  };

  const field = (key: "url" | "name" | "label" | "token") => ({ id: `${id}-${key}`, invalid: problems[key] !== undefined, ...(problems[key] ? { "aria-describedby": `${id}-${key}-problem` } : {}) });
  const why = (key: "url" | "name" | "label" | "token") =>
    problems[key] ? (
      <ErrorMessage.Root id={`${id}-${key}-problem`} data-testid={`doc-${key}-problem`}>
        {problems[key]}
      </ErrorMessage.Root>
    ) : null;

  return (
    <form className="docs-form" onSubmit={(event) => void submit(event)} aria-label={initial ? `Edit ${sourceTitle(initial)}` : server ? "Add a docs server" : "Add a docs site"} noValidate>
      <Stack.Root direction="row" align="center" gap="condensed">
        <span className="docs-icon" aria-hidden="true">
          {server ? <Server /> : <BookOpen />}
        </span>
        <Text.Root as="h3" className="docs-form-title">
          {initial ? `Edit ${sourceTitle(initial)}` : server ? "Add a docs server" : "Add a docs site"}
        </Text.Root>
      </Stack.Root>
      <Text.Root as="p" tone="muted" className="chat-small">
        {server
          ? "A remote MCP server, such as a docs or knowledge connector. Anthropic connects to it over https for the agent, so it must be reachable on the internet, not only on your network."
          : "A website the agent may open pages on, such as your design system's docs. It can read this site's pages and its subdomains' pages, nothing else."}
      </Text.Root>
      <Stack.Root gap="condensed">
        <Label.Root htmlFor={`${id}-url`}>{server ? "Server address" : "Site address"}</Label.Root>
        <Field.Root {...field("url")}>
          <Field.TextInput ref={address} type="url" inputMode="url" value={url} onValueChange={setUrl} autoComplete="off" spellCheck={false} placeholder={server ? "https://docs.example.com/mcp" : "https://design.example.com/docs"} />
        </Field.Root>
        {why("url")}
      </Stack.Root>
      {server && (
        <Stack.Root gap="condensed">
          <Label.Root htmlFor={`${id}-name`}>Short name</Label.Root>
          <Field.Root {...field("name")}>
            <Field.TextInput
              value={shownName}
              onValueChange={(value) => {
                setNameTouched(true);
                setName(value);
              }}
              autoComplete="off"
              spellCheck={false}
              placeholder="design-docs"
            />
          </Field.Root>
          <Text.Root as="p" tone="muted" className="chat-small">
            How the agent knows this server: lowercase letters, numbers and dashes.
          </Text.Root>
          {why("name")}
        </Stack.Root>
      )}
      <Stack.Root gap="condensed">
        <Label.Root htmlFor={`${id}-label`}>Name shown to you (optional)</Label.Root>
        <Field.Root {...field("label")}>
          <Field.TextInput value={label} onValueChange={setLabel} autoComplete="off" placeholder={server ? "Design docs" : "Todae docs"} />
        </Field.Root>
        {why("label")}
      </Stack.Root>
      {server && (
        <Stack.Root gap="condensed">
          <Label.Root htmlFor={`${id}-token`}>Token (optional)</Label.Root>
          <Field.Root {...field("token")} disabled={forgetToken}>
            <Field.TextInput type="password" value={token} onValueChange={setToken} autoComplete="off" spellCheck={false} placeholder={kept?.present ? `Kept: ${kept.hint ?? ""}. Leave empty to keep it.` : "Only if the server asks for one"} />
          </Field.Root>
          {why("token")}
          {(token !== "" || kept?.present) && !forgetToken && (
            <Checkbox.Root checked={remember} onCheckedChange={setRemember}>
              Remember the token on this device
            </Checkbox.Root>
          )}
          {kept?.present && (
            <Checkbox.Root checked={forgetToken} onCheckedChange={setForgetToken}>
              Forget the kept token
            </Checkbox.Root>
          )}
          <Text.Root as="p" tone="muted" className="chat-small">
            Sent only to api.anthropic.com, which passes it to this server. Kept in this tab&apos;s memory, and if you remember it, also in this browser&apos;s IndexedDB database &quot;{KEY_DB}&quot; beside your API key. Never in the project, an export or the chat.
          </Text.Root>
        </Stack.Root>
      )}
      <Stack.Root direction="row" gap="condensed" wrap>
        <Button.Root type="submit" variant="primary">
          {initial ? "Save" : server ? "Add the server" : "Add the site"}
        </Button.Root>
        <Button.Root type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button.Root>
      </Stack.Root>
    </form>
  );
}
