const FIELDWORK_ATTRIBUTION = { originator: "fieldwork", userAgent: "fieldwork/0.1.0", version: "0.1.0" };
import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  CodexRuntime,
  ProviderStreamOptions,
  Usage,
} from "../src/client-types.js";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import {
  createOpenAISubscriptionModel,
  toCodexContext,
} from "../src/language-model.js";

const CALL_OPTIONS: LanguageModelV4CallOptions = {
  prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

const USAGE: Usage = {
  input: 100,
  cacheRead: 70,
  cacheWrite: 20,
  output: 30,
  totalTokens: 220,
  cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
};

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "openai-chatgpt-responses",
    provider: "openai",
    model: "gpt-5.6-luna",
    usage: USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
    responseId: "resp-final",
    ...overrides,
  };
}

function runtimeFor(events: AssistantMessageEvent[], completed = message()): CodexRuntime {
  return {
    complete: async () => completed,
    stream: () =>
      (async function* () {
        for (const event of events) yield event;
      })(),
  } as unknown as CodexRuntime;
}

function runtimeCapturingOptions(capture: (options: ProviderStreamOptions) => void): CodexRuntime {
  return {
    complete: async (
      _model: unknown,
      _context: unknown,
      options: ProviderStreamOptions,
    ) => {
      capture(options);
      return message();
    },
  } as unknown as CodexRuntime;
}

async function streamParts(events: AssistantMessageEvent[]) {
  const model = createOpenAISubscriptionModel({ attribution: FIELDWORK_ATTRIBUTION,
    accessToken: "token",
    modelId: "gpt-5.6-luna",
    runtime: runtimeFor(events),
  });
  const result = await model.doStream(CALL_OPTIONS);
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = result.stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
  }
  return parts;
}

