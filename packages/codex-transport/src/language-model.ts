import {

  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type ImageContent,
  type CodexRuntime,
  type Message,
  type Model,
  type ProviderStreamOptions,
  type TextContent,
  type Tool,
  type ToolResultMessage,
  type Usage,
} from "./client-types.js";
import { CodexClient } from "./client.js";
import type { CodexClientOptions } from "./client-types.js";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4Message,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4FileData,
  SharedV4ProviderMetadata,
  SharedV4Warning,
} from "@ai-sdk/provider";

import {
  OPENAI_SUBSCRIPTION_CONTEXT_WINDOW_TOKENS,
  OPENAI_SUBSCRIPTION_MAX_OUTPUT_TOKENS,
  OPENAI_SUBSCRIPTION_PROVIDER,
} from "./constants.js";

/** Bridge from Codex's public ChatGPT Responses transport to LanguageModelV4. */

const PROVIDER = OPENAI_SUBSCRIPTION_PROVIDER;
const API = "openai-chatgpt-responses" as const;
const BASE_URL = "https://chatgpt.com/backend-api/codex";

type SubscriptionProviderOptions = {
  cacheRetention?: "none" | "short" | "long";
  promptCacheKey?: string;
  reasoningSummary?: "auto" | "concise" | "detailed";
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  serviceTier?: "priority";
  sessionId?: string;
  textVerbosity?: "low" | "medium" | "high";
  transport?: "sse" | "websocket" | "auto";
};

export interface OpenAISubscriptionModelOptions extends CodexClientOptions {
  isModelImageMime?: (mime: string) => boolean;
  accessToken: string;
  modelId: string;
  runtime?: CodexRuntime;
  transport?: "sse" | "websocket" | "auto";
}

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function codexModel(modelId: string): Model<typeof API> {
  return {
    id: modelId,
    name: modelId,
    api: API,
    // The published transport applies its native Codex behavior, including
    // request compression and account headers, to the canonical OpenAI id.
    provider: "openai",
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: OPENAI_SUBSCRIPTION_CONTEXT_WINDOW_TOKENS,
    maxTokens: OPENAI_SUBSCRIPTION_MAX_OUTPUT_TOKENS,
  };
}

function base64(data: string | Uint8Array): string {
  return typeof data === "string" ? data : Buffer.from(data).toString("base64");
}

/**
 * NOTHING IN THIS PROJECTION MAY THROW ON CONTENT A CONVERSATION CAN HOLD.
 *
 * The server rebuilds the prompt from stored messages on every turn, so a throw
 * here does not fail one request — it bricks the conversation for good, whatever
 * the user types next. The transport carries text and images and nothing else
 * (Codex's Responses converter emits only `input_text` and `input_image`, for
 * user and tool-result content alike), so anything else degrades to a note that
 * tells the model what it cannot see.
 */
function unsupportedNote(what: string): TextContent {
  return { type: "text", text: `[${what} omitted: this model reads text and images only]` };
}

type SubscriptionContent = TextContent | ImageContent;

function fileContentOf(part: {
  data: SharedV4FileData;
  mediaType: string;
  filename?: string;
}, isModelImageMime: (mime: string) => boolean): SubscriptionContent {
  const label = part.filename ? `${part.filename} (${part.mediaType})` : part.mediaType;
  // An inline text document carries its content right here, whatever its media
  // type claims. Checked before the media type so a `text/plain` file reaches
  // the model as its text rather than as a note about a file it cannot read.
  if (part.data.type === "text") return { type: "text", text: part.data.text };
  // URL and provider-reference files are never resolved here: the projection
  // runs on every turn and must stay free of network I/O.
  if (part.data.type !== "data") return unsupportedNote(label);
  if (!isModelImageMime(part.mediaType)) return unsupportedNote(label);
  return { type: "image", data: base64(part.data.data), mimeType: part.mediaType };
}

function userContentOf(
  part: Extract<LanguageModelV4Message, { role: "user" }>["content"][number],
  isModelImageMime: (mime: string) => boolean,
): SubscriptionContent {
  if (part.type === "text") return { type: "text", text: part.text };
  return fileContentOf(part, isModelImageMime);
}

function subscriptionMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = (value as Record<string, unknown>)[PROVIDER];
  return entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
}

