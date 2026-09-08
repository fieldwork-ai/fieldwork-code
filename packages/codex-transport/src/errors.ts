const USAGE_LIMIT_PATTERNS = [
  /chatgpt usage limit/i,
  /usage_limit_reached/i,
  /usage_not_included/i,
];

export function isOpenAISubscriptionUsageLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}
