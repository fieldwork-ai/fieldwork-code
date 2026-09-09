import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  loginConfigPath,
  orgIdFromToken,
  resolveConfig,
  type ResolvedConfig,
} from "./config.js";
import { EXIT, exitCodeFor, fail } from "./output.js";

/**
 * The one HTTP door: resolves credentials, attaches the bearer, maps failures
 * to exit codes, and — for login-managed tokens — refreshes once on 401.
 */

export interface CliContext {
  config: ResolvedConfig;
  json: boolean;
  yes: boolean;
}

let ctx: CliContext | null = null;

export function initContext(flags: {
  apiUrl?: string;
  token?: string;
  json?: boolean;
  yes?: boolean;
}): CliContext {
  ctx = {
    config: resolveConfig(flags),
    json: flags.json ?? false,
    yes: flags.yes ?? false,
  };
  return ctx;
}

export function getContext(): CliContext {
  if (!ctx) throw new Error("CLI context not initialized");
  return ctx;
}

export function requireToken(): string {
  const { config } = getContext();
  if (!config.token) {
    fail(
      "no credentials — run `fwcode login`, or set FWCODE_TOKEN and FWCODE_API_URL",
      EXIT.auth,
    );
  }
  return config.token;
}

/** The org the token is pinned to — used to build org-scoped route paths. */
export function requireOrgId(): string {
  const org = orgIdFromToken(requireToken());
  if (!org) {
    fail("the current token carries no organization — run `fwcode login` again", EXIT.auth);
  }
  return org;
}

let refreshing: Promise<string | null> | undefined;
function refreshLoginToken(): Promise<string | null> {
  refreshing ??= refreshLoginTokenOnce().finally(() => { refreshing = undefined; });
  return refreshing;
}
async function refreshLoginTokenOnce(): Promise<string | null> {
  const { config } = getContext();
  if (config.source !== "login" || !config.login?.refresh_token) return null;
  try {
    const discovery = await fetch(
      `${config.apiUrl}/.well-known/oauth-authorization-server/api/auth`,
    );
    if (!discovery.ok) return null;
    const { token_endpoint } = (await discovery.json()) as { token_endpoint?: string };
    if (!token_endpoint) return null;
    const res = await fetch(token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: config.login.refresh_token,
        client_id: "fieldwork-code",
        resource: config.apiUrl,
      }).toString(),
    });
    if (!res.ok) return null;
    const tokens = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!tokens.access_token) return null;
    const updated = {
      ...config.login,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? config.login.refresh_token,
      expires_at: tokens.expires_in
        ? Math.floor(Date.now() / 1000) + tokens.expires_in
        : undefined,
      organization_id: orgIdFromToken(tokens.access_token) ?? config.login.organization_id,
    };
    const file = loginConfigPath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    config.token = tokens.access_token;
    config.login = updated;
    return tokens.access_token;
  } catch {
    return null;
  }
}

export async function api(
  pathname: string,
  init: RequestInit & { body?: string } = {},
): Promise<Response> {
  const { config } = getContext();
  const token = requireToken();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  const orgId = orgIdFromToken(token);
  if (orgId) headers.set("X-Organization-Id", orgId);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  let res: Response;
  try {
    res = await fetch(`${config.apiUrl}${pathname}`, { ...init, headers });
  } catch (err) {
    if (init.signal?.aborted) throw err;
    fail(
      `could not reach ${config.apiUrl}: ${err instanceof Error ? err.message : "network error"}`,
      EXIT.server,
    );
  }

  if (res.status === 401) {
    const refreshed = await refreshLoginToken();
    if (refreshed) {
      headers.set("authorization", `Bearer ${refreshed}`);
      const orgId = orgIdFromToken(refreshed);
      if (orgId) headers.set("X-Organization-Id", orgId);
      res = await fetch(`${config.apiUrl}${pathname}`, { ...init, headers });
    }
  }
  return res;
}

/** api() + JSON body + fail-on-error, the shape most commands want. */
export async function apiJson<T = unknown>(
  pathname: string,
  init: RequestInit & { body?: string } = {},
): Promise<T> {
  const res = await api(pathname, init);
  const body = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: string })
    | null;
  if (!res.ok) {
    fail(body?.error ?? `request failed (${res.status})`, exitCodeFor(res.status));
  }
  return body as T;
}
