import type { CodexErrorDetails } from "./client-types.js";

export type OpenAISubscriptionUsageLimitType = "usage_limit_reached" | "usage_not_included";

const USAGE_LIMIT_TYPES: readonly OpenAISubscriptionUsageLimitType[] = ["usage_limit_reached", "usage_not_included"];

// The message fallback exists for failures recorded before the transport
// carried details, and for callers that only kept the text.
const USAGE_LIMIT_PATTERNS = [
  /chatgpt usage limit/i,
  /usage_limit_reached/i,
  /usage_not_included/i,
];

export interface OpenAISubscriptionUsageLimit {
  type: OpenAISubscriptionUsageLimitType;
  resetsAt: Date | null;
}

function detailsOf(error: unknown): CodexErrorDetails | undefined {
  const details = (error as { details?: unknown } | null)?.details;
  return details && typeof details === "object" ? (details as CodexErrorDetails) : undefined;
}

/**
 * The allowance failure behind an error, or null when it is anything else.
 * Structured details win; the message text is consulted only without them.
 */
export function openAISubscriptionUsageLimit(error: unknown): OpenAISubscriptionUsageLimit | null {
  const details = detailsOf(error);
  if (details) {
    const type = USAGE_LIMIT_TYPES.find((candidate) => candidate === details.type);
    if (!type) return null;
    return { type, resetsAt: details.resetsAt !== undefined ? new Date(details.resetsAt * 1000) : null };
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(message))) return null;
  return { type: /usage_not_included/i.test(message) ? "usage_not_included" : "usage_limit_reached", resetsAt: null };
}

export function isOpenAISubscriptionUsageLimitError(error: unknown): boolean {
  return openAISubscriptionUsageLimit(error) !== null;
}
