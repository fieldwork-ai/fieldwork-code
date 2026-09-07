import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";

/** OAuth device and browser flows following openai/codex codex-rs/login. */

const AUTH_BASE_URL = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_CALLBACK_URL = `${AUTH_BASE_URL}/deviceauth/callback`;
const DEVICE_TIMEOUT_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const SUCCESS_BODY_LIMIT_BYTES = 256 * 1024;
const ERROR_BODY_LIMIT_BYTES = 8 * 1024;

export interface OpenAISubscriptionAttribution {
  originator: string;
  userAgent: string;
  version?: string;
}


export interface OpenAISubscriptionCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
}

export interface DeviceVerificationPrompt {
  verificationUrl: string;
  userCode: string;
  expiresInMs: number;
}

interface OAuthClientOptions {
  fetchFn?: typeof fetch;
  attribution: OpenAISubscriptionAttribution;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

interface DeviceLoginOptions extends OAuthClientOptions {
  onVerification: (prompt: DeviceVerificationPrompt) => Promise<void> | void;
  onProgress?: (message: string) => void;
  deviceTimeoutMs?: number;
  sleep?: typeof abortableSleep;
}

interface HttpResult {
  ok: boolean;
  status: number;
  body: string;
}

export interface OpenAIDeviceAuthorization {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  pollIntervalMs: number;
}

export type OpenAIDevicePollResult =
  | { status: "pending" }
  | { status: "authorized"; authorizationCode: string; codeVerifier: string };

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeDurationMs(value: unknown): number | undefined {
  const seconds = typeof value === "string" ? Number(value) : value;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const milliseconds = seconds * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function sanitizeErrorText(value: string): string {
  return value
    .replace(/\x1b\[[\u0020-\u003f]*[\u0040-\u007e]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\b(?:Bearer\s+)?eyJ[A-Za-z0-9._-]+\b/gi, "[REDACTED]")
    .replace(/\b(?:access|refresh|id)_token\s*[=:]\s*[^\s,;}]+/gi, "token=[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

function errorMessage(prefix: string, status: number, bodyText: string): string {
  const body = parseObject(bodyText);
  const code = nonEmpty(body?.error);
  const description = nonEmpty(body?.error_description);
  if (code && description) {
    return `${prefix}: ${sanitizeErrorText(code)} (${sanitizeErrorText(description)})`;
  }
  if (code) return `${prefix}: ${sanitizeErrorText(code)}`;
  return `${prefix}: HTTP ${status}`;
}

function validateAttribution(
  attribution: OpenAISubscriptionAttribution,
): OpenAISubscriptionAttribution {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(attribution.originator)) {
    throw new Error("OpenAI subscription originator is not a valid header value");
  }
  for (const value of [attribution.userAgent, attribution.version]) {
    if (value !== undefined && (!value.trim() || /[^\u0020-\u007e]/.test(value))) {
      throw new Error("OpenAI subscription attribution contains an invalid header value");
    }
  }
  return attribution;
}

function attributedHeaders(
  contentType: string,
  attribution: OpenAISubscriptionAttribution,
): Record<string, string> {
  const valid = validateAttribution(attribution);
  return {
    "Content-Type": contentType,
    originator: valid.originator,
    ...(valid.version ? { version: valid.version } : {}),
    "User-Agent": valid.userAgent,
  };
}

function assertAuthUrl(url: string): void {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "auth.openai.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("OpenAI subscription OAuth refused a non-allowlisted URL");
  }
}

async function readBodyLimited(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new Error(`OpenAI subscription OAuth response exceeded ${maximumBytes} bytes`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function request(params: {
  fetchFn: typeof fetch;
  url: string;
  init: Omit<RequestInit, "signal">;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<HttpResult> {
  assertAuthUrl(params.url);
  params.signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(params.timeoutMs);
  const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await params.fetchFn(params.url, {
      ...params.init,
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (params.signal?.aborted) {
      throw params.signal.reason instanceof Error ? params.signal.reason : error;
    }
    if (signal.aborted) {
      throw new Error(`OpenAI subscription OAuth request timed out after ${params.timeoutMs}ms`, {
        cause: error,
      });
    }
    throw new Error("OpenAI subscription OAuth request failed", { cause: error });
  }
  return {
    ok: response.ok,
    status: response.status,
    body: await readBodyLimited(
      response,
      response.ok ? SUCCESS_BODY_LIMIT_BYTES : ERROR_BODY_LIMIT_BYTES,
    ),
  };
}

function accountIdFromAccessToken(accessToken: string): string | undefined {
  try {
    const encoded = accessToken.split(".")[1];
    if (!encoded) return undefined;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const auth = payload["https://api.openai.com/auth"];
    if (!auth || typeof auth !== "object") return undefined;
    return nonEmpty((auth as Record<string, unknown>).chatgpt_account_id);
  } catch {
    return undefined;
  }
}

/** Best-effort account tier from the namespaced ChatGPT claims in an access token. */
export function planTypeFromAccessToken(accessToken: string): string | null {
  try {
    const encoded = accessToken.split(".")[1];
    if (!encoded) return null;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const auth = payload["https://api.openai.com/auth"];
    if (!auth || typeof auth !== "object") return null;
    return nonEmpty((auth as Record<string, unknown>).chatgpt_plan_type) ?? null;
  } catch {
    return null;
  }
}

function expiryFromAccessToken(accessToken: string): number | undefined {
  try {
    const encoded = accessToken.split(".")[1];
    if (!encoded) return undefined;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" && Number.isSafeInteger(payload.exp * 1_000)
      ? payload.exp * 1_000
      : undefined;
  } catch {
    return undefined;
  }
}

function credentialFromTokenResponse(
  bodyText: string,
  existingRefreshToken?: string,
  expectedAccountId?: string,
): OpenAISubscriptionCredential {
  const body = parseObject(bodyText);
  const accessToken = nonEmpty(body?.access_token);
  const refreshToken = nonEmpty(body?.refresh_token) ?? existingRefreshToken;
  const expiresAt = safeDurationMs(body?.expires_in);
  if (!body || !accessToken || !refreshToken || (!expiresAt && !expiryFromAccessToken(accessToken))) {
    throw new Error("OpenAI subscription token response was missing required fields");
  }
  const accountId = accountIdFromAccessToken(accessToken);
  if (!accountId) {
    throw new Error("OpenAI subscription access token did not identify a ChatGPT account");
  }
  if (expectedAccountId && accountId !== expectedAccountId) {
    throw new Error("OpenAI subscription refresh returned a different ChatGPT account");
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: expiresAt ? Date.now() + expiresAt : expiryFromAccessToken(accessToken)!,
    accountId,
  };
}

/** Start the device flow without exposing any bearer credential to the browser. */
export async function requestOpenAIDeviceAuthorization(
  options: OAuthClientOptions,
): Promise<OpenAIDeviceAuthorization> {
  const result = await request({
    fetchFn: options.fetchFn ?? fetch,
    url: `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`,
    init: {
      method: "POST",
      headers: attributedHeaders("application/json", options.attribution),
      body: JSON.stringify({ client_id: CLIENT_ID }),
    },
    timeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    signal: options.signal,
  });
  if (!result.ok) {
    if (result.status === 404) {
      throw new Error("OpenAI subscription device login is not enabled for this account");
    }
    throw new Error(errorMessage("OpenAI subscription device code request failed", result.status, result.body));
  }
  const body = parseObject(result.body);
  const deviceAuthId = nonEmpty(body?.device_auth_id);
  const userCode = nonEmpty(body?.user_code) ?? nonEmpty(body?.usercode);
  if (!deviceAuthId || !userCode) {
    throw new Error("OpenAI subscription device code response was missing required fields");
  }
  return {
    deviceAuthId,
    userCode,
    verificationUrl: `${AUTH_BASE_URL}/codex/device`,
    expiresAt: Date.now() + DEVICE_TIMEOUT_MS,
    pollIntervalMs: Math.max(safeDurationMs(body?.interval) ?? DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS),
  };
}

/** Poll once; callers persist the opaque device values between requests. */
export async function pollOpenAIDeviceAuthorization(
  authorization: Pick<OpenAIDeviceAuthorization, "deviceAuthId" | "userCode">,
  options: OAuthClientOptions,
): Promise<OpenAIDevicePollResult> {
  const result = await request({
    fetchFn: options.fetchFn ?? fetch,
    url: `${AUTH_BASE_URL}/api/accounts/deviceauth/token`,
    init: {
      method: "POST",
      headers: attributedHeaders("application/json", options.attribution),
      body: JSON.stringify({
        device_auth_id: authorization.deviceAuthId,
        user_code: authorization.userCode,
      }),
    },
    timeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    signal: options.signal,
  });
  if (result.status === 403 || result.status === 404) return { status: "pending" };
  if (!result.ok) {
    throw new Error(errorMessage("OpenAI subscription device authorization failed", result.status, result.body));
  }
  const body = parseObject(result.body);
  const authorizationCode = nonEmpty(body?.authorization_code);
  const codeVerifier = nonEmpty(body?.code_verifier);
  if (!authorizationCode || !codeVerifier) {
    throw new Error("OpenAI subscription device authorization omitted its exchange code");
  }
  return { status: "authorized", authorizationCode, codeVerifier };
}

export async function exchangeOpenAIDeviceAuthorization(
  authorized: Extract<OpenAIDevicePollResult, { status: "authorized" }>,
  options: OAuthClientOptions,
): Promise<OpenAISubscriptionCredential> {
  const result = await request({
    fetchFn: options.fetchFn ?? fetch,
    url: `${AUTH_BASE_URL}/oauth/token`,
    init: {
      method: "POST",
      headers: attributedHeaders("application/x-www-form-urlencoded", options.attribution),
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authorized.authorizationCode,
        redirect_uri: DEVICE_CALLBACK_URL,
        client_id: CLIENT_ID,
        code_verifier: authorized.codeVerifier,
      }),
    },
    timeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    signal: options.signal,
  });
  if (!result.ok) {
    throw new Error(`OpenAI subscription device token exchange failed: HTTP ${result.status}`);
  }
  return credentialFromTokenResponse(result.body);
}

export async function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
    }
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal) {
      void Promise.resolve().then(() => {
        if (signal.aborted) abort();
      });
    }
  });
}

