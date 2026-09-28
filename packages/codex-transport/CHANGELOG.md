# 0.1.7

Keep the whole reasoning summary when a completion event carries more than the stream did. Once a partial delta (such as a section heading) had arrived, the fuller text in `response.reasoning_summary_text.done`, `response.reasoning_summary_part.done` or the completed output item was ignored, so the summary stopped at the heading. Completed text now extends the streamed prefix by exactly its missing suffix; text that does not extend it is ignored rather than duplicated or rewritten.

# 0.1.6

Separate reasoning summary sections with a blank line. The Responses API streams a summary as numbered sections (`summary_index`) that carry no separator of their own, so every section after the first ran onto the end of the one before it, and the fallback for an unstreamed summary joined sections with a single newline, which markdown also renders as one paragraph.

# 0.1.5

Route `gpt-6-sol` and `gpt-6-luna` through the ChatGPT subscription. They succeed GPT-5.6 Sol and Luna, which stay listed for conversations still pinned to them.

# 0.1.4

Carry the Codex backend's error details (`status`, `code`, `type`, `plan_type`, `resets_at`) on failures as `AssistantMessage.errorDetails`, `CodexRequestError` and the AI SDK-facing `OpenAISubscriptionError`. An exhausted ChatGPT allowance (HTTP 429 with type `usage_limit_reached`) was previously flattened to `Codex request failed with HTTP 429`, indistinguishable from an ordinary rate limit; `isOpenAISubscriptionUsageLimitError` now reads the type, and the new `openAISubscriptionUsageLimit` returns it with the reset time.

# 0.1.3

Offer Fieldwork AI code under MIT or Apache-2.0 and include both license texts in package distributions. Retain Apache-2.0 terms and attribution for the OpenAI-derived Codex transport implementation.

# 0.1.2

Move to `packages/codex-transport` in the public `fieldwork-ai/fieldwork-code` monorepo. Update repository metadata; protocol behavior is unchanged.
