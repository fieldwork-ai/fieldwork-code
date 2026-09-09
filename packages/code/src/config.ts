import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Credential resolution (ADR 20260804), in order:
 *   1. FWCODE_TOKEN / FWCODE_API_URL environment variables — how the
 *      Firecracker backend delivers per-conversation credentials (env on each
 *      bash call); env must beat the file, or a stale machine-scoped file
 *      would shadow the conversation-scoped identity in a shared VM;
 *   2. ~/.fieldwork/credentials — the dotenv file the platform injects into
 *      Fargate compute containers at claim time;
 *   3. ~/.config/fieldwork/config.json — written by `fwcode login`.
 * --token / --api-url flags override everything.
 *
 * The token is org-pinned at mint (container conversation tokens and OAuth
 * JWTs both carry the org), so there is no per-request org selection: the org
 * id is decoded from the token to build org-scoped route paths, and the
 * server re-verifies everything — the local decode is a convenience, never
 * an authority.
 */

export interface LoginConfig {
  api_url: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  organization_id?: string;
}

export interface ResolvedConfig {
  apiUrl: string;
  token: string | null;
  source: "flags" | "container" | "env" | "login" | "none";
  /** Set when source is "login": enables the refresh-once path in http.ts. */
  login?: LoginConfig;
}

export const CONTAINER_CREDENTIALS_PATH = path.join(homedir(), ".fieldwork", "credentials");

export function loginConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(base, "fwcode", "config.json");
}

function parseDotenv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

export function readLoginConfig(): LoginConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(loginConfigPath(), "utf8"));
    if (typeof parsed?.api_url === "string" && typeof parsed?.access_token === "string") {
      return parsed as LoginConfig;
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveConfig(flags: { apiUrl?: string; token?: string }): ResolvedConfig {
  const flagUrl = flags.apiUrl;
  const flagToken = flags.token;
  if (flagToken && flagUrl) {
    return { apiUrl: flagUrl, token: flagToken, source: "flags" };
  }

  if (process.env.FWCODE_TOKEN && process.env.FWCODE_API_URL) {
    return {
      apiUrl: flagUrl ?? process.env.FWCODE_API_URL,
      token: flagToken ?? process.env.FWCODE_TOKEN,
      source: "env",
    };
  }

  const login = readLoginConfig();
  if (login) {
    return {
      apiUrl: flagUrl ?? login.api_url,
      token: flagToken ?? login.access_token,
      source: "login",
      login,
    };
  }

  return {
    apiUrl: flagUrl ?? process.env.FWCODE_API_URL ?? "https://app.getfieldwork.ai",
    token: flagToken ?? null,
    source: flagToken ? "flags" : "none",
  };
}

interface DecodedToken {
  sub?: string;
  org?: string;
  cnv?: string;
  organization_id?: string;
  exp?: number;
  typ?: string;
}

/**
 * Best-effort local decode of either token kind (2-segment envelope, 3-segment
 * JWT) — for building org-scoped paths and `whoami` output. Never an
 * authority: the server verifies the signature and re-resolves membership.
 */
export function decodeToken(token: string): DecodedToken | null {
  const segments = token.split(".");
  const payloadSegment = segments.length === 2 ? segments[0] : segments.length === 3 ? segments[1] : null;
  if (!payloadSegment) return null;
  try {
    return JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function orgIdFromToken(token: string): string | null {
  const decoded = decodeToken(token);
  const org = decoded?.org ?? decoded?.organization_id;
  return typeof org === "string" && org ? org : null;
}
