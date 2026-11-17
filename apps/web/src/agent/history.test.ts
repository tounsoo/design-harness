import type { BetaContentBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";
import { History, echoable, toolCalls } from "./history";

const thinking = { type: "thinking", thinking: "Hold room should stay secondary.", signature: "c2lnbmF0dXJl" } as BetaContentBlock;
const text = { type: "text", text: "Changing the page.", citations: null } as BetaContentBlock;
const call = { type: "tool_use", id: "toolu_1", name: "read_project", input: {} } as BetaContentBlock;

describe("the API history", () => {
  it("only grows: every earlier message stays the same frozen object, byte for byte", () => {
    const history = new History();
    history.appendUser("Make the rooms page friendlier");
    const first = history.messages;
    const before = JSON.stringify(first);
    history.appendAssistant([thinking, text, call]);
    history.appendToolResults([{ type: "tool_result", tool_use_id: "toolu_1", content: "{}" }], ["Checks: pass"]);
    history.appendAssistant([text]);
    const after = history.messages;
    expect(after.slice(0, first.length)).toEqual(first);
    expect(after[0]).toBe(first[0]);
    expect(JSON.stringify(after.slice(0, first.length))).toBe(before);
    expect(after.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(Object.isFrozen(after[1]) && Object.isFrozen((after[1]?.content as unknown[])[0])).toBe(true);
    expect(() => {
      (after[0] as { content: unknown }).content = "rewritten";
    }).toThrow();
  });

  it("sends thinking blocks back unchanged, signature included, and drops the SDK's own bookkeeping", () => {
    const history = new History();
    history.appendUser("go");
    const streamed = { ...call };
    Object.defineProperty(streamed, "__json_buf", { value: "{}", enumerable: false });
    history.appendAssistant([thinking, streamed as BetaContentBlock]);
    const assistant = history.messages[1];
    expect(assistant?.content).toEqual([thinking, call]);
    expect(JSON.stringify(assistant)).not.toContain("__json_buf");
  });

  it("puts notes before the person's text, and the app's checks after the tool results", () => {
    const history = new History();
    history.appendUser("Undo was fine, go on", ["The person undid your changes."]);
    history.appendAssistant([call]);
    history.appendToolResults([{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }], ["Checks for revision 3: pass."]);
    expect(history.messages[0]?.content).toEqual([
      { type: "text", text: "The person undid your changes." },
      { type: "text", text: "Undo was fine, go on" },
    ]);
    expect(history.messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
      { type: "text", text: "Checks for revision 3: pass." },
    ]);
  });

  it("refuses tool results that do not answer the last turn's calls, in order", () => {
    const history = new History();
    history.appendUser("go");
    history.appendAssistant([call]);
    expect(() => history.appendToolResults([{ type: "tool_result", tool_use_id: "toolu_2", content: "" }])).toThrow("expected toolu_1, got toolu_2");
  });

  it("echoes a turn a refusal fallback continued as the API requires: before the last boundary, only text and the markers", () => {
    const declined = { type: "thinking", thinking: "", signature: "old" } as BetaContentBlock;
    const early = { type: "tool_use", id: "toolu_early", name: "read_project", input: {} } as BetaContentBlock;
    const fallback = { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" } } as unknown as BetaContentBlock;
    const content = [declined, text, early, fallback, thinking, call];
    expect(echoable(content).map((block) => block.type)).toEqual(["text", "fallback", "thinking", "tool_use"]);
    expect(toolCalls(content).map((item) => item.id)).toEqual(["toolu_1"]);
    expect(echoable([text, { type: "mystery" } as unknown as BetaContentBlock]).map((block) => block.type)).toEqual(["text"]);
  });

  it("restores a saved history exactly", () => {
    const history = new History();
    history.appendUser("go");
    history.appendAssistant([thinking, text]);
    expect(new History(JSON.parse(JSON.stringify(history.toJSON()))).messages).toEqual(history.messages);
  });
});