export async function loginOpenAISubscriptionDeviceCode(
  options: DeviceLoginOptions,
): Promise<OpenAISubscriptionCredential> {
  const fetchFn = options.fetchFn ?? fetch;
  const attribution = options.attribution;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const deviceTimeoutMs = options.deviceTimeoutMs ?? DEVICE_TIMEOUT_MS;
  const sleep = options.sleep ?? abortableSleep;

  options.onProgress?.("Requesting device code…");
  const codeResult = await request({
    fetchFn,
    url: `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`,
    init: {
      method: "POST",
      headers: attributedHeaders("application/json", attribution),
      body: JSON.stringify({ client_id: CLIENT_ID }),
    },
    timeoutMs: requestTimeoutMs,
    signal: options.signal,
  });
  if (!codeResult.ok) {
    if (codeResult.status === 404) {
      throw new Error("OpenAI subscription device login is not enabled for this account");
    }
    throw new Error(errorMessage("OpenAI subscription device code request failed", codeResult.status, codeResult.body));
  }
  const codeBody = parseObject(codeResult.body);
  const deviceAuthId = nonEmpty(codeBody?.device_auth_id);
  const userCode = nonEmpty(codeBody?.user_code) ?? nonEmpty(codeBody?.usercode);
  if (!deviceAuthId || !userCode) {
    throw new Error("OpenAI subscription device code response was missing required fields");
  }
  const intervalMs = safeDurationMs(codeBody?.interval) ?? DEFAULT_POLL_INTERVAL_MS;
  await options.onVerification({
    verificationUrl: `${AUTH_BASE_URL}/codex/device`,
    userCode,
    expiresInMs: deviceTimeoutMs,
  });

  options.onProgress?.("Waiting for device authorization…");
  const deadline = Date.now() + deviceTimeoutMs;
  let authorizationCode: string | undefined;
  let codeVerifier: string | undefined;
  while (Date.now() < deadline) {
    let poll: HttpResult;
    try {
      poll = await request({
        fetchFn,
        url: `${AUTH_BASE_URL}/api/accounts/deviceauth/token`,
        init: {
          method: "POST",
          headers: attributedHeaders("application/json", attribution),
          body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        },
        timeoutMs: Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now())),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.message.includes("exceeded"))) {
        throw error;
      }
      await sleep(
        Math.min(Math.max(intervalMs, MIN_POLL_INTERVAL_MS), deadline - Date.now()),
        options.signal,
      );
      continue;
    }
    if (poll.ok) {
      const pollBody = parseObject(poll.body);
      authorizationCode = nonEmpty(pollBody?.authorization_code);
      codeVerifier = nonEmpty(pollBody?.code_verifier);
      if (!authorizationCode || !codeVerifier) {
        throw new Error("OpenAI subscription device authorization omitted its exchange code");
      }
      break;
    }
    if (poll.status !== 403 && poll.status !== 404) {
      throw new Error(errorMessage("OpenAI subscription device authorization failed", poll.status, poll.body));
    }
    await sleep(Math.min(Math.max(intervalMs, MIN_POLL_INTERVAL_MS), deadline - Date.now()), options.signal);
  }
  if (!authorizationCode || !codeVerifier) {
    throw new Error("OpenAI subscription device authorization timed out");
  }

  options.onProgress?.("Exchanging device code…");
  const exchange = await request({
    fetchFn,
    url: `${AUTH_BASE_URL}/oauth/token`,
    init: {
      method: "POST",
      headers: attributedHeaders("application/x-www-form-urlencoded", attribution),
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode,
        redirect_uri: DEVICE_CALLBACK_URL,
        client_id: CLIENT_ID,
        code_verifier: codeVerifier,
      }),
    },
    timeoutMs: requestTimeoutMs,
    signal: options.signal,
  });
  if (!exchange.ok) {
    throw new Error(`OpenAI subscription device token exchange failed: HTTP ${exchange.status}`);
  }
  return credentialFromTokenResponse(exchange.body);
}

