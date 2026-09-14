import { describe, expect, it } from "vitest";
import { isOpenAISubscriptionUsageLimitError, openAISubscriptionUsageLimit } from "../src/errors.js";
import { OpenAISubscriptionError } from "../src/language-model.js";

describe("isOpenAISubscriptionUsageLimitError", () => {
  it.each([
    "You have hit your ChatGPT usage limit. Try again in ~30 min.",
    "usage_limit_reached",
    new Error("usage_not_included"),
  ])("recognizes Codex allowance failures recorded as text", (error) => {
    expect(isOpenAISubscriptionUsageLimitError(error)).toBe(true);
  });

  it("does not turn an ordinary provider failure into a quota notice", () => {
    expect(isOpenAISubscriptionUsageLimitError(new Error("fetch failed"))).toBe(false);
  });

  it("reads the backend's error type rather than the status code", () => {
    // The body the ChatGPT backend sends for an exhausted allowance.
    const exhausted = new OpenAISubscriptionError("Codex request failed with HTTP 429 (usage_limit_reached)", {
      status: 429, type: "usage_limit_reached", planType: "pro", resetsAt: 1_760_000_000,
    });
    expect(openAISubscriptionUsageLimit(exhausted)).toEqual({ type: "usage_limit_reached", resetsAt: new Date(1_760_000_000_000) });

    // Same status, different meaning: an ordinary rate limit is not a quota notice.
    const throttled = new OpenAISubscriptionError("Codex request failed with HTTP 429 (rate_limit_exceeded)", {
      status: 429, code: "rate_limit_exceeded",
    });
    expect(openAISubscriptionUsageLimit(throttled)).toBeNull();
    expect(isOpenAISubscriptionUsageLimitError(throttled)).toBe(false);
  });

  it("keeps the reset time null when the backend did not say", () => {
    expect(openAISubscriptionUsageLimit(new OpenAISubscriptionError("x", { status: 429, type: "usage_not_included" })))
      .toEqual({ type: "usage_not_included", resetsAt: null });
    expect(openAISubscriptionUsageLimit("usage_limit_reached")).toEqual({ type: "usage_limit_reached", resetsAt: null });
  });
});
