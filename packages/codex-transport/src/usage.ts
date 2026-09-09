import type { OpenAISubscriptionAttribution } from "./oauth.js";

import type {
  CodexUsageLimit,
  CodexUsageSnapshot,
  CodexUsageWindow,
} from "./types.js";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 10_000;
const MAXIMUM_BODY_BYTES = 256 * 1024;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function usageWindow(value: unknown): CodexUsageWindow | null {
  const window = object(value);
  if (!window) return null;
  const usedPercent = finiteNumber(window.used_percent);
  if (usedPercent === null) return null;
  const durationSeconds = finiteNumber(window.limit_window_seconds);
  const durationMinutes = finiteNumber(window.window_minutes);
  const resetsAt = finiteNumber(window.reset_at);
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowDurationMinutes:
      durationSeconds !== null
        ? Math.round(durationSeconds / 60)
        : durationMinutes !== null
          ? Math.round(durationMinutes)
          : null,
    resetsAt: resetsAt !== null ? new Date(resetsAt * 1_000).toISOString() : null,
  };
}

function usageLimit(
  id: string,
  label: string | null,
  value: unknown,
): CodexUsageLimit | null {
  const rateLimit = object(value);
  if (!rateLimit) return null;
  const primary = usageWindow(rateLimit.primary_window);
  const secondary = usageWindow(rateLimit.secondary_window);
  if (!primary && !secondary) return null;
  return { id, label, primary, secondary };
}

/** Normalize the intentionally small subset of the Codex quota response the UI uses. */
export function parseCodexUsage(value: unknown, now = new Date()): CodexUsageSnapshot {
  const body = object(value);
  if (!body) throw new Error("Codex usage response was not an object");
  const rateLimit = object(body.rate_limit);
  const limits: CodexUsageLimit[] = [];
  const general = usageLimit("codex", "Codex", rateLimit);
  if (general) limits.push(general);

  if (Array.isArray(body.additional_rate_limits)) {
    for (const entryValue of body.additional_rate_limits) {
      const entry = object(entryValue);
      if (!entry) continue;
      const id = string(entry.metered_feature) ?? string(entry.limit_name);
      if (!id) continue;
      const limit = usageLimit(id, string(entry.limit_name) ?? id, entry.rate_limit);
      if (limit) limits.push(limit);
    }
  }

  return {
    fetchedAt: now.toISOString(),
    planType: string(body.plan_type),
    limitReached: rateLimit?.limit_reached === true,
    limits,
  };
}

async function readBodyLimited(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAXIMUM_BODY_BYTES) {
        await reader.cancel();
        throw new Error("Codex usage response was too large");
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

export async function fetchCodexUsage(options: {
  attribution: OpenAISubscriptionAttribution;
  accessToken: string;
  accountId: string;
  fetchFn?: typeof fetch;
  now?: Date;
}): Promise<CodexUsageSnapshot> {
  const response = await (options.fetchFn ?? fetch)(CODEX_USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      "ChatGPT-Account-Id": options.accountId,
      Accept: "application/json",
      originator: options.attribution.originator,
      "User-Agent": options.attribution.userAgent,
    },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await readBodyLimited(response);
  if (!response.ok) throw new Error(`Codex usage request failed with HTTP ${response.status}`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Codex usage response was not valid JSON");
  }
  return parseCodexUsage(value, options.now);
}
