/**
 * A fake Anthropic Messages API for tests, so the agent's whole loop runs
 * with no key and no network. `streamEvents` writes a scripted assistant
 * message as the API's server-sent events, in its wire format: message_start,
 * content_block_start, text, thinking, signature and input_json deltas,
 * content_block_stop, message_delta with the stop reason and usage, and
 * message_stop. `fakeAnthropic` serves scripted replies over HTTPS with CORS,
 * as api.anthropic.com does, for Chromium to reach through a host mapping.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Splits text into `parts` pieces, so deltas arrive in several events as they do from the API. */
function pieces(text, parts) {
  if (text.length === 0) return [""];
  const size = Math.max(1, Math.ceil(text.length / parts));
  const out = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
  return out;
}

/**
 * The events of one assistant message.
 * @param {{ id?: string, model?: string, blocks: Array<{ type: "text", text: string } | { type: "thinking", thinking: string, signature?: string } | { type: "tool_use", id: string, name: string, input: unknown } | { type: "fallback", from: string, to: string }>, stopReason: string, stopDetails?: unknown, usage?: { input?: number, output?: number, cacheWrite?: number, cacheRead?: number } }} script
 */
export function streamEvents({ id = "msg_fake", model = "claude-opus-5-5", blocks, stopReason, stopDetails = null, usage = {} }) {
  const events = [];
  const push = (data) => events.push({ event: data.type, data });
  push({
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: usage.input ?? 1200, output_tokens: 1, cache_creation_input_tokens: usage.cacheWrite ?? 0, cache_read_input_tokens: usage.cacheRead ?? 0 },
    },
  });
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      push({ type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } });
      for (const text of pieces(block.text, 3)) push({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
    } else if (block.type === "thinking") {
      push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      for (const thinking of pieces(block.thinking, 2)) push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } });
      push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature ?? `sig-${id}-${index}` } });
    } else if (block.type === "tool_use") {
      push({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      for (const partial_json of pieces(JSON.stringify(block.input), 4)) push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } });
    } else if (block.type === "fallback") {
      push({ type: "content_block_start", index, content_block: { type: "fallback", from: { model: block.from }, to: { model: block.to } } });
    }
    push({ type: "content_block_stop", index });
  });
  push({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null, stop_details: stopDetails }, usage: { output_tokens: usage.output ?? 240 } });
  push({ type: "message_stop" });
  return events;
}

export function sseText(events) {
  return events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

/** An error body as the API sends it. */
export function errorBody(type, message) {
  return { type: "error", error: { type, message }, request_id: "req_fake" };
}

/** A fetch that answers each request with the next scripted reply; it records every request it got. */
export function scriptedFetch(replies) {
  const requests = [];
  const queue = [...replies];
  const fetch = async (url, init = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    const headers = new Headers(init.headers);
    requests.push({ url: String(url), body, headers });
    const next = queue.shift();
    if (!next) throw new Error(`no scripted reply for request ${requests.length}`);
    const reply = typeof next === "function" ? next(body) : next;
    if (reply.status && reply.status !== 200) {
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json", "request-id": "req_fake" } });
    }
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const events = reply.events;
        for (let index = 0; index < events.length; index += 1) {
          if (init.signal?.aborted) break;
          if (reply.holdAfter !== undefined && index === reply.holdAfter) {
            await new Promise((resolve) => {
              if (init.signal?.aborted) return resolve();
              init.signal?.addEventListener("abort", resolve);
            });
            break;
          }
          controller.enqueue(encoder.encode(sseText([events[index]])));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_fake" } });
  };
  return { fetch, requests, left: () => queue.length };
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "600",
};

/**
 * A fake api.anthropic.com over HTTPS, with a throwaway self-signed
 * certificate. Each POST to /v1/messages takes the next reply from the
 * script: a function of the request body that returns `{ events, delayMs?,
 * holdAfter? }` (stream the events, `delayMs` apart, and stop sending after
 * `holdAfter` of them until the client goes away) or `{ status, body }`.
 */
export async function fakeAnthropic() {
  const dir = mkdtempSync(join(tmpdir(), "fake-anthropic-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "2", "-subj", "/CN=api.anthropic.com", "-addext", "subjectAltName=DNS:api.anthropic.com"], { stdio: "ignore" });
  let script = [];
  const requests = [];
  const server = createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, CORS).end();
      return;
    }
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", async () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ path: request.url, headers: request.headers, body });
      const next = script.shift();
      if (!next) {
        response.writeHead(500, { ...CORS, "content-type": "application/json" }).end(JSON.stringify(errorBody("api_error", "the fake API has no scripted reply left")));
        return;
      }
      let reply;
      try {
        reply = typeof next === "function" ? next(body) : next;
      } catch (error) {
        response.writeHead(500, { ...CORS, "content-type": "application/json" }).end(JSON.stringify(errorBody("api_error", `script failed: ${error.message}`)));
        return;
      }
      if (reply.status && reply.status !== 200) {
        response.writeHead(reply.status, { ...CORS, "content-type": "application/json", "request-id": "req_fake" }).end(JSON.stringify(reply.body));
        return;
      }
      response.writeHead(200, { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": "req_fake" });
      let closed = false;
      response.on("close", () => (closed = true));
      for (let index = 0; index < reply.events.length; index += 1) {
        if (closed) return;
        if (reply.holdAfter !== undefined && index === reply.holdAfter) {
          reply.onHold?.();
          return; // keep the connection open until the client goes away
        }
        response.write(sseText([reply.events[index]]));
        if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
      }
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    requests,
    /** Replaces what the next requests get. */
    script(replies) {
      script = [...replies];
      requests.length = 0;
    },
    left: () => script.length,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}
