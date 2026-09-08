import { websocketEvents } from "./websocket.js";
import { randomUUID, createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import type { AssistantMessage, AssistantMessageEvent, CodexClientOptions, CodexRuntime, Context, ImageContent, Model, ProviderStreamOptions, TextContent, ToolCall } from "./client-types.js";

export function normalizeCodexBaseUrl(value = "https://chatgpt.com/backend-api/codex"): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Codex requires HTTPS");
  let pathname = url.pathname.replace(/\/+$/, "");
  if (["chatgpt.com", "chat.openai.com"].includes(url.hostname)) {
    if (!pathname.includes("/backend-api")) pathname += "/backend-api";
    if (pathname.endsWith("/backend-api")) pathname += "/codex";
  }
  url.pathname = pathname;
  if (url.search || url.hash || url.username || url.password) throw new Error("Invalid Codex base URL");
  return url.toString().replace(/\/$/, "");
}
function accountOf(token: string): string {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    const id = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof id === "string" && id) return id;
  } catch { /* The credential is validated by the service, not by JWT decoding. */ }
  throw new Error("ChatGPT account ID is required");
}
function contentOf(content: (TextContent | ImageContent)[]) {
  return content.map(part => part.type === "text" ? { type: "input_text", text: part.text } : { type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` });
}
function callId(id: string) { return id.split("|")[0]; }
export function responsesInput(context: Context): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  for (const message of context.messages) {
    if (message.role === "user") input.push({ role: "user", content: typeof message.content === "string" ? [{ type: "input_text", text: message.content }] : contentOf(message.content) });
    else if (message.role === "toolResult") input.push({ type: "function_call_output", call_id: callId(message.toolCallId), output: contentOf(message.content) });
    else for (const part of message.content) {
      if (part.type === "text") input.push({ role: "assistant", content: [{ type: "output_text", text: part.text }] });
      else if (part.type === "toolCall") input.push({ type: "function_call", call_id: callId(part.id), name: part.name, arguments: JSON.stringify(part.arguments) });
      else if (part.thinkingSignature) {
        try {
          const item = JSON.parse(part.thinkingSignature);
          if (item?.type === "reasoning" && typeof item.encrypted_content === "string") input.push(item);
        } catch { /* Foreign or legacy reasoning signatures must never brick replay. */ }
      }
    }
  }
  return input;
}
function uuidV5(namespace: string, value: string): string {
  const bytes = createHash("sha1").update(Buffer.from(namespace.replaceAll("-", ""), "hex")).update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function buildCodexRequest(model: Model, context: Context, options: ProviderStreamOptions, config: CodexClientOptions) {
  const base = normalizeCodexBaseUrl(config.baseUrl ?? model.baseUrl);
  const token = options.apiKey;
  if (!token) throw new Error("Codex access token is required");
  if (!config.attribution.originator.trim() || !config.attribution.userAgent.trim()) throw new Error("Caller attribution is required");
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("ChatGPT-Account-Id", config.accountId ?? accountOf(token));
  headers.set("originator", config.attribution.originator);
  headers.set("User-Agent", config.attribution.userAgent);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "text/event-stream");
  const sessionId = options.sessionId ?? randomUUID();
  const threadId = options.threadId ?? sessionId;
  headers.set("session-id", sessionId);
  headers.set("thread-id", threadId);
  headers.set("x-client-request-id", threadId);
  if (config.fedramp) headers.set("X-OpenAI-Fedramp", "true");
  headers.set("x-codex-routing-hint", `model=${model.id}${options.serviceTier ? `;tier=${options.serviceTier}` : ""}`);
  const input = responsesInput(context);
  const tools = (context.tools ?? []).map(tool => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }));
  if (config.responsesLite) {
    headers.set("x-openai-internal-codex-responses-lite", "true");
    const namespace = uuidV5("6ba7b812-9dad-11d1-80b4-00c04fd430c8", threadId);
    const prefix: Record<string, unknown>[] = [{ type: "additional_tools", id: `at_${uuidV5(namespace, JSON.stringify(tools))}`, role: "developer", tools }];
    if (context.systemPrompt) prefix.push({ type: "message", id: `msg_${uuidV5(namespace, context.systemPrompt)}`, role: "developer", content: [{ type: "input_text", text: context.systemPrompt }] });
    input.unshift(...prefix);
  }
  const payload = {
    model: model.id, instructions: config.responsesLite ? "" : context.systemPrompt ?? "", input,
    ...(!config.responsesLite ? { tools } : {}), tool_choice: "auto", parallel_tool_calls: !config.responsesLite,
    reasoning: { effort: options.reasoningEffort ?? "medium", summary: options.reasoningSummary ?? "auto" },
    store: false, stream: true, include: ["reasoning.encrypted_content"],
    ...(options.serviceTier ? { service_tier: options.serviceTier } : {}),
    ...(options.promptCacheKey || options.sessionId ? { prompt_cache_key: options.promptCacheKey ?? options.sessionId } : {}),
    text: { verbosity: options.textVerbosity ?? "low" },
    client_metadata: { session_id: sessionId, thread_id: threadId },
  };
  const json = JSON.stringify(payload);
  const compressed = config.compression !== false && model.provider === "openai";
  if (compressed) headers.set("Content-Encoding", "zstd");
  return { url: `${base}/responses`, headers, payload, body: compressed ? new Uint8Array(zstdCompressSync(Buffer.from(json))) : json };
}

async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, any>> {
  const reader = body.getReader();
  let buffer = "", data: string[] = [];
  const decoder = new TextDecoder();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      if (buffer.length > 8 * 1024 * 1024) throw new Error("Codex stream frame too large");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
        if (line === "") {
          const payload = data.join("\n"); data = [];
          if (payload && payload !== "[DONE]") yield JSON.parse(payload);
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
          if (data.reduce((size, line) => size + line.length, 0) > 8 * 1024 * 1024) throw new Error("Codex stream frame too large");
        }
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export class CodexClient implements CodexRuntime {
  constructor(readonly config: CodexClientOptions) {}
  async complete(model: Model, context: Context, options: ProviderStreamOptions = {}): Promise<AssistantMessage> {
    for await (const event of this.stream(model, context, options)) {
      if (event.type === "done") return event.message;
      if (event.type === "error") return event.error;
    }
    throw new Error("Codex stream ended without a result");
  }
  async *stream(model: Model, context: Context, options: ProviderStreamOptions = {}): AsyncGenerator<AssistantMessageEvent> {
    const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    try {
      const request = buildCodexRequest(model, context, options, this.config);
      let events: AsyncIterable<Record<string, any>>;
      if (options.transport === "websocket") {
        const { stream: _stream, ...payload } = request.payload;
        events = websocketEvents(request.url, request.headers, payload, options.signal);
      } else {
        const response = await (this.config.fetchFn ?? fetch)(request.url, { method: "POST", headers: request.headers, body: request.body, signal: options.signal, redirect: "error" });
        if (!response.ok) {
          const error = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
          const code = error?.error?.code?.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 100);
          throw new Error(`Codex request failed with HTTP ${response.status}${code ? ` (${code})` : ""}`);
        }
        if (!response.body) throw new Error("Codex response has no body");
        events = sse(response.body);
      }
      yield { type: "start", partial: message };
      const itemIndexes = new Map<string, number>();
      const argumentsText = new Map<string, string>();
      const textKeys = new Map<string, number>();
      const ended = new Set<number>();
      for await (const event of events) {
        if (event.type === "response.created" || event.type === "response.in_progress") {
          message.responseId = event.response?.id; message.responseModel = event.response?.model ?? model.id;
        } else if (event.type === "response.output_item.added") {
          const item = event.item;
          if (item?.type === "function_call") {
            const index = message.content.length;
            message.content.push({ type: "toolCall", id: item.call_id, name: item.name, arguments: {} });
            itemIndexes.set(item.id, index); argumentsText.set(item.id, item.arguments ?? "");
            yield { type: "toolcall_start", contentIndex: index, partial: message };
          } else if (item?.type === "reasoning") {
            const index = message.content.length;
            message.content.push({ type: "thinking", thinking: "" }); itemIndexes.set(item.id, index);
            yield { type: "thinking_start", contentIndex: index, partial: message };
          }
        } else if (event.type === "response.output_text.delta") {
          const key = `${event.item_id}:${event.content_index ?? 0}`;
          let index = textKeys.get(key);
          if (index === undefined) {
            index = message.content.length; textKeys.set(key, index);
            message.content.push({ type: "text", text: "" });
            yield { type: "text_start", contentIndex: index, partial: message };
          }
          const part = message.content[index];
          if (part.type === "text") part.text += event.delta ?? "";
          yield { type: "text_delta", contentIndex: index, delta: event.delta ?? "", partial: message };
        } else if (event.type === "response.reasoning_summary_text.delta") {
          const index = itemIndexes.get(event.item_id);
          if (index === undefined) continue;
          const part = message.content[index];
          if (part.type === "thinking") part.thinking += event.delta ?? "";
          yield { type: "thinking_delta", contentIndex: index, delta: event.delta ?? "", partial: message };
        } else if (event.type === "response.function_call_arguments.delta") {
          const index = itemIndexes.get(event.item_id);
          if (index === undefined) continue;
          argumentsText.set(event.item_id, (argumentsText.get(event.item_id) ?? "") + (event.delta ?? ""));
          yield { type: "toolcall_delta", contentIndex: index, delta: event.delta ?? "", partial: message };
        } else if (event.type === "response.output_item.done") {
          const item = event.item;
          if (item?.type === "message") {
            for (let contentIndex = 0; contentIndex < (item.content ?? []).length; contentIndex++) {
              const content = item.content[contentIndex];
              if (content.type !== "output_text") continue;
              const key = `${item.id}:${contentIndex}`;
              if (!textKeys.has(key)) {
                const index = message.content.length; textKeys.set(key, index);
                message.content.push({ type: "text", text: content.text ?? "" });
                yield { type: "text_start", contentIndex: index, partial: message };
                yield { type: "text_delta", contentIndex: index, delta: content.text ?? "", partial: message };
              }
            }
            continue;
          }
          let index = itemIndexes.get(item?.id);
          if (index === undefined && (item?.type === "reasoning" || item?.type === "function_call")) {
            index = message.content.length; itemIndexes.set(item.id, index);
            if (item.type === "reasoning") {
              message.content.push({ type: "thinking", thinking: "" });
              yield { type: "thinking_start", contentIndex: index, partial: message };
            } else {
              message.content.push({ type: "toolCall", id: item.call_id, name: item.name, arguments: {} });
              yield { type: "toolcall_start", contentIndex: index, partial: message };
              yield { type: "toolcall_delta", contentIndex: index, delta: item.arguments ?? "{}", partial: message };
            }
          }
          if (index === undefined) continue;
          const part = message.content[index]; ended.add(index);
          if (part.type === "thinking") {
            if (!part.thinking) {
              part.thinking = (item.summary ?? []).map((summary: { text?: string }) => summary.text ?? "").join("\n");
              if (part.thinking) yield { type: "thinking_delta", contentIndex: index, delta: part.thinking, partial: message };
            }
            part.thinkingSignature = JSON.stringify(item);
            yield { type: "thinking_end", contentIndex: index, content: part.thinking, partial: message };
          } else if (part.type === "toolCall") {
            const text = item.arguments ?? argumentsText.get(item.id) ?? "{}";
            part.arguments = JSON.parse(text);
            yield { type: "toolcall_end", contentIndex: index, toolCall: part, partial: message };
          }
        } else if (event.type === "response.failed" || event.type === "error") {
          const error = event.response?.error ?? event.error ?? event;
          throw new Error(`Codex ${error.code ?? "response.failed"}: ${error.message ?? "request failed"}`);
        } else if (event.type === "response.completed" || event.type === "response.incomplete") {
          const result = event.response ?? {};
          message.responseId = result.id ?? message.responseId;
          message.responseModel = result.model ?? message.responseModel;
          const usage = result.usage ?? {};
          message.usage.cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;
          message.usage.input = Math.max(0, (usage.input_tokens ?? 0) - message.usage.cacheRead);
          message.usage.output = usage.output_tokens ?? 0;
          message.usage.totalTokens = usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
          for (let index = 0; index < message.content.length; index++) {
            if (ended.has(index)) continue;
            const part = message.content[index];
            if (part.type === "text") yield { type: "text_end", contentIndex: index, content: part.text, partial: message };
            else if (part.type === "thinking") yield { type: "thinking_end", contentIndex: index, content: part.thinking, partial: message };
            else throw new Error("Codex completed with an unfinished tool call");
          }
          message.stopReason = event.type === "response.incomplete" ? "length" : message.content.some(part => part.type === "toolCall") ? "toolUse" : "stop";
          yield { type: "done", reason: message.stopReason, message }; return;
        }
      }
      throw new Error("Codex stream closed before response.completed");
    } catch (error) {
      message.stopReason = options.signal?.aborted ? "aborted" : "error";
      message.errorMessage = error instanceof Error ? error.message : String(error);
      yield { type: "error", reason: message.stopReason, error: message };
    }
  }
}
