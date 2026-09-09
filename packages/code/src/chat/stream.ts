import type { UIMessage, UIMessageChunk } from "ai";

export async function consumeTurn(response: Response, options: {
  message?: UIMessage;
  compact?: boolean;
  onMessage: (message: UIMessage) => void;
  onStatus: (status: string) => void;
}): Promise<UIMessage | undefined> {
  if (!response.body) throw new Error("The response has no stream");
  const { parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema } = await import("ai");
  let finished = false;
  let controlOnly = true;
  let compactFinished = false;
  const responses = options.message?.parts.filter(part => "state" in part && part.state === "approval-responded") ?? [];
  const allDenied = responses.length > 0 && responses.every(part => "approval" in part && part.approval?.approved === false);
  const denied = new Set(responses.flatMap(part => "toolCallId" in part ? [part.toolCallId] : []));
  const stream = parseJsonEventStream({ stream: response.body, schema: uiMessageChunkSchema })
    .pipeThrough(new TransformStream({
      transform(parsed, controller: TransformStreamDefaultController<UIMessageChunk>) {
        if (!parsed.success) throw new Error("Invalid chat stream", { cause: parsed.error });
        const chunk = parsed.value;
        if (chunk.type === "data-heartbeat") return;
        if (chunk.type === "data-compaction-status") {
          const data = chunk.data as { status?: string; reason?: string };
          compactFinished = ["done", "skipped", "failed"].includes(data.status ?? "");
          options.onStatus(`Compaction: ${data.status ?? "working"}${data.reason ? ` (${data.reason})` : ""}`);
        } else if (chunk.type === "tool-output-denied") denied.delete(chunk.toolCallId);
        else controlOnly = false;
        if (chunk.type === "finish") finished = true;
        controller.enqueue(chunk);
      },
    }));
  let last = options.message;
  for await (const message of readUIMessageStream({ stream, message: options.message, terminateOnError: true })) {
    last = message;
    options.onMessage(message);
  }
  const controlComplete = controlOnly && (options.compact ? compactFinished : allDenied && denied.size === 0);
  if (!finished && !controlComplete) throw new Error("Connection ended before the turn finished. Resume this conversation to recover its saved messages.");
  return last;
}