function assistantOf(message: Extract<LanguageModelV4Message, { role: "assistant" }>, modelId: string): Message {
  const content: AssistantMessage["content"] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "reasoning") {
      const metadata = subscriptionMetadata(part.providerOptions);
      content.push({
        type: "thinking",
        thinking: part.text,
        ...(typeof metadata?.thinkingSignature === "string"
          ? { thinkingSignature: metadata.thinkingSignature }
          : {}),
      });
    } else if (part.type === "tool-call") {
      const metadata = subscriptionMetadata(part.providerOptions);
      content.push({
        type: "toolCall",
        id: part.toolCallId,
        name: part.toolName,
        arguments:
          part.input && typeof part.input === "object"
            ? (part.input as Record<string, unknown>)
            : {},
        ...(typeof metadata?.thoughtSignature === "string"
          ? { thoughtSignature: metadata.thoughtSignature }
          : {}),
      });
    } else if (part.type === "file" || part.type === "reasoning-file") {
      // An assistant turn generated by another model may carry a file this
      // transport cannot express; the note keeps the turn replayable.
      content.push(unsupportedNote(`Generated ${part.mediaType} file`));
    }
    // Custom parts and assistant-role tool results are dropped: both belong to
    // provider-executed tools, which this transport does not offer. A dropped
    // part must never be a throw — see unsupportedNote.
  }
  return {
    role: "assistant",
    content,
    api: API,
    provider: "openai",
    model: modelId,
    usage: EMPTY_USAGE,
    stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

type V4ToolResultPart = Extract<
  Extract<LanguageModelV4Message, { role: "tool" }>["content"][number],
  { type: "tool-result" }
>;

function textResult(text: string, isError: boolean) {
  return { content: [{ type: "text" as const, text }], isError };
}

function toolResultContent(output: V4ToolResultPart["output"], isModelImageMime: (mime: string) => boolean): {
  content: SubscriptionContent[];
  isError: boolean;
} {
  switch (output.type) {
    case "text":
      return textResult(output.value, false);
    case "json":
      return textResult(JSON.stringify(output.value), false);
    case "error-text":
      return textResult(output.value, true);
    case "error-json":
      return textResult(JSON.stringify(output.value), true);
    case "execution-denied":
      return textResult(output.reason ?? "Tool execution was denied", true);
    case "content": {
      const content = output.value.flatMap((part): SubscriptionContent[] => {
        if (part.type === "text") return [{ type: "text", text: part.text }];
        if (part.type === "file") return [fileContentOf(part, isModelImageMime)];
        // A custom part carries provider-specific options and no portable
        // payload, so there is nothing to render for a different provider.
        return [];
      });
      // The transport writes the result as a `function_call_output`, which every
      // tool call is owed one of; an empty one would be a malformed turn.
      if (content.length === 0) return textResult("[Tool returned no readable content]", false);
      return { content, isError: false };
    }
  }
}

function toolResultsOf(message: Extract<LanguageModelV4Message, { role: "tool" }>, isModelImageMime: (mime: string) => boolean): ToolResultMessage[] {
  return message.content.flatMap((part): ToolResultMessage[] => {
    // A `tool-approval-response` can appear here, and is dropped rather than
    // thrown on. It is NOT the common case: convertToModelMessages filters
    // approval responses out unless the tool was provider-executed, so our
    // carded tools — all client-executed — never produce one. The drop is here
    // because a throw on this path would be permanent, not because the path is
    // hot; approval is the app's concept and the transport has nowhere to put
    // it anyway.
    if (part.type !== "tool-result") return [];
    const result = toolResultContent(part.output, isModelImageMime);
    return [
      {
        role: "toolResult",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        content: result.content,
        isError: result.isError,
        timestamp: Date.now(),
      },
    ];
  });
}

export function toCodexContext(
  prompt: LanguageModelV4CallOptions["prompt"],
  tools: LanguageModelV4CallOptions["tools"],
  modelId: string,
  isModelImageMime: (mime: string) => boolean = mime => ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime),
): Context {
  const systems: string[] = [];
  const messages: Message[] = [];
  for (const message of prompt) {
    if (message.role === "system") {
      systems.push(message.content);
    } else if (message.role === "user") {
      messages.push({
        role: "user",
        content: message.content.map(part => userContentOf(part, isModelImageMime)),
        timestamp: Date.now(),
      });
    } else if (message.role === "assistant") {
      messages.push(assistantOf(message, modelId));
    } else {
      messages.push(...toolResultsOf(message, isModelImageMime));
    }
  }

  const codexTools: Tool[] = [];
  for (const tool of tools ?? []) {
    if (tool.type !== "function") {
      throw new Error(`OpenAI subscription does not support provider tool ${tool.id}`);
    }
    codexTools.push({
      name: tool.name,
      description: tool.description ?? "",
        parameters: tool.inputSchema,
    });
  }

  return {
    ...(systems.length > 0 ? { systemPrompt: systems.join("\n\n") } : {}),
    messages,
    ...(codexTools.length > 0 ? { tools: codexTools } : {}),
  };
}

