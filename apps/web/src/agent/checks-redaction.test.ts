import { describe, expect, it } from "vitest";
import { scriptedFetch, streamEvents } from "../../e2e/fake-anthropic.mjs";
import { fakeHost } from "../../test/agent-host";
import { AgentController, type DocContext, type Turn } from "./controller";
import { DEFAULT_SETTINGS } from "./models";
import { createClient } from "./request";

const KEY = "sk-ant-test-0123456789abcdefghij";
const TOKEN = "mcp-secret-token-0123456789";

// The checks a turn reports quote frames' messages word for word; a secret in one is redacted wherever the report goes.
const leakingHost = () => {
  const parts = fakeHost();
  return { ...parts.host, async measured(signal: AbortSignal) { const m = await parts.host.measured(signal); return { ...m, frames: [{ frame: "pages/a", stage: "render", message: `fetch failed with Authorization: Bearer ${TOKEN}` }] }; } };
};
const docs = (): DocContext => ({ sources: [], token: () => null, tokens: () => [TOKEN] });
const controllerFor = (fake: ReturnType<typeof scriptedFetch>, saved: unknown[]) =>
  new AgentController({ host: leakingHost(), store: { load: async () => null, save: async (r) => void saved.push(JSON.parse(JSON.stringify(r))) }, key: () => KEY, settings: () => DEFAULT_SETTINGS, client: (k) => createClient(k, { fetch: fake.fetch, maxRetries: 0 }), newId: () => "turn-1", docs });

describe("a checks report that quotes a secret", () => {
  it("from run_checks, is redacted in the tool result, the checks shown and the chat saved", async () => {
    const fake = scriptedFetch([
      { events: streamEvents({ id: "msg_1", blocks: [{ type: "tool_use", id: "toolu_c", name: "run_checks", input: {} }], stopReason: "tool_use" }) },
      { events: streamEvents({ id: "msg_2", blocks: [{ type: "text", text: "Done." }], stopReason: "end_turn" }) },
    ]);
    const saved: unknown[] = [];
    const controller = controllerFor(fake, saved);
    await controller.send("check");
    expect(JSON.stringify(fake.requests[1]?.body.messages)).not.toContain(TOKEN);
    expect(JSON.stringify(controller.getState().turns.at(-1) as Turn)).not.toContain(TOKEN);
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
  });

  it("from the checks after a change, is redacted in the note sent back and the checks shown", async () => {
    const fake = scriptedFetch([
      { events: streamEvents({ id: "msg_1", blocks: [{ type: "tool_use", id: "toolu_e", name: "patch_spec", input: { path: "pages/booking.json", patches: '{"op":"replace","path":"/elements/hold/props/variant","value":"primary"}' } }], stopReason: "tool_use" }) },
      { events: streamEvents({ id: "msg_2", blocks: [{ type: "text", text: "Done." }], stopReason: "end_turn" }) },
    ]);
    const saved: unknown[] = [];
    const controller = controllerFor(fake, saved);
    await controller.send("edit");
    expect(JSON.stringify(fake.requests[1]?.body.messages)).not.toContain(TOKEN);
    expect(JSON.stringify(fake.requests[1]?.body.messages)).toContain("[a docs server token]");
    expect(JSON.stringify(controller.getState().turns.at(-1))).not.toContain(TOKEN);
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
  });
});
