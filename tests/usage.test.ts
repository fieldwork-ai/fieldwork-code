const FIELDWORK_ATTRIBUTION = { originator: "fieldwork", userAgent: "fieldwork/0.1.0", version: "0.1.0" };
import { describe, expect, it, vi } from "vitest";
import {
  fetchCodexUsage,
  parseCodexUsage,
} from "../src/usage.js";

const RESPONSE = {
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 7,
      limit_window_seconds: 7 * 24 * 60 * 60,
      reset_at: 1_800_000_000,
    },
    secondary_window: {
      used_percent: 25,
      limit_window_seconds: 5 * 60 * 60,
      reset_at: 1_799_000_000,
    },
  },
  additional_rate_limits: [
    {
      metered_feature: "codex_spark",
      limit_name: "Codex Spark",
      rate_limit: {
        primary_window: {
          used_percent: 0,
          window_minutes: 300,
          reset_at: 1_799_000_000,
        },
        secondary_window: null,
      },
    },
  ],
};

describe("Codex subscription usage", () => {
  it("normalizes general and model-specific quota windows", () => {
    expect(parseCodexUsage(RESPONSE, new Date("2026-08-30T19:00:00Z"))).toEqual({
      fetchedAt: "2026-08-30T19:00:00.000Z",
      planType: "pro",
      limitReached: false,
      limits: [
        {
          id: "codex",
          label: "Codex",
          primary: {
            usedPercent: 7,
            windowDurationMinutes: 10_080,
            resetsAt: "2027-01-15T08:00:00.000Z",
          },
          secondary: {
            usedPercent: 25,
            windowDurationMinutes: 300,
            resetsAt: "2027-01-03T18:13:20.000Z",
          },
        },
        {
          id: "codex_spark",
          label: "Codex Spark",
          primary: {
            usedPercent: 0,
            windowDurationMinutes: 300,
            resetsAt: "2027-01-03T18:13:20.000Z",
          },
          secondary: null,
        },
      ],
    });
  });

  it("uses bearer and account-scoped auth without exposing either in the result", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const usage = await fetchCodexUsage({ attribution: FIELDWORK_ATTRIBUTION,
      accessToken: "access-secret",
      accountId: "account-123",
      fetchFn: fetchMock,
      now: new Date("2026-08-30T19:00:00Z"),
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer access-secret");
    expect(new Headers(init.headers).get("ChatGPT-Account-Id")).toBe("account-123");
    expect(JSON.stringify(usage)).not.toContain("secret");
    expect(JSON.stringify(usage)).not.toContain("account-123");
  });

  it("rejects non-success and malformed responses", async () => {
    await expect(
      fetchCodexUsage({ attribution: FIELDWORK_ATTRIBUTION,
        accessToken: "access-secret",
        accountId: "account-123",
        fetchFn: vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("no", { status: 429 })),
      }),
    ).rejects.toThrow("HTTP 429");
    expect(() => parseCodexUsage([])).toThrow("not an object");
  });
});
