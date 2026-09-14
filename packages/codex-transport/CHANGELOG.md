# 0.1.4

Carry the Codex backend's error details (`status`, `code`, `type`, `plan_type`, `resets_at`) on failures as `AssistantMessage.errorDetails`, `CodexRequestError` and the AI SDK-facing `OpenAISubscriptionError`. An exhausted ChatGPT allowance (HTTP 429 with type `usage_limit_reached`) was previously flattened to `Codex request failed with HTTP 429`, indistinguishable from an ordinary rate limit; `isOpenAISubscriptionUsageLimitError` now reads the type, and the new `openAISubscriptionUsageLimit` returns it with the reset time.

# 0.1.3

Offer Fieldwork AI code under MIT or Apache-2.0 and include both license texts in package distributions. Retain Apache-2.0 terms and attribution for the OpenAI-derived Codex transport implementation.

# 0.1.2

Move to `packages/codex-transport` in the public `fieldwork-ai/fieldwork-code` monorepo. Update repository metadata; protocol behavior is unchanged.
