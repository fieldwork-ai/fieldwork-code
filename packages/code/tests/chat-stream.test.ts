import { describe, expect, it } from "vitest";
import { consumeTurn } from "../src/chat/stream.js";
import type { UIMessage } from "ai";
import { pendingApprovals, respondToApproval, terminalText } from "../src/chat/protocol.js";
function response(chunks: unknown[]) {
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
}
describe("Fieldwork Code stream", () => {
  it("folds approvals and metadata through the SDK and resumes the same assistant", async () => {
    const message = await consumeTurn(response([
      { type: "start", messageId: "assistant-1" },
      { type: "data-heartbeat", data: {} },
      { type: "tool-input-available", toolCallId: "call-1", toolName: "bash", input: { command: "pwd" } },
      { type: "tool-approval-request", approvalId: "approval-1", toolCallId: "call-1" },
      { type: "finish", messageMetadata: { finish_reason: "tool-calls" } },
    ]), { onMessage() {}, onStatus() {} });
    expect(pendingApprovals(message)).toEqual([{ id: "approval-1", tool: "bash", input: { command: "pwd" } }]);
    expect(message?.metadata).toEqual({ finish_reason: "tool-calls" });
    const approved = respondToApproval(message!, "approval-1", false);
    expect(pendingApprovals(message)).toHaveLength(1);
    const resumed = await consumeTurn(response([
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
  it("rejects a truncated response instead of reporting completion", async () => {
    await expect(consumeTurn(response([{ type: "start", messageId: "a" }]), { onMessage() {}, onStatus() {} })).rejects.toThrow("before the turn finished");
  });
  it("removes terminal control bytes from untrusted text", () => {
    expect(terminalText("hello\x1b]52;c;YQ==\x07\nworld")).toBe("hello]52;c;YQ==\nworld");
  });
});

it("accepts completed denial-only and explicit-compaction streams without a finish chunk", async () => {
  const message: UIMessage = { id: "a", role: "assistant", parts: [{ type: "tool-bash", toolCallId: "t", state: "approval-responded", input: {}, approval: { id: "approval", approved: false } }] };
  const denied = await consumeTurn(response([{ type: "tool-output-denied", toolCallId: "t" }]), { message, onMessage() {}, onStatus() {} });
  expect(denied?.parts).toContainEqual(expect.objectContaining({ state: "output-denied" }));
  await expect(consumeTurn(response([{ type: "data-compaction-status", data: { status: "skipped" }, transient: true }]), { compact: true, onMessage() {}, onStatus() {} })).resolves.toBeUndefined();
  await expect(consumeTurn(response([{ type: "data-compaction-status", data: { status: "start" }, transient: true }]), { compact: true, onMessage() {}, onStatus() {} })).rejects.toThrow("before the turn finished");
});
