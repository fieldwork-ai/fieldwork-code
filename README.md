# @fieldwork-ai/codex-transport

A ChatGPT subscription transport for AI SDK `LanguageModelV4`, with device-code and browser PKCE OAuth, allowance reads, and refresh leases. Protocol behavior is ported from [OpenAI Codex](https://github.com/openai/codex), under Apache-2.0. The pinned upstream revision and source paths are in `NOTICE`.

Requires Node 24. Install with `pnpm add @fieldwork-ai/codex-transport`.

```ts
import { createOpenAISubscriptionModel } from '@fieldwork-ai/codex-transport';

const model = createOpenAISubscriptionModel({
  modelId: 'gpt-5.6-luna',
  accessToken: credential.accessToken,
  accountId: credential.accountId,
  attribution: { originator: 'your-app', userAgent: 'your-app/1.0' },
});
```

Pass the model to the AI SDK's `generateText` or `streamText`. Subscription credentials belong to the individual using the client. This package does not store credentials or provide a shared proxy. Every network entry point requires caller attribution; it never pretends to be the Codex CLI.

`createOpenAISubscriptionModel` projects messages into a portable context and uses `CodexClient.complete` / `stream`. The client follows Codex's Responses request contract: account and attribution headers, session and thread headers, model/tier routing, encrypted reasoning replay, `store: false`, and zstd compression. SSE is the default, including `transport: 'auto'`; explicit `transport: 'websocket'` uses the same event decoder over Responses WebSockets. Requests can be aborted with the SDK's `abortSignal`. The `provider` identity remains `openai-subscription`, including reasoning metadata saved by earlier clients.

Optional client settings are `fedramp`, `responsesLite`, `compression`, `baseUrl`, and `fetchFn`. Responses-lite emits stable per-thread prefix IDs, puts tools into an `additional_tools` item, and moves instructions into the input. It is opt-in. No conversation history or tool execution loop lives here.

Images default to PNG, JPEG, GIF and WebP; callers can narrow this with `isModelImageMime`. Unsupported files, foreign reasoning, and provider-specific content degrade without throwing on a stored conversation. URLs are never fetched during projection.

For OAuth, use `requestOpenAIDeviceAuthorization`, `pollOpenAIDeviceAuthorization`, and `exchangeOpenAIDeviceAuthorization`, or `loginOpenAISubscriptionDeviceCode` for the complete polling flow. Browser clients use `beginOpenAIBrowserAuthorization` and `exchangeOpenAIBrowserAuthorization`; the caller owns the listener at `http://localhost:1455/auth/callback` and securely retains the returned PKCE verifier and state until exchange. OAuth calls validate callback state, constrain destinations, bound response bodies, and redact provider errors.

`refreshWithCredentialLease` coordinates refresh across an `OpenAISubscriptionRefreshStore`; `InMemoryOpenAISubscriptionRefreshStore` is provided. Database-backed callers implement `read`, `tryAcquire`, `commit`, and `release`, enforcing generation and lease ownership. Encrypt durable credentials in the application's store.

`fetchCodexUsage` returns normalized usage windows. `isOpenAISubscriptionUsageLimitError` recognizes the service's allowance error codes. Neither API requires the application's database or billing model.

## Development

`pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm test`. Tests cover message projection, OAuth, concurrent refresh, usage normalization, SSE decoding, request headers/compression, and authenticated WebSockets. Release by publishing this repository first; consumers must pin the published version, not a local path or patched dependency.