function optionsOf(
  options: LanguageModelV4CallOptions,
  accessToken: string,
  defaultTransport: OpenAISubscriptionModelOptions["transport"],
  signal?: AbortSignal,
): ProviderStreamOptions {
  const provider = (options.providerOptions?.[PROVIDER] ?? {}) as SubscriptionProviderOptions;
  const reasoning =
    options.reasoning === undefined || options.reasoning === "provider-default"
      ? undefined
      : options.reasoning;
  return {
    apiKey: accessToken,
    signal: signal ?? options.abortSignal,
    maxTokens: options.maxOutputTokens,
    temperature: options.temperature,
    stop: options.stopSequences,
    headers: Object.fromEntries(
      Object.entries(options.headers ?? {}).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string",
      ),
    ),
    reasoningEffort: reasoning ?? provider.reasoningEffort,
    reasoningSummary: provider.reasoningSummary ?? "auto",
    serviceTier: provider.serviceTier,
    textVerbosity: provider.textVerbosity ?? "low",
    transport: provider.transport ?? defaultTransport ?? "sse",
    cacheRetention: provider.cacheRetention ?? "short",
    promptCacheKey: provider.promptCacheKey,
    sessionId: provider.sessionId,
    maxRetries: 0,
  };
}

function warningsOf(options: LanguageModelV4CallOptions): SharedV4Warning[] {
  const warnings: SharedV4Warning[] = [];
  const unsupported: Array<[string, unknown]> = [
    // The public Codex option type includes these two, but its ChatGPT
    // Responses request builder does not currently serialize either field.
    ["maxOutputTokens", options.maxOutputTokens],
    ["temperature", options.temperature],
    ["stopSequences", options.stopSequences],
    ["topP", options.topP],
    ["topK", options.topK],
    ["presencePenalty", options.presencePenalty],
    ["frequencyPenalty", options.frequencyPenalty],
    ["seed", options.seed],
    ["responseFormat", options.responseFormat?.type === "json" ? options.responseFormat : undefined],
  ];
  for (const [feature, value] of unsupported) {
    if (value !== undefined) warnings.push({ type: "unsupported", feature });
  }
  if (options.toolChoice && options.toolChoice.type !== "auto") {
    warnings.push({
      type: "unsupported",
      feature: "toolChoice",
      details: "The Codex ChatGPT Responses transport currently sends automatic tool choice.",
    });
  }
  return warnings;
}

function usageOf(usage: Usage): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: usage.input + usage.cacheRead + usage.cacheWrite,
      noCache: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
    },
    outputTokens: { total: usage.output, text: undefined, reasoning: undefined },
  };
}

function finishReasonOf(reason: AssistantMessage["stopReason"]): LanguageModelV4FinishReason {
  const unified =
    reason === "stop"
      ? "stop"
      : reason === "length"
        ? "length"
        : reason === "toolUse"
          ? "tool-calls"
          : "error";
  return { unified, raw: reason };
}

function partMetadata(part: AssistantMessage["content"][number]): SharedV4ProviderMetadata | undefined {
  if (part.type === "thinking" && part.thinkingSignature) {
    return { [PROVIDER]: { thinkingSignature: part.thinkingSignature } };
  }
  if (part.type === "toolCall" && part.thoughtSignature) {
    return { [PROVIDER]: { thoughtSignature: part.thoughtSignature } };
  }
  return undefined;
}

function contentOf(message: AssistantMessage): LanguageModelV4Content[] {
  return message.content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "thinking") {
      return {
        type: "reasoning",
        text: part.thinking,
        ...(partMetadata(part) ? { providerMetadata: partMetadata(part) } : {}),
      };
    }
    return {
      type: "tool-call",
      toolCallId: part.id,
      toolName: part.name,
      input: JSON.stringify(part.arguments),
      ...(partMetadata(part) ? { providerMetadata: partMetadata(part) } : {}),
    };
  });
}

function transportMetadata(): SharedV4ProviderMetadata {
  return { [PROVIDER]: { transport: "codex-responses", api: API } };
}

function generateResult(message: AssistantMessage, warnings: SharedV4Warning[]): LanguageModelV4GenerateResult {
  return {
    content: contentOf(message),
    finishReason: finishReasonOf(message.stopReason),
    usage: usageOf(message.usage),
    providerMetadata: transportMetadata(),
    response: {
      id: message.responseId,
      modelId: message.responseModel ?? message.model,
      timestamp: new Date(message.timestamp),
    },
    warnings,
  };
}

