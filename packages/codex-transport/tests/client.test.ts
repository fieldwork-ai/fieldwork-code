import { describe, expect, it } from "vitest";
import { zstdDecompressSync } from "node:zlib";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { buildCodexRequest, CodexClient, normalizeCodexBaseUrl, responsesInput } from "../src/client.js";
import { beginOpenAIBrowserAuthorization, exchangeOpenAIBrowserAuthorization } from "../src/oauth.js";
import type { Model } from "../src/client-types.js";
import { createOpenAISubscriptionModel } from "../src/language-model.js";
const config = { attribution: { originator: "test-client", userAgent: "test-client/1" }, accountId: "account-test" };
const model: Model = { id: "gpt-5.6-luna", name: "test", api: "openai-chatgpt-responses", provider: "openai", baseUrl: "https://chatgpt.com", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 128000 };
const context = { systemPrompt: "Be helpful", messages: [{ role: "user" as const, content: "Hello", timestamp: 1 }] };
const completion = { type: "response.completed", response: { id: "resp-test", usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 5 } } };
function eventResponse(events: unknown[]) { return new Response(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("")); }
describe("completed reasoning summaries", () => {
  const heading = "**Checking the implementation**";
  const full = `${heading}\n\nThe summary body is preserved.`;
  const added = { type: "response.output_item.added", item: { id: "rs_1", type: "reasoning" } };
  const delta = (text: string, summary_index = 0) => ({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index, delta: text });
  const textDone = (text: string, summary_index = 0) => ({ type: "response.reasoning_summary_text.done", item_id: "rs_1", summary_index, text });
  const partDone = (text: string, summary_index = 0) => ({ type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index, part: { type: "summary_text", text } });
  const itemDone = (...texts: string[]) => ({ type: "response.output_item.done", item: { id: "rs_1", type: "reasoning", encrypted_content: "opaque", summary: texts.map(text => ({ type: "summary_text", text })) } });

  it.each([
    { name: "partial delta then full output item", events: [added, delta(heading), itemDone(full)], expected: full },
    { name: "partial delta then text completion", events: [added, delta(heading), textDone(full)], expected: full },
    { name: "partial delta then part completion", events: [added, delta(heading), partDone(full)], expected: full },
    { name: "repeated completion events", events: [added, delta(heading), textDone(full), textDone(full), partDone(full), itemDone(full)], expected: full },
    { name: "fully streamed summary", events: [added, delta(heading), delta(full.slice(heading.length)), textDone(full), partDone(full), itemDone(full)], expected: full },
    { name: "completed item without deltas", events: [itemDone(full)], expected: full },
    { name: "completed text without deltas", events: [added, textDone(full), itemDone(full)], expected: full },
    { name: "multiple indexed summaries", events: [added, delta(heading), textDone(full), delta("Next", 1), textDone("Next section.", 1), partDone("Next section.", 1), itemDone(full, "Next section.")], expected: `${full}\nNext section.` },
    { name: "final item supplies remaining summaries", events: [added, delta(full), itemDone(full, "Next section.")], expected: `${full}\nNext section.` },
    { name: "empty final summary retains streamed content", events: [added, delta(full), itemDone()], expected: full },
    { name: "conflicting final text does not duplicate or rewrite the stream", events: [added, delta(full), textDone("Different summary"), itemDone("Different summary")], expected: full },
  ])("preserves live and final text: $name", async ({ events, expected }) => {
    const fetchFn = async () => eventResponse([...events, completion]);
    const client = new CodexClient({ ...config, fetchFn });
    let streamed = "";
    let ended = "";
    for await (const event of client.stream(model, context, { apiKey: "secret" })) {
      if (event.type === "thinking_delta") streamed += event.delta;
      if (event.type === "thinking_end") ended = event.content;
      if (event.type === "error") throw new Error(event.error.errorMessage);
      if (event.type === "done") {
        expect(event.message.content).toContainEqual(expect.objectContaining({ type: "thinking", thinking: expected }));
        const finalItem = events.findLast(event => event.type === "response.output_item.done");
        if (finalItem && "item" in finalItem) expect(responsesInput({ messages: [event.message] })).toContainEqual(finalItem.item);
      }
    }
    expect(streamed).toBe(expected);
    expect(ended).toBe(expected);

    const sdk = createOpenAISubscriptionModel({ ...config, fetchFn, accessToken: "secret", modelId: model.id });
    const { stream } = await sdk.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] });
    const reader = stream.getReader();
    let sdkText = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.type === "error") throw value.error;
      if (value.type === "reasoning-delta") sdkText += value.delta;
    }
    expect(sdkText).toBe(expected);
  });
});

