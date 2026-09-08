const FIELDWORK_ATTRIBUTION = { originator: "fieldwork", userAgent: "fieldwork/0.1.0", version: "0.1.0" };
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryOpenAISubscriptionRefreshStore,
  loginOpenAISubscriptionDeviceCode,
  requestOpenAIDeviceAuthorization,
  pollOpenAIDeviceAuthorization,
  exchangeOpenAIDeviceAuthorization,
  refreshOpenAISubscriptionCredential,
  refreshWithCredentialLease,
  planTypeFromAccessToken,
  type OpenAISubscriptionCredential,
} from "../src/oauth.js";

function jwt(accountId: string, expiresInSeconds = 600, planType = "pro"): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    exp: Math.floor(Date.now() / 1_000) + expiresInSeconds,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: planType,
    },
  })}.signature`;
}

function jsonResponse(value: object, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fetchCall(mock: ReturnType<typeof vi.fn>, index: number): [string, RequestInit] {
  return mock.mock.calls[index] as [string, RequestInit];
}

const originalCredential: OpenAISubscriptionCredential = {
  accessToken: jwt("acct_fieldwork"),
  refreshToken: "refresh-original",
  expiresAt: Date.now() + 600_000,
  accountId: "acct_fieldwork",
};

describe("OpenAI subscription auth", () => {
  it("reads the ChatGPT plan subtype without exposing other claims", () => {
    expect(planTypeFromAccessToken(jwt("acct_fieldwork", 600, "prolite"))).toBe("prolite");
    expect(planTypeFromAccessToken("not-a-token")).toBeNull();
  });

  it("supports request-scoped begin, poll, and exchange calls", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ device_auth_id: "device-123", user_code: "CODE-123", interval: 2 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ authorization_code: "authorization-123", code_verifier: "verifier-123" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: jwt("acct_fieldwork"),
          refresh_token: "refresh-123",
          expires_in: 600,
        }),
      );

    const started = await requestOpenAIDeviceAuthorization({ attribution: FIELDWORK_ATTRIBUTION, fetchFn: fetchMock });
    expect(started).toMatchObject({
      deviceAuthId: "device-123",
      userCode: "CODE-123",
      verificationUrl: "https://auth.openai.com/codex/device",
      pollIntervalMs: 2_000,
    });
    const polled = await pollOpenAIDeviceAuthorization(started, { attribution: FIELDWORK_ATTRIBUTION, fetchFn: fetchMock });
    expect(polled).toEqual({
      status: "authorized",
      authorizationCode: "authorization-123",
      codeVerifier: "verifier-123",
    });
    if (polled.status !== "authorized") throw new Error("expected authorization");
    await expect(exchangeOpenAIDeviceAuthorization(polled, { attribution: FIELDWORK_ATTRIBUTION, fetchFn: fetchMock })).resolves.toMatchObject({
      accountId: "acct_fieldwork",
      refreshToken: "refresh-123",
    });
  });

  it("runs the device-code state machine with Fieldwork attribution", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ device_auth_id: "device-123", user_code: "CODE-123", interval: 1 }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: "authorization_pending" }, 404))
      .mockResolvedValueOnce(
        jsonResponse({ authorization_code: "authorization-123", code_verifier: "verifier-123" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: jwt("acct_fieldwork"),
          refresh_token: "refresh-123",
          expires_in: 600,
        }),
      );
    const verification = vi.fn();
    const progress = vi.fn();
    const sleep = vi.fn(async () => {});

    const credential = await loginOpenAISubscriptionDeviceCode({ attribution: FIELDWORK_ATTRIBUTION,
      fetchFn: fetchMock,
      onVerification: verification,
      onProgress: progress,
      sleep,
    });

    expect(credential).toMatchObject({
      accountId: "acct_fieldwork",
      refreshToken: "refresh-123",
    });
    expect(verification).toHaveBeenCalledWith({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "CODE-123",
      expiresInMs: 900_000,
    });
    expect(progress.mock.calls.map(([message]) => message)).toEqual([
      "Requesting device code…",
      "Waiting for device authorization…",
      "Exchanging device code…",
    ]);
    expect(sleep).toHaveBeenCalledWith(1_000, undefined);

    const [userCodeUrl, userCodeInit] = fetchCall(fetchMock, 0);
    expect(userCodeUrl).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
    expect(userCodeInit).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        originator: "fieldwork",
        version: "0.1.0",
        "User-Agent": "fieldwork/0.1.0",
      },
    });
    expect(JSON.parse(String(userCodeInit.body))).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });

    const [, pollInit] = fetchCall(fetchMock, 1);
    expect(JSON.parse(String(pollInit.body))).toEqual({
      device_auth_id: "device-123",
      user_code: "CODE-123",
    });

    const [exchangeUrl, exchangeInit] = fetchCall(fetchMock, 3);
    expect(exchangeUrl).toBe("https://auth.openai.com/oauth/token");
    expect(exchangeInit.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded",
      originator: "fieldwork",
      version: "0.1.0",
      "User-Agent": "fieldwork/0.1.0",
    });
    expect(Object.fromEntries(exchangeInit.body as URLSearchParams)).toEqual({
      grant_type: "authorization_code",
      code: "authorization-123",
      redirect_uri: "https://auth.openai.com/deviceauth/callback",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code_verifier: "verifier-123",
    });
  });

  it("preserves an unrotated refresh token and rejects account substitution", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: jwt("acct_fieldwork"), expires_in: 600 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: jwt("acct_attacker"),
          refresh_token: "refresh-attacker",
          expires_in: 600,
        }),
      );

    const refreshed = await refreshOpenAISubscriptionCredential(originalCredential, {
      attribution: FIELDWORK_ATTRIBUTION,
      fetchFn: fetchMock,
    });
    expect(refreshed.refreshToken).toBe("refresh-original");
    const [, refreshInit] = fetchCall(fetchMock, 0);
    expect(refreshInit.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(Object.fromEntries(refreshInit.body as URLSearchParams)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-original",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });

    await expect(
      refreshOpenAISubscriptionCredential(originalCredential, { attribution: FIELDWORK_ATTRIBUTION, fetchFn: fetchMock }),
    ).rejects.toThrow("different ChatGPT account");
  });

  it("bounds error responses and never reflects token-shaped error content", async () => {
    const oversized = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("x".repeat(8_193), { status: 400 }));
    await expect(
      loginOpenAISubscriptionDeviceCode({ attribution: FIELDWORK_ATTRIBUTION,
        fetchFn: oversized,
        onVerification: () => {},
      }),
    ).rejects.toThrow("exceeded 8192 bytes");

    const accessToken = jwt("acct_should_not_leak");
    const malicious = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: "invalid_request",
          error_description: `access_token=${accessToken}\u001b[31m`,
        },
        400,
      ),
    );
    const failure = loginOpenAISubscriptionDeviceCode({ attribution: FIELDWORK_ATTRIBUTION,
      fetchFn: malicious,
      onVerification: () => {},
    });
    await expect(failure).rejects.toThrow("token=[REDACTED]");
    await expect(failure).rejects.not.toThrow(accessToken);
  });

  it("stops polling at the device deadline", async () => {
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ device_auth_id: "device-123", user_code: "CODE-123", interval: 1 }),
      )
      .mockResolvedValue(jsonResponse({ error: "authorization_pending" }, 404));
    try {
      await expect(
        loginOpenAISubscriptionDeviceCode({ attribution: FIELDWORK_ATTRIBUTION,
          fetchFn: fetchMock,
          onVerification: () => {},
          deviceTimeoutMs: 1_000,
          sleep: async (milliseconds) => {
            now += milliseconds;
          },
        }),
      ).rejects.toThrow("device authorization timed out");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("serializes concurrent rotating refreshes with a lease and generation CAS", async () => {
    const store = new InMemoryOpenAISubscriptionRefreshStore(originalCredential);
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshCalls = 0;
    const rotated: OpenAISubscriptionCredential = {
      ...originalCredential,
      accessToken: jwt("acct_fieldwork"),
      refreshToken: "refresh-rotated",
    };
    const refresh = async () => {
      refreshCalls += 1;
      await refreshGate;
      return rotated;
    };

    const first = refreshWithCredentialLease({ store, refresh, leaseId: "lease-1" });
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    const second = refreshWithCredentialLease({
      store,
      refresh,
      leaseId: "lease-2",
      pollIntervalMs: 1,
    });
    releaseRefresh();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(refreshCalls).toBe(1);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult).toMatchObject({
      generation: 1,
      credential: { refreshToken: "refresh-rotated", accountId: "acct_fieldwork" },
    });
  });

  it("validates custom attribution before any network request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(
      loginOpenAISubscriptionDeviceCode({ attribution: FIELDWORK_ATTRIBUTION,
        fetchFn: fetchMock,
        attribution: { ...FIELDWORK_ATTRIBUTION, originator: "bad\nheader" },
        onVerification: () => {},
      }),
    ).rejects.toThrow("not a valid header value");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

it("does not refresh a credential that became fresh before acquiring a lease", async () => {
  const store = new InMemoryOpenAISubscriptionRefreshStore(originalCredential);
  const refresh = vi.fn();
  const result = await refreshWithCredentialLease({ store, refresh, shouldRefresh: credential => credential.expiresAt < Date.now() });
  expect(result.generation).toBe(0);
  expect(refresh).not.toHaveBeenCalled();
});
