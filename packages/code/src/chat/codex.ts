import { createServer } from "node:http";
import { beginOpenAIBrowserAuthorization, exchangeOpenAIBrowserAuthorization } from "@fieldwork-ai/codex-transport/oauth";
import { apiJson } from "../http.js";
import { openBrowser } from "../oauth.js";
import type { Choose } from "./session.js";
const attribution = { originator: "fieldwork", userAgent: "fwcode/0.15.2", version: "0.15.2" };
export async function connectCodex(choose: Choose, status: (message: string) => void, signal: AbortSignal) {
  const existing = await apiJson<{ connected: boolean }>("/api/user/ai-credentials/openai");
  if (existing.connected) { status("Codex is already connected to your Fieldwork account."); return; }
  if (await choose("Connect Codex: your access and refresh credentials will be stored encrypted in Fieldwork cloud, which runs model calls and refreshes your connection.", [{ value: "cancel", label: "Cancel" }, { value: "connect", label: "Connect Codex" }]) !== "connect") return;
  const authorization = beginOpenAIBrowserAuthorization({ attribution });
  signal.throwIfAborted();
  const server = createServer();
  let cancel: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(1455, "localhost", resolve); });
    const callback = new Promise<string>((resolve, reject) => {
      cancel = () => reject(new Error("Codex sign-in cancelled"));
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", authorization.redirectUri);
        if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== authorization.state) { res.writeHead(400).end("Invalid callback"); return; }
        res.writeHead(200, { "content-type": "text/plain" }).end("Return to fwcode to finish connecting.");
        resolve(url.toString());
      });
      timer = setTimeout(() => reject(new Error("Codex sign-in timed out")), 300_000);
    });
    status("Opening browser to connect Codex…");
    openBrowser(authorization.authorizationUrl);
    const credential = await exchangeOpenAIBrowserAuthorization(authorization, await callback, { attribution, signal });
    await apiJson("/api/user/ai-credentials/openai/browser", { method: "POST", body: JSON.stringify(credential), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
    status("Codex connected to Fieldwork.");
  } finally { if (cancel) signal.removeEventListener("abort", cancel); clearTimeout(timer); server.closeAllConnections(); server.close(); }
}
