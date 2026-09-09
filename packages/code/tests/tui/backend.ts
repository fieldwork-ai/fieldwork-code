import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { UIMessage } from "ai";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
export type Reply = { text?: string; tool?: { name: string; input: unknown }; wait?: Promise<void>; fail?: string; pending?: UIMessage; truncate?: boolean };

export async function mockBackend(initialMessages: UIMessage[] = [], script?: (message: UIMessage) => Reply) {
  let messages = structuredClone(initialMessages);
  let counter = 0;
  const replies: Reply[] = [];
  const requests: Record<string, unknown>[] = [];
  const active = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const json = (data: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/conversations" || (req.url === "/api/conversations/tui-demo" && req.method === "GET")) {
      json({ conversation_id: "tui-demo", model: "Scripted model", messages, auto_approve: false }); return;
    }
    if (req.url === "/api/conversations/tui-demo/stop") {
      for (const stream of active) stream.end();
      json({ ok: true }); return;
    }
    if (req.url !== "/api/conversations/tui-demo/chat") { json({ error: `Unexpected route: ${req.url}` }, 404); return; }
    requests.push(body);
    const reply = replies.shift() ?? script?.(body.message as UIMessage) ?? { text: "Scripted reply complete." };
    if (reply.fail) {
      if (reply.wait) await reply.wait;
      if (reply.pending) messages.push(reply.pending);
      json({ error: reply.fail, pending_approval: !!reply.pending }, 409); return;
    }
    const input = body.message as UIMessage;
    const continuation = input.role === "assistant";
    if (!continuation) messages.push(input);
    const id = continuation ? input.id : `assistant-${++counter}`;
    const message: UIMessage = continuation ? structuredClone(input) : { id, role: "assistant", parts: [] };
    const save = () => { messages = [...messages.filter(item => item.id !== id), structuredClone(message)]; };
    res.writeHead(200, { "content-type": "text/event-stream" });
    active.add(res);
    res.on("close", () => active.delete(res));
    const emit = (chunk: unknown) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    emit({ type: "start", messageId: id });
    if (continuation) {
      for (const part of message.parts) {
        if (!("approval" in part) || !part.approval || !("toolCallId" in part)) continue;
        if (part.approval.approved) {
          Object.assign(part, { state: "output-available", output: { output: "Done." } });
          emit({ type: "tool-output-available", toolCallId: part.toolCallId, output: { output: "Done." } });
        } else {
          Object.assign(part, { state: "output-denied" });
          emit({ type: "tool-output-denied", toolCallId: part.toolCallId });
        }
      }
    }
    if (reply.text) {
      emit({ type: "text-start", id: "text" });
      emit({ type: "text-delta", id: "text", delta: reply.text });
      message.parts.push({ type: "text", text: reply.text });
    }
    if (reply.wait) await Promise.race([reply.wait, new Promise<void>(resolve => res.once("close", resolve))]);
    if (res.destroyed || res.writableEnded) return;
    if (reply.text) emit({ type: "text-end", id: "text" });
    if (reply.tool) {
      const toolCallId = `tool-${counter}`, approvalId = `approval-${counter}`;
      emit({ type: "tool-input-available", toolCallId, toolName: reply.tool.name, input: reply.tool.input });
      emit({ type: "tool-approval-request", approvalId, toolCallId });
      message.parts.push({ type: `tool-${reply.tool.name}`, toolCallId, input: reply.tool.input, state: "approval-requested", approval: { id: approvalId } });
    }
    save();
    if (!reply.truncate) { emit({ type: "finish" }); res.write("data: [DONE]\n\n"); }
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    replies, requests,
    async close() { for (const stream of active) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
