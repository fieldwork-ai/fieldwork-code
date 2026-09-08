import type { OpenAISubscriptionAttribution } from "./oauth.js";
export interface TextContent { type: "text"; text: string }
export interface ImageContent { type: "image"; data: string; mimeType: string }
export interface ThinkingContent { type: "thinking"; thinking: string; thinkingSignature?: string }
export interface ToolCall { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string }
export interface Usage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
export interface AssistantMessage {
  role: "assistant"; content: (TextContent | ThinkingContent | ToolCall)[];
  api: string; provider: string; model: string; usage: Usage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  timestamp: number; responseId?: string; responseModel?: string; errorMessage?: string;
}
export interface ToolResultMessage { role: "toolResult"; toolCallId: string; toolName: string; content: (TextContent | ImageContent)[]; isError: boolean; timestamp: number }
export type Message = AssistantMessage | ToolResultMessage | { role: "user"; content: string | (TextContent | ImageContent)[]; timestamp: number };
export interface Tool { name: string; description: string; parameters: Record<string, unknown> }
export interface Context { systemPrompt?: string; messages: Message[]; tools?: Tool[] }
export interface Model<T extends string = string> {
  id: string; name: string; api: T; provider: string; baseUrl: string; reasoning: boolean;
  thinkingLevelMap?: Record<string, string>; input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number; maxTokens: number;
}
export interface ProviderStreamOptions {
  apiKey?: string; signal?: AbortSignal; headers?: Record<string, string>;
  maxTokens?: number; temperature?: number; stop?: string[];
  reasoningEffort?: string; reasoningSummary?: string; serviceTier?: string; textVerbosity?: string;
  transport?: "sse" | "websocket" | "auto"; cacheRetention?: string; promptCacheKey?: string;
  sessionId?: string; threadId?: string; maxRetries?: number;
}
type Indexed = { contentIndex: number; partial: AssistantMessage };
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | ({ type: "text_start" | "thinking_start" | "toolcall_start" } & Indexed)
  | ({ type: "text_delta" | "thinking_delta" | "toolcall_delta"; delta: string } & Indexed)
  | ({ type: "text_end" | "thinking_end"; content: string } & Indexed)
  | ({ type: "toolcall_end"; toolCall: ToolCall } & Indexed)
  | { type: "done"; reason: AssistantMessage["stopReason"]; message: AssistantMessage }
  | { type: "error"; reason: string; error: AssistantMessage };
export interface CodexRuntime {
  complete(model: Model, context: Context, options?: ProviderStreamOptions): Promise<AssistantMessage>;
  stream(model: Model, context: Context, options?: ProviderStreamOptions): AsyncIterable<AssistantMessageEvent>;
}
export interface CodexClientOptions {
  attribution: OpenAISubscriptionAttribution;
  accountId?: string;
  fetchFn?: typeof fetch;
  baseUrl?: string;
  fedramp?: boolean;
  responsesLite?: boolean;
  compression?: boolean;
}