export async function refreshOpenAISubscriptionCredential(
  credential: OpenAISubscriptionCredential,
  options: OAuthClientOptions,
): Promise<OpenAISubscriptionCredential> {
  const result = await request({
    fetchFn: options.fetchFn ?? fetch,
    url: `${AUTH_BASE_URL}/oauth/token`,
    init: {
      method: "POST",
      headers: attributedHeaders("application/x-www-form-urlencoded", options.attribution),
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        client_id: CLIENT_ID,
      }),
    },
    timeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    signal: options.signal,
  });
  if (!result.ok) {
    throw new Error(`OpenAI subscription token refresh failed: HTTP ${result.status}`);
  }
  return credentialFromTokenResponse(result.body, credential.refreshToken, credential.accountId);
}

export interface VersionedOpenAISubscriptionCredential {
  credential: OpenAISubscriptionCredential;
  generation: number;
}

export interface OpenAISubscriptionRefreshStore {
  read(): Promise<VersionedOpenAISubscriptionCredential>;
  tryAcquire(expectedGeneration: number, leaseId: string, leaseUntil: number): Promise<boolean>;
  commit(
    expectedGeneration: number,
    leaseId: string,
    credential: OpenAISubscriptionCredential,
  ): Promise<boolean>;
  release(expectedGeneration: number, leaseId: string): Promise<void>;
}

