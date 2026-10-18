import { describe, expect, it, vi } from "vitest";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { AssistantMessage, AssistantMessageEvent, CodexRuntime, ProviderStreamOptions } from "../src/client-types.js";
import { createOpenAISubscriptionModel, OpenAISubscriptionError } from "../src/language-model.js";

const ATTRIBUTION = { originator: "test-client", userAgent: "test-client/1" };
const CALL: LanguageModelV4CallOptions = { prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
const EMPTY = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return { role: "assistant", content: [], api: "openai-chatgpt-responses", provider: "openai", model: "gpt-6.1-sol", usage: EMPTY, stopReason: "stop", timestamp: 0, ...overrides };
}

const refused = (token: string) => message({ stopReason: "error", errorMessage: `Codex request failed with HTTP 401 (${token})`, errorDetails: { status: 401 } });

function answer(text: string): AssistantMessageEvent[] {
  const done = message({ content: [{ type: "text", text }] });
  return [
    { type: "start", partial: message() },
    { type: "text_start", contentIndex: 0, partial: done },
    { type: "text_delta", contentIndex: 0, delta: text, partial: done },
    { type: "text_end", contentIndex: 0, content: text, partial: done },
    { type: "done", reason: "stop", message: done },
  ];
}

/** A backend that accepts only `valid`, answering with the text it was sent. */
function backend(valid: (token: string) => boolean) {
  const sent: string[] = [];
  const runtime: CodexRuntime = {
    async complete(_model, _context, options: ProviderStreamOptions = {}) {
      sent.push(options.apiKey!);
      return valid(options.apiKey!) ? message({ content: [{ type: "text", text: `as ${options.apiKey}` }] }) : refused(options.apiKey!);
    },
    async *stream(_model, _context, options: ProviderStreamOptions = {}) {
      sent.push(options.apiKey!);
      if (valid(options.apiKey!)) yield* answer(`as ${options.apiKey}`);
      else yield { type: "error", reason: "error", error: refused(options.apiKey!) };
    },
  };
  return { runtime, sent };
}

async function read(stream: ReadableStream<LanguageModelV4StreamPart>) {
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) return parts;
    parts.push(next.value);
  }
}

const text = (parts: LanguageModelV4StreamPart[]) => parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("");
const errors = (parts: LanguageModelV4StreamPart[]) => parts.flatMap((part) => (part.type === "error" ? [part.error] : []));

describe("a refused access token", () => {
  it("is renewed once and the request sent again, and later calls keep the renewed token", async () => {
    const { runtime, sent } = backend((token) => token === "fresh");
    const renewAccessToken = vi.fn(async () => "fresh");
    const model = createOpenAISubscriptionModel({ attribution: ATTRIBUTION, accessToken: "revoked", modelId: "gpt-6.1-sol", runtime, renewAccessToken });

    const parts = await read((await model.doStream(CALL)).stream);
    expect(errors(parts)).toEqual([]);
    expect(text(parts)).toBe("as fresh");
    expect(renewAccessToken).toHaveBeenCalledExactlyOnceWith("revoked");

    await read((await model.doStream(CALL)).stream);
    expect(sent).toEqual(["revoked", "fresh", "fresh"]);
    expect(renewAccessToken).toHaveBeenCalledOnce();
  });

  it("fails with the renewal's own error when the renewal is refused", async () => {
    const { runtime, sent } = backend(() => false);
    const rejection = new Error("Your ChatGPT connection needs to be reconnected");
    const model = createOpenAISubscriptionModel({ attribution: ATTRIBUTION, accessToken: "revoked", modelId: "gpt-6.1-sol", runtime, renewAccessToken: async () => { throw rejection; } });

    const parts = await read((await model.doStream(CALL)).stream);
    expect(errors(parts)).toEqual([rejection]);
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "error" } });
    expect(sent).toEqual(["revoked"]);
  });

  it("is not renewed twice in one call when the renewed token is refused too", async () => {
    const { runtime, sent } = backend(() => false);
    const renewAccessToken = vi.fn(async () => "also-refused");
    const model = createOpenAISubscriptionModel({ attribution: ATTRIBUTION, accessToken: "revoked", modelId: "gpt-6.1-sol", runtime, renewAccessToken });

    const parts = await read((await model.doStream(CALL)).stream);
    expect(errors(parts)).toEqual([expect.objectContaining({ details: { status: 401 } })]);
    expect(renewAccessToken).toHaveBeenCalledOnce();
    expect(sent).toEqual(["revoked", "also-refused"]);
  });

  it("is never renewed once the response has started", async () => {
    const renewAccessToken = vi.fn(async () => "fresh");
    const runtime = {
      async *stream() {
        yield { type: "start", partial: message() } satisfies AssistantMessageEvent;
        yield { type: "error", reason: "error", error: refused("revoked") } satisfies AssistantMessageEvent;
      },
    } as unknown as CodexRuntime;
    const model = createOpenAISubscriptionModel({ attribution: ATTRIBUTION, accessToken: "revoked", modelId: "gpt-6.1-sol", runtime, renewAccessToken });

    expect(errors(await read((await model.doStream(CALL)).stream))).toHaveLength(1);
    expect(renewAccessToken).not.toHaveBeenCalled();
  });

  it("surfaces as before when the caller offers no renewal", async () => {
    const { runtime, sent } = backend(() => false);
    const model = createOpenAISubscriptionModel({ attribution: ATTRIBUTION, accessToken: "revoked", modelId: "gpt-6.1-sol", runtime });

    expect(errors(await read((await model.doStream(CALL)).stream))).toEqual([expect.objectContaining({ details: { status: 401 } })]);
    expect(sent).toEqual(["revoked"]);
  });

  it("is renewed for a generate call too", async () => {
    const { runtime, sent } = backend((token) => token === "fresh");
    const model = createOpenAISubscriptionModel({ attribution: ATTRIBUTION, accessToken: "revoked", modelId: "gpt-6.1-sol", runtime, renewAccessToken: async () => "fresh" });

    const result = await model.doGenerate(CALL);
    expect(result.content).toEqual([{ type: "text", text: "as fresh" }]);
    expect(sent).toEqual(["revoked", "fresh"]);

    const refusedTwice = createOpenAISubscriptionModel({ attribution: ATTRIBUTION, accessToken: "revoked", modelId: "gpt-6.1-sol", runtime: backend(() => false).runtime, renewAccessToken: async () => "also-refused" });
    await expect(refusedTwice.doGenerate(CALL)).rejects.toBeInstanceOf(OpenAISubscriptionError);
  });
});
