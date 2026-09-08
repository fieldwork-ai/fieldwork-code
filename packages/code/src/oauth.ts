import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { loginConfigPath, orgIdFromToken, type LoginConfig } from "./config.js";
import { EXIT, fail, note } from "./output.js";

/**
 * `fwcode login`: OAuth 2.1 authorization-code + PKCE against the
 * Fieldwork provider, as the seeded public `fieldwork-code` client. Loopback
 * redirect on an ephemeral 127.0.0.1 port — the registered port is ignored
 * for loopback IPs (RFC 8252 §7.3). Zero dependencies: node:http catches the
 * callback, node:crypto does PKCE S256.
 */

const CLIENT_ID = "fieldwork-code";
const SCOPE = "openid profile email offline_access fieldwork:api";

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
}

async function discover(apiUrl: string): Promise<Discovery> {
  const res = await fetch(`${apiUrl}/.well-known/oauth-authorization-server/api/auth`).catch(
    () => null,
  );
  if (!res?.ok) {
    fail(`could not discover the OAuth server at ${apiUrl}`, EXIT.server);
  }
  const meta = (await res.json()) as Partial<Discovery>;
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    fail("the OAuth server metadata is missing its endpoints", EXIT.server);
  }
  return meta as Discovery;
}

export function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(command, [url], { stdio: "ignore", detached: true });
    child.on("error", () => note(`Open this URL to continue:\n\n  ${url}\n`));
    child.unref();
  } catch {
    note(`Open this URL to continue:\n\n  ${url}\n`);
  }
}

export async function login(apiUrl: string): Promise<LoginConfig> {
  const discovery = await discover(apiUrl);

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");

  // Bind first so the redirect_uri carries the real port.
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const authorizeUrl = new URL(discovery.authorization_endpoint);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const callback = new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const gotState = url.searchParams.get("state");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        error
          ? "<p>Authorization failed — you can close this tab.</p>"
          : "<p>Signed in — you can close this tab and return to the terminal.</p>",
      );
      server.close();
      if (error) reject(new Error(`authorization failed: ${error}`));
      else if (!code || gotState !== state) reject(new Error("invalid callback"));
      else resolve(code);
    });
    setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for the browser (5 minutes)"));
    }, 5 * 60 * 1000).unref();
  });

  note("Opening your browser to sign in to Fieldwork…");
  openBrowser(authorizeUrl.toString());

  const code = await callback.catch((err: Error) => fail(err.message, EXIT.auth));

  const tokenRes = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      // RFC 8707: makes the access token a JWT bound to the API audience.
      resource: apiUrl,
    }).toString(),
  });
  const tokens = (await tokenRes.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
  } | null;
  if (!tokenRes.ok || !tokens?.access_token) {
    fail(tokens?.error_description ?? "token exchange failed", EXIT.auth);
  }

  const config: LoginConfig = {
    api_url: apiUrl,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_in
      ? Math.floor(Date.now() / 1000) + tokens.expires_in
      : undefined,
    organization_id: orgIdFromToken(tokens.access_token) ?? undefined,
  };
  const file = loginConfigPath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return config;
}