describe("Codex Rust protocol contract", () => {
  it("normalizes backend URLs and emits canonical attribution, routing, session and compression headers", () => {
    const request = buildCodexRequest(model, context, { apiKey: "secret", sessionId: "session", threadId: "thread", serviceTier: "priority" }, { ...config, fedramp: true });
    expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(Object.fromEntries(request.headers)).toMatchObject({ authorization: "Bearer secret", "chatgpt-account-id": "account-test", originator: "test-client", "user-agent": "test-client/1", "session-id": "session", "thread-id": "thread", "x-client-request-id": "thread", "x-codex-routing-hint": "model=gpt-5.6-luna;tier=priority", "x-openai-fedramp": "true", "content-encoding": "zstd" });
    expect(JSON.parse(zstdDecompressSync(request.body as Uint8Array).toString())).toEqual(request.payload);
    expect(request.payload).toMatchObject({ store: false, stream: true, instructions: "Be helpful", include: ["reasoning.encrypted_content"], prompt_cache_key: "session" });
    expect(normalizeCodexBaseUrl("https://chatgpt.com/backend-api/")).toBe("https://chatgpt.com/backend-api/codex");
    expect(() => normalizeCodexBaseUrl("http://evil.example")).toThrow("HTTPS");
  });
  it("gives responses-lite prefixes stable IDs within a thread", () => {
    const request = buildCodexRequest(model, context, { apiKey: "secret", sessionId: "session" }, { ...config, responsesLite: true });
    expect(request.headers.get("x-openai-internal-codex-responses-lite")).toBe("true");
    expect(request.payload.instructions).toBe("");
    expect(request.payload).not.toHaveProperty("tools");
    expect(request.payload.input[0]).toMatchObject({ type: "additional_tools", role: "developer", id: expect.stringMatching(/^at_/) });
    expect(request.payload.input[1]).toMatchObject({ role: "developer", id: expect.stringMatching(/^msg_/) });
    expect(buildCodexRequest(model, context, { apiKey: "secret", sessionId: "session" }, { ...config, responsesLite: true }).payload.input).toEqual(request.payload.input);
  });
  it("streams text, reasoning signatures, tool arguments and usage through one vocabulary", async () => {
    const signature = { id: "rs_1", type: "reasoning", encrypted_content: "opaque", summary: [{ type: "summary_text", text: "Thinking" }] };
    const client = new CodexClient({ ...config, fetchFn: async () => eventResponse([
      { type: "response.created", response: { id: "resp-test", model: model.id } },
      { type: "response.output_item.added", item: { id: "rs_1", type: "reasoning" } },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "Thinking" },
      { type: "response.output_item.done", item: signature },
      { type: "response.output_text.delta", item_id: "msg_1", content_index: 0, delta: "Hello" },
      { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "read" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":"a"}' },
      { type: "response.output_item.done", item: { id: "fc_1", type: "function_call", arguments: '{"path":"a"}' } }, completion,
    ]) });
    const events = [];
    for await (const event of client.stream(model, context, { apiKey: "secret" })) events.push(event);
    expect(events.map(event => event.type)).toEqual(["start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "toolcall_start", "toolcall_delta", "toolcall_end", "text_end", "done"]);
    const result = events.at(-1)!;
    expect(result.type).toBe("done");
    if (result.type !== "done") throw new Error("expected completion");
    expect(result.message.usage).toMatchObject({ input: 20, cacheRead: 80, output: 5, totalTokens: 105 });
    expect(result.message.stopReason).toBe("toolUse");
    expect(responsesInput({ messages: [result.message] })).toContainEqual(signature);
    expect(result.message.content).toContainEqual({ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } });
  });
  it("carries the backend's error type and reset time through an HTTP failure", async () => {
    const body = { error: { type: "usage_limit_reached", plan_type: "pro", resets_at: 1_760_000_000 } };
    const client = new CodexClient({ ...config, fetchFn: async () => new Response(JSON.stringify(body), { status: 429 }) });
    const result = await client.complete(model, context, { apiKey: "secret" });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Codex request failed with HTTP 429 (usage_limit_reached)");
    expect(result.errorDetails).toEqual({ status: 429, type: "usage_limit_reached", planType: "pro", resetsAt: 1_760_000_000 });

    const throttled = new CodexClient({ ...config, fetchFn: async () => new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), { status: 429 }) });
    const limited = await throttled.complete(model, context, { apiKey: "secret" });
    expect(limited.errorMessage).toBe("Codex request failed with HTTP 429 (rate_limit_exceeded)");
    expect(limited.errorDetails).toEqual({ status: 429, code: "rate_limit_exceeded" });

    const opaque = new CodexClient({ ...config, fetchFn: async () => new Response("upstream error", { status: 502 }) });
    expect((await opaque.complete(model, context, { apiKey: "secret" })).errorDetails).toEqual({ status: 502 });
  });
  it("reports truncation and allowance errors without claiming completion", async () => {
    for (const events of [[], [{ type: "response.failed", response: { error: { code: "usage_limit_reached", message: "Allowance exhausted" } } }]]) {
      const client = new CodexClient({ ...config, fetchFn: async () => eventResponse(events) });
      const result = await client.complete(model, context, { apiKey: "secret" });
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toMatch(/response.completed|usage_limit_reached/);
    }
  });
  it("uses the same decoder over an authenticated WebSocket", async () => {
    const server = createServer();
    const ws = new WebSocketServer({ server });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    let headers: Record<string, unknown> = {};
    let request: Record<string, unknown> = {};
    ws.on("connection", (socket, incoming) => {
      headers = incoming.headers;
      socket.on("message", bytes => { request = JSON.parse(bytes.toString()); socket.send(JSON.stringify({ type: "response.output_text.delta", item_id: "msg", delta: "Hello" })); socket.send(JSON.stringify(completion)); });
    });
    try {
      const client = new CodexClient({ ...config, baseUrl: `http://127.0.0.1:${address.port}` });
      const result = await client.complete(model, context, { apiKey: "secret", transport: "websocket" });
      expect(result.stopReason).toBe("stop");
      expect(headers).toMatchObject({ authorization: "Bearer secret", originator: "test-client", "openai-beta": "responses_websockets=2026-02-06" });
      expect(request).toMatchObject({ type: "response.create", model: model.id, store: false });
      expect(request).not.toHaveProperty("stream");
    } finally { for (const socket of ws.clients) socket.terminate(); await new Promise<void>(resolve => ws.close(() => server.close(() => resolve()))); }
  });
  it("binds browser OAuth to a random state, PKCE and the loopback callback", async () => {
    const authorization = beginOpenAIBrowserAuthorization(config);
    const url = new URL(authorization.authorizationUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("originator")).toBe("test-client");
    await expect(exchangeOpenAIBrowserAuthorization(authorization, `${authorization.redirectUri}?state=wrong&code=a`, config)).rejects.toThrow("state mismatch");
    await expect(exchangeOpenAIBrowserAuthorization(authorization, `https://evil.example/?state=${authorization.state}&code=a`, config)).rejects.toThrow("Unexpected OAuth callback");
  });
});

it("accepts authoritative output items when the service omits deltas", async () => {
  const client = new CodexClient({ ...config, fetchFn: async () => eventResponse([
    { type: "response.output_item.done", item: { type: "message", id: "msg_1", content: [{ type: "output_text", text: "Done" }] } },
    { type: "response.output_item.done", item: { type: "reasoning", id: "rs_1", encrypted_content: "cipher", summary: [{ type: "summary_text", text: "Thought" }] } },
    { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"a"}' } }, completion,
  ]) });
  const result = await client.complete(model, context, { apiKey: "secret" });
  expect(result.stopReason).toBe("toolUse");
  expect(result.content).toContainEqual({ type: "text", text: "Done" });
  expect(result.content).toContainEqual(expect.objectContaining({ type: "thinking", thinking: "Thought" }));
  expect(result.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "read", arguments: { path: "a" } }));
});
