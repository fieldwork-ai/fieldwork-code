import { startRunner } from "../agent/runner.js";
import { apiJson, getContext } from "../http.js";
export async function connectLocal(conversationId: string, root: string, deviceId: string, status: (text: string) => void) {
  const path = `/api/conversations/${encodeURIComponent(conversationId)}/runner-session`;
  type Binding = { session_id: string; token: string };
  const binding = await apiJson<Binding>(path, { method: "POST", body: JSON.stringify({ root, runner_device_id: deviceId }) });
  let online = false;
  let ready!: () => void;
  const connected = new Promise<void>(resolve => { ready = resolve; });
  const runner = startRunner({
    roots: [root], apiUrl: getContext().config.apiUrl, sessionId: binding.session_id,
    getToken: async () => (await apiJson<Binding>(path, { method: "POST", body: JSON.stringify({ root, runner_device_id: deviceId, session_id: binding.session_id }) })).token,
    onStatus(value) { online = value; if (value) ready(); status(value ? `Local tools connected · ${root}` : "Local connection lost. In-flight tools may be incomplete; reconnecting without replay."); },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([connected, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Could not connect local tools")), 15_000); })]); }
  catch (error) { runner.stop(); await closeBinding(); throw error; }
  finally { clearTimeout(timer); }
  async function closeBinding() {
    try { await apiJson(path, { method: "DELETE", body: JSON.stringify({ session_id: binding.session_id }), signal: AbortSignal.timeout(5000) }); } catch {}
  }
  return { assertOnline() { if (!online) throw new Error("Local tools are disconnected. Wait for reconnection before continuing."); }, async close() { runner.stop(); await closeBinding(); } };
}