function indexedPart(event: AssistantMessageEvent) {
  if (!("contentIndex" in event) || !("partial" in event) || !event.partial) return undefined;
  return event.partial.content[event.contentIndex];
}

function streamParts(event: AssistantMessageEvent): LanguageModelV4StreamPart[] {
  const index = "contentIndex" in event ? event.contentIndex : 0;
  const id = `${event.type.startsWith("thinking") ? "reasoning" : event.type.startsWith("toolcall") ? "tool" : "text"}-${index}`;
  switch (event.type) {
    case "start":
      return [
        {
          type: "response-metadata",
          modelId: event.partial.responseModel ?? event.partial.model,
          timestamp: new Date(event.partial.timestamp),
        },
      ];
    case "text_start":
      return [{ type: "text-start", id }];
    case "text_delta":
      return [{ type: "text-delta", id, delta: event.delta }];
    case "text_end":
      return [{ type: "text-end", id }];
    case "thinking_start":
      return [{ type: "reasoning-start", id }];
    case "thinking_delta":
      return [{ type: "reasoning-delta", id, delta: event.delta }];
    case "thinking_end": {
      const part = indexedPart(event);
      return [
        {
          type: "reasoning-end",
          id,
          ...(part && partMetadata(part) ? { providerMetadata: partMetadata(part) } : {}),
        },
      ];
    }
    case "toolcall_start": {
      const part = indexedPart(event);
      if (!part || part.type !== "toolCall") return [];
      return [{ type: "tool-input-start", id: part.id, toolName: part.name }];
    }
    case "toolcall_delta": {
      const part = indexedPart(event);
      return part?.type === "toolCall"
        ? [{ type: "tool-input-delta", id: part.id, delta: event.delta }]
        : [];
    }
    case "toolcall_end":
      return [
        { type: "tool-input-end", id: event.toolCall.id },
        {
          type: "tool-call",
          toolCallId: event.toolCall.id,
          toolName: event.toolCall.name,
          input: JSON.stringify(event.toolCall.arguments),
          ...(partMetadata(event.toolCall)
            ? { providerMetadata: partMetadata(event.toolCall) }
            : {}),
        },
      ];
    case "done":
      return [
        ...(event.message.responseId
          ? [{ type: "response-metadata" as const, id: event.message.responseId }]
          : []),
        {
          type: "finish",
          usage: usageOf(event.message.usage),
          finishReason: finishReasonOf(event.message.stopReason),
          providerMetadata: transportMetadata(),
        },
      ];
    case "error":
      return [
        ...(event.error.responseId
          ? [{ type: "response-metadata" as const, id: event.error.responseId }]
          : []),
        { type: "error", error: new Error(event.error.errorMessage ?? event.reason) },
        {
          type: "finish",
          usage: usageOf(event.error.usage),
          finishReason: finishReasonOf(event.error.stopReason),
          providerMetadata: transportMetadata(),
        },
      ];
  }
}

export function createOpenAISubscriptionModel(
  config: OpenAISubscriptionModelOptions,
): LanguageModelV4 {
  if (!config.accessToken) throw new Error("OpenAI subscription access token is required");
  const runtime = config.runtime ?? new CodexClient(config);
  const model = codexModel(config.modelId);

  return {
    specificationVersion: "v4",
    provider: PROVIDER,
    modelId: config.modelId,
    supportedUrls: {},

    async doGenerate(options) {
      const message = await runtime.complete(
        model,
        toCodexContext(options.prompt, options.tools, config.modelId, config.isModelImageMime),
        optionsOf(options, config.accessToken, config.transport),
      );
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new Error(message.errorMessage ?? `OpenAI subscription ${message.stopReason}`);
      }
      return generateResult(message, warningsOf(options));
    },

    async doStream(options) {
      const cancellation = new AbortController();
      const signal = options.abortSignal
        ? AbortSignal.any([options.abortSignal, cancellation.signal])
        : cancellation.signal;
      const source = runtime.stream(
        model,
        toCodexContext(options.prompt, options.tools, config.modelId, config.isModelImageMime),
        optionsOf(options, config.accessToken, config.transport, signal),
      );
      const warnings = warningsOf(options);

      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings });
            try {
              for await (const event of source) {
                for (const part of streamParts(event)) controller.enqueue(part);
              }
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          },
          cancel() {
            cancellation.abort();
          },
        }),
      };
    },
  };
}
