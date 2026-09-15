import { describe, expect, it } from "vitest";
import { consumeTurn } from "../src/chat/stream.js";
import type { UIMessage } from "ai";
import { pendingApprovals, respondToApproval, terminalText } from "../src/chat/protocol.js";
function response(chunks: unknown[]) {
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
}
describe("Fieldwork Code stream", () => {
  it("folds approvals and metadata through the SDK and resumes the same assistant", async () => {
    const { message, finished } = await consumeTurn(response([
      { type: "start", messageId: "assistant-1" },
      { type: "data-heartbeat", data: {} },
      { type: "tool-input-available", toolCallId: "call-1", toolName: "bash", input: { command: "pwd" } },
      { type: "tool-approval-request", approvalId: "approval-1", toolCallId: "call-1" },
      { type: "finish", messageMetadata: { finish_reason: "tool-calls" } },
    ]), { onMessage() {}, onStatus() {} });
    expect(finished).toBe(true);
    expect(pendingApprovals(message)).toEqual([{ id: "approval-1", tool: "bash", input: { command: "pwd" } }]);
    expect(message?.metadata).toEqual({ finish_reason: "tool-calls" });
    const approved = respondToApproval(message!, "approval-1", false);
    expect(pendingApprovals(message)).toHaveLength(1);
    const { message: resumed } = await consumeTurn(response([
      { type: "start", messageId: "assistant-1" },
      { type: "tool-output-denied", toolCallId: "call-1" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Denied." },
      { type: "text-end", id: "text-1" },
      { type: "finish" },
    ]), { message: approved, onMessage() {}, onStatus() {} });
    expect(resumed?.id).toBe("assistant-1");
    expect(resumed?.parts).toContainEqual(expect.objectContaining({ state: "output-denied" }));
    expect(pendingApprovals(resumed)).toEqual([]);
  });
  it("reports a stream that closed before the finish as unfinished, with what arrived", async () => {
    const { message, finished } = await consumeTurn(response([
      { type: "start", messageId: "a" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "So far" },
      { type: "text-end", id: "text-1" },
      { type: "data-handoff", data: { after: "41" }, transient: true },
    ]), { onMessage() {}, onStatus() {} });
    expect(finished).toBe(false);
    expect(message?.parts).toEqual([{ type: "text", text: "So far", state: "done" }]);
  });
  it("continues a message it is handed, keeping its parts under the stream's id", async () => {
    const partial: UIMessage = { id: "a", role: "assistant", parts: [{ type: "text", text: "So far" }] };
    const { message, finished } = await consumeTurn(response([
      { type: "start", messageId: "a" },
      { type: "text-start", id: "text-2" },
      { type: "text-delta", id: "text-2", delta: " and the rest." },
      { type: "text-end", id: "text-2" },
      { type: "finish" },
    ]), { message: partial, onMessage() {}, onStatus() {} });
    expect(finished).toBe(true);
    expect(message?.id).toBe("a");
    expect(message?.parts.map(part => part.type === "text" ? part.text : part.type)).toEqual(["So far", " and the rest."]);
  });
  it("removes terminal control bytes from untrusted text", () => {
    expect(terminalText("hello\x1b]52;c;YQ==\x07\nworld")).toBe("hello]52;c;YQ==\nworld");
  });
});

it("accepts completed denial-only and explicit-compaction streams without a finish chunk", async () => {
  const message: UIMessage = { id: "a", role: "assistant", parts: [{ type: "tool-bash", toolCallId: "t", state: "approval-responded", input: {}, approval: { id: "approval", approved: false } }] };
  const denied = await consumeTurn(response([{ type: "tool-output-denied", toolCallId: "t" }]), { message, onMessage() {}, onStatus() {} });
  expect(denied.finished).toBe(true);
  expect(denied.message?.parts).toContainEqual(expect.objectContaining({ state: "output-denied" }));
  await expect(consumeTurn(response([{ type: "data-compaction-status", data: { status: "skipped" }, transient: true }]), { compact: true, onMessage() {}, onStatus() {} })).resolves.toEqual({ message: undefined, finished: true });
  await expect(consumeTurn(response([{ type: "data-compaction-status", data: { status: "start" }, transient: true }]), { compact: true, onMessage() {}, onStatus() {} })).resolves.toMatchObject({ finished: false });
});
