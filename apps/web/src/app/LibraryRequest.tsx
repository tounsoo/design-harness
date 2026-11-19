import { Badge, Button, Card, Code, ErrorMessage, Field, Label, Link, Stack, Text } from "@tounsoo/todae";
import { ExternalLink, X } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";
import { requestIssueUrl, requestIssuesUrl, requestPullsUrl, validateLibraryRequest, type LibraryRequest, type RequestError, type RequestField } from "../../scripts/library-request-input.mjs";
import { readPending, withPending, withoutPending, writePending, type PendingRequest } from "../libraries/requests";

type Props = {
  /** Whether the deployment already lists this package at this version. */
  readonly listed: (request: LibraryRequest) => boolean;
};

const FIELDS: readonly { readonly field: RequestField; readonly label: string; readonly hint: string; readonly placeholder: string }[] = [
  { field: "package", label: "Package", hint: "Its name on npm.", placeholder: "@acme/ui" },
  { field: "version", label: "Exact version", hint: "One version, such as 2.4.1: not a range or a tag such as latest.", placeholder: "2.4.1" },
  { field: "stylesheets", label: "CSS files", hint: "Its stylesheets, as paths inside the package, one a line. Empty for a library that needs none.", placeholder: "dist/styles.css" },
];

const when = (at: string) => {
  try {
    return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return at;
  }
};

/**
 * Ask for a library the deployment does not ship: the person types its
 * package, exact version and stylesheets; the request is checked here as
 * the workflow will check it, and GitHub's issue form opens in a new tab,
 * filled in, for the person to submit. The app holds no token, so it
 * cannot file the issue or follow it: each request this browser sent is
 * shown as pending, with where its issue and pull request will be, until
 * the deployment lists the library.
 *
 * It sits inside the library step's form, so it is not a form of its own:
 * Enter in one of its fields sends the request rather than the step.
 */
export function LibraryRequestForm({ listed }: Props) {
  const id = useId();
  const [fields, setFields] = useState<Record<RequestField, string>>({ package: "", version: "", stylesheets: "" });
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState<PendingRequest[]>(() => readPending(listed));
  const checked = validateLibraryRequest(fields);
  const alreadyListed = checked.ok && listed(checked.value);
  const errors: readonly RequestError[] = !tried ? [] : !checked.ok ? checked.errors : alreadyListed ? [{ field: "version", message: `${checked.value.package} ${checked.value.version} is already in the list above: pick it there.` }] : [];
  const errorsOf = (field: RequestField) => errors.filter((error) => error.field === field);

  const send = () => {
    setTried(true);
    if (!checked.ok || alreadyListed) return;
    globalThis.open?.(requestIssueUrl(checked.value), "_blank", "noopener,noreferrer");
    const next = withPending(pending, checked.value, new Date().toISOString());
    setPending(next);
    writePending(next);
    setTried(false);
    setFields({ package: "", version: "", stylesheets: "" });
  };
  const forget = (request: PendingRequest) => {
    const next = withoutPending(pending, request);
    setPending(next);
    writePending(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      send();
    }
  };

  return (
    <Stack.Root gap="normal" className="library-request" data-testid="library-request">
      <Text.Root as="p">
        Ask for it to be added. GitHub opens a request in a new tab, filled in from these fields, for you to submit. A workflow then checks the package on npm, describes it, adds it, runs every check, and opens a pull request for a person to review. If something stops it, it says why on the request. Once the pull request is merged and deployed, the library is in the list above.
      </Text.Root>
      <div className="library-request-fields" onKeyDown={onKeyDown}>
        {FIELDS.map(({ field, label, hint, placeholder }) => {
          const mine = errorsOf(field);
          const hintId = `${id}-${field}-hint`;
          const errorId = `${id}-${field}-error`;
          const describedBy = mine.length > 0 ? `${hintId} ${errorId}` : hintId;
          return (
            <Field.Group key={field}>
              <Label.Root htmlFor={`${id}-${field}`}>{label}</Label.Root>
              <Field.Root id={`${id}-${field}`} invalid={mine.length > 0} aria-describedby={describedBy}>
                {field === "stylesheets" ? (
                  <Field.Textarea value={fields[field]} onValueChange={(value) => setFields((current) => ({ ...current, [field]: value }))} rows={2} placeholder={placeholder} spellCheck={false} autoCapitalize="off" autoComplete="off" />
                ) : (
                  <Field.TextInput value={fields[field]} onValueChange={(value) => setFields((current) => ({ ...current, [field]: value }))} placeholder={placeholder} spellCheck={false} autoCapitalize="off" autoComplete="off" />
                )}
              </Field.Root>
              <Text.Root as="span" tone="muted" id={hintId} className="library-request-hint">
                {hint}
              </Text.Root>
              {mine.length > 0 && (
                <ErrorMessage.Root id={errorId} data-testid={`request-error-${field}`}>
                  {mine.map((error) => error.message).join(" ")}
                </ErrorMessage.Root>
              )}
            </Field.Group>
          );
        })}
      </div>
      <div>
        <Button.Root type="button" variant="secondary" onClick={send} data-testid="request-library">
          Request on GitHub
          <Button.Icon>
            <ExternalLink />
          </Button.Icon>
        </Button.Root>
      </div>
      {pending.length > 0 && (
        <Stack.Root gap="condensed" data-testid="pending-requests">
          <Text.Root as="h3" className="library-request-title">
            Requested from this browser
          </Text.Root>
          {pending.map((request) => (
            <Card.Root key={`${request.package}@${request.version}`} className="pending-request" data-testid="pending-request" data-package={request.package} data-version={request.version}>
              <Card.Body>
                <Stack.Root gap="condensed">
                  <Stack.Root direction="row" align="center" gap="condensed" className="pending-request-head">
                    <Badge.Root tone="warning">Pending</Badge.Root>
                    <Text.Root as="span" weight="medium">
                      <Code.Root>{request.package}</Code.Root> {request.version}
                    </Text.Root>
                    <Text.Root as="span" tone="muted">
                      asked {when(request.at)}
                    </Text.Root>
                    <Button.Root type="button" variant="ghost" onClick={() => forget(request)} aria-label={`Forget the request for ${request.package} ${request.version}`} className="pending-request-forget">
                      <Button.Icon>
                        <X />
                      </Button.Icon>
                    </Button.Root>
                  </Stack.Root>
                  <Text.Root as="p" tone="muted">
                    This app cannot see how it went. Its issue says if the workflow stopped and why; its pull request is where the library is added. Once that is merged and deployed, it is listed above and this goes away.
                  </Text.Root>
                  <Stack.Root direction="row" gap="normal" className="pending-request-links">
                    <Link.Root href={requestIssuesUrl(request)} target="_blank" rel="noopener noreferrer" data-testid="pending-issue">
                      Find its issue
                    </Link.Root>
                    <Link.Root href={requestPullsUrl(request)} target="_blank" rel="noopener noreferrer" data-testid="pending-pull">
                      Check the pull request
                    </Link.Root>
                    <Link.Root href={requestIssueUrl(request)} target="_blank" rel="noopener noreferrer" data-testid="pending-form">
                      Open the request form again
                    </Link.Root>
                  </Stack.Root>
                </Stack.Root>
              </Card.Body>
            </Card.Root>
          ))}
        </Stack.Root>
      )}
    </Stack.Root>
  );
}