export async function refreshWithCredentialLease(options: {
  store: OpenAISubscriptionRefreshStore;
  refresh: (
    credential: OpenAISubscriptionCredential,
  ) => Promise<OpenAISubscriptionCredential>;
  shouldRefresh?: (credential: OpenAISubscriptionCredential) => boolean;
  leaseDurationMs?: number;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  leaseId?: string;
}): Promise<VersionedOpenAISubscriptionCredential> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => abortableSleep(milliseconds));
  const leaseDurationMs = options.leaseDurationMs ?? 30_000;
  const waitTimeoutMs = options.waitTimeoutMs ?? 35_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const leaseId = options.leaseId ?? randomUUID();
  const initial = await options.store.read();
  if (options.shouldRefresh && !options.shouldRefresh(initial.credential)) return initial;
  const deadline = now() + waitTimeoutMs;

  while (now() <= deadline) {
    const acquired = await options.store.tryAcquire(
      initial.generation,
      leaseId,
      now() + leaseDurationMs,
    );
    if (acquired) {
      try {
        const refreshed = await options.refresh(initial.credential);
        if (await options.store.commit(initial.generation, leaseId, refreshed)) {
          return { credential: refreshed, generation: initial.generation + 1 };
        }
        const winner = await options.store.read();
        if (winner.generation !== initial.generation) return winner;
        throw new Error("OpenAI subscription refresh lease was lost before commit");
      } finally {
        await options.store.release(initial.generation, leaseId);
      }
    }

    const current = await options.store.read();
    if (current.generation !== initial.generation) return current;
    if (now() >= deadline) break;
    await sleep(Math.min(pollIntervalMs, deadline - now()));
  }
  throw new Error("Timed out waiting for another OpenAI subscription token refresh");
}

