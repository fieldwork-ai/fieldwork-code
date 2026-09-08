
/** Ledger identity for inference paid for by a user's ChatGPT subscription. */
export const OPENAI_SUBSCRIPTION_PROVIDER = "openai-subscription" as const;

/**
 * Codex OAuth exposes a 400k total window split into 272k input and 128k
 * output. The input limit is the one conversation history and auto-compaction
 * must respect; the total window is what bounds a request plus its response.
 * Keep these together: OpenCode applies the same override to GPT-5.5/5.6
 * models authenticated through Codex OAuth.
 */
export const OPENAI_SUBSCRIPTION_CONTEXT_WINDOW_TOKENS = 400_000;
export const OPENAI_SUBSCRIPTION_INPUT_LIMIT_TOKENS = 272_000;
export const OPENAI_SUBSCRIPTION_MAX_OUTPUT_TOKENS = 128_000;


export const OPENAI_SUBSCRIPTION_MODEL_ID_LIST = [
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

export type OpenAISubscriptionModelId =
  (typeof OPENAI_SUBSCRIPTION_MODEL_ID_LIST)[number];

export const OPENAI_SUBSCRIPTION_MODEL_IDS: ReadonlySet<string> = new Set(
  OPENAI_SUBSCRIPTION_MODEL_ID_LIST,
);

