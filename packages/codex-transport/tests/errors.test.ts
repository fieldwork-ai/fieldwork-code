import { describe, expect, it } from "vitest";
import { isOpenAISubscriptionUsageLimitError } from "../src/errors.js";

describe("isOpenAISubscriptionUsageLimitError", () => {
  it.each([
    "You have hit your ChatGPT usage limit. Try again in ~30 min.",
    "usage_limit_reached",
    new Error("usage_not_included"),
  ])("recognizes Codex allowance failures", (error) => {
    expect(isOpenAISubscriptionUsageLimitError(error)).toBe(true);
  });

  it("does not turn an ordinary provider failure into a quota notice", () => {
    expect(isOpenAISubscriptionUsageLimitError(new Error("fetch failed"))).toBe(false);
  });
});