describe("OpenAI subscription transport", () => {
  it("maps Codex uncached, read-cache, write-cache, and output usage independently", async () => {
    const model = createOpenAISubscriptionModel({ attribution: FIELDWORK_ATTRIBUTION,
      accessToken: "token",
      modelId: "gpt-5.6-luna",
      runtime: runtimeFor([], message()),
    });

    const result = await model.doGenerate(CALL_OPTIONS);

    expect(result.usage.inputTokens).toEqual({
      total: 190,
      noCache: 100,
      cacheRead: 70,
      cacheWrite: 20,
    });
    expect(result.usage.outputTokens.total).toBe(30);
    expect(result.response?.id).toBe("resp-final");
    expect(result.providerMetadata).not.toHaveProperty("fieldwork.provider");
  });

  it("forwards the Fast mode service tier to the ChatGPT transport", async () => {
    let received: ProviderStreamOptions | undefined;
    const model = createOpenAISubscriptionModel({ attribution: FIELDWORK_ATTRIBUTION,
      accessToken: "token",
      modelId: "gpt-5.6-sol",
      runtime: runtimeCapturingOptions((options) => {
        received = options;
      }),
    });

    await model.doGenerate({
      ...CALL_OPTIONS,
      providerOptions: { "openai-subscription": { serviceTier: "priority" } },
    });

    expect(received?.serviceTier).toBe("priority");
  });

  it("emits the final response id before a successful stream finish", async () => {
    const parts = await streamParts([
      { type: "start", partial: message({ responseId: undefined }) },
      { type: "done", reason: "stop", message: message() },
    ]);

    const metadataIndex = parts.findIndex(
      (part) => part.type === "response-metadata" && part.id === "resp-final",
    );
    const finishIndex = parts.findIndex((part) => part.type === "finish");
    expect(metadataIndex).toBeGreaterThanOrEqual(0);
    expect(metadataIndex).toBeLessThan(finishIndex);
    const finish = parts[finishIndex];
    expect(finish.type === "finish" && finish.usage.inputTokens).toEqual({
      total: 190,
      noCache: 100,
      cacheRead: 70,
      cacheWrite: 20,
    });
    expect(finish.type === "finish" && finish.providerMetadata).not.toHaveProperty(
      "fieldwork.provider",
    );
  });

  it("emits the final response id before a failed stream's terminal parts", async () => {
    const failed = message({
      stopReason: "error",
      errorMessage: "upstream failed",
      responseId: "resp-error",
    });
    const parts = await streamParts([
      { type: "start", partial: message({ responseId: undefined }) },
      { type: "error", reason: "error", error: failed },
    ]);

    const metadataIndex = parts.findIndex(
      (part) => part.type === "response-metadata" && part.id === "resp-error",
    );
    const errorIndex = parts.findIndex((part) => part.type === "error");
    const finishIndex = parts.findIndex((part) => part.type === "finish");
    expect(metadataIndex).toBeGreaterThanOrEqual(0);
    expect(metadataIndex).toBeLessThan(errorIndex);
    expect(metadataIndex).toBeLessThan(finishIndex);
  });

  it("projects V4 system, user, assistant reasoning, tool call, and tool result history", () => {
    const prompt: LanguageModelV4CallOptions["prompt"] = [
      { role: "system", content: "System one" },
      { role: "system", content: "System two" },
      { role: "user", content: [{ type: "text", text: "Calculate it" }] },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "",
            providerOptions: {
              "openai-subscription": { thinkingSignature: "encrypted-reasoning" },
            },
          },
          { type: "tool-call", toolCallId: "call-1", toolName: "add", input: { a: 1, b: 2 } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "add",
            output: { type: "json", value: { result: 3 } },
          },
        ],
      },
    ];

    const context = toCodexContext(
      prompt,
      [
        {
          type: "function",
          name: "add",
          description: "Add numbers",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
        },
      ],
      "gpt-5.6-luna",
    );

    expect(context.systemPrompt).toBe("System one\n\nSystem two");
    expect(context.messages).toHaveLength(3);
    expect(context.messages[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "thinking", thinkingSignature: "encrypted-reasoning" },
        { type: "toolCall", id: "call-1", name: "add", arguments: { a: 1, b: 2 } },
      ],
    });
    expect(context.messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "text", text: '{"result":3}' }],
    });
    expect(context.tools?.[0]).toMatchObject({ name: "add", description: "Add numbers" });
  });

  it("replays inline image tool results", () => {
    const context = toCodexContext(
      [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "read",
              output: {
                type: "content",
                value: [
                  {
                    type: "file",
                    data: { type: "data", data: "aW1hZ2U=" },
                    mediaType: "image/png",
                  },
                  { type: "text", text: "Image file (image/png)" },
                ],
              },
            },
          ],
        },
      ],
      undefined,
      "gpt-5.6-luna",
    );

    expect(context.messages[0]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      content: [
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        { type: "text", text: "Image file (image/png)" },
      ],
    });
  });

  it("degrades tool-result files the subscription transport cannot replay", () => {
    const context = toCodexContext(
      [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "read",
              output: {
                type: "content",
                value: [
                  {
                    type: "file",
                    data: { type: "data", data: "cGRm" },
                    mediaType: "application/pdf",
                    filename: "report.pdf",
                  },
                  { type: "text", text: "report.pdf (pages 1-2 of 2)" },
                ],
              },
            },
          ],
        },
      ],
      undefined,
      "gpt-5.6-luna",
    );

    expect(context.messages[0]).toMatchObject({
      role: "toolResult",
      content: [
        {
          type: "text",
          text: "[report.pdf (application/pdf) omitted: this model reads text and images only]",
        },
        { type: "text", text: "report.pdf (pages 1-2 of 2)" },
      ],
    });
  });

  it("projects inline image input without exposing or rewriting it", () => {
    const context = toCodexContext(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            {
              type: "file",
              mediaType: "image/png",
              data: { type: "data", data: "aW1hZ2U=" },
            },
          ],
        },
      ],
      undefined,
      "gpt-5.6-luna",
    );

    expect(context.messages[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      ],
    });
  });

  it("fails closed on provider tools the transport has not validated", () => {
    // The toolset is rebuilt from the assembler each turn rather than replayed
    // from storage, so throwing on it reports a misconfiguration without
    // stranding a conversation. Message content is the opposite case and
    // degrades instead — see openai-subscription-projection.test.ts.
    expect(() =>
      toCodexContext(
        [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        [{ type: "provider", id: "openai.web_search", name: "web_search", args: {} }],
        "gpt-5.6-luna",
      ),
    ).toThrow("does not support provider tool");
  });
});