export class InMemoryOpenAISubscriptionRefreshStore
  implements OpenAISubscriptionRefreshStore
{
  private value: VersionedOpenAISubscriptionCredential;
  private lease: { id: string; until: number } | null = null;

  constructor(
    credential: OpenAISubscriptionCredential,
    private readonly now: () => number = Date.now,
  ) {
    this.value = { credential, generation: 0 };
  }

  async read(): Promise<VersionedOpenAISubscriptionCredential> {
    return structuredClone(this.value);
  }

  async tryAcquire(
    expectedGeneration: number,
    leaseId: string,
    leaseUntil: number,
  ): Promise<boolean> {
    if (this.value.generation !== expectedGeneration) return false;
    if (this.lease && this.lease.until > this.now() && this.lease.id !== leaseId) return false;
    this.lease = { id: leaseId, until: leaseUntil };
    return true;
  }

  async commit(
    expectedGeneration: number,
    leaseId: string,
    credential: OpenAISubscriptionCredential,
  ): Promise<boolean> {
    if (
      this.value.generation !== expectedGeneration ||
      this.lease?.id !== leaseId ||
      this.lease.until <= this.now()
    ) {
      return false;
    }
    this.value = { credential: structuredClone(credential), generation: expectedGeneration + 1 };
    this.lease = null;
    return true;
  }

  async release(expectedGeneration: number, leaseId: string): Promise<void> {
    if (this.value.generation === expectedGeneration && this.lease?.id === leaseId) {
      this.lease = null;
    }
  }
}

export interface OpenAIBrowserAuthorization {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}
export function beginOpenAIBrowserAuthorization(options: { attribution: OpenAISubscriptionAttribution }): OpenAIBrowserAuthorization {
  attributedHeaders("application/json", options.attribution);
  const codeVerifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const redirectUri = "http://localhost:1455/auth/callback";
  const query = new URLSearchParams({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: redirectUri,
    scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
    code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"), code_challenge_method: "S256",
    id_token_add_organizations: "true", codex_cli_simplified_flow: "true", state, originator: options.attribution.originator,
  });
  return { authorizationUrl: `${AUTH_BASE_URL}/oauth/authorize?${query}`, state, codeVerifier, redirectUri };
}
export async function exchangeOpenAIBrowserAuthorization(authorization: OpenAIBrowserAuthorization, callbackUrl: string, options: OAuthClientOptions): Promise<OpenAISubscriptionCredential> {
  const callback = new URL(callbackUrl);
  if (`${callback.origin}${callback.pathname}` !== authorization.redirectUri) throw new Error("Unexpected OAuth callback");
  const actual = Buffer.from(callback.searchParams.get("state") ?? "");
  const expected = Buffer.from(authorization.state);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("OAuth state mismatch");
  const code = callback.searchParams.get("code");
  if (!code || callback.searchParams.has("error")) throw new Error("OAuth authorization was not granted");
  const result = await request({
    fetchFn: options.fetchFn ?? fetch, url: `${AUTH_BASE_URL}/oauth/token`,
    init: { method: "POST", headers: attributedHeaders("application/x-www-form-urlencoded", options.attribution), body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: authorization.redirectUri, client_id: CLIENT_ID, code_verifier: authorization.codeVerifier }) },
    timeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, signal: options.signal,
  });
  if (!result.ok) throw new Error(`OpenAI browser token exchange failed: HTTP ${result.status}`);
  return credentialFromTokenResponse(result.body);
}
