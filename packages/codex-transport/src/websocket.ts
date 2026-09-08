import WebSocket from "ws";

export async function* websocketEvents(url: string, headers: Headers, payload: object, signal?: AbortSignal): AsyncGenerator<Record<string, any>> {
  signal?.throwIfAborted();
  const endpoint = new URL(url);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  const handshake = new Headers(headers);
  handshake.delete("Content-Encoding");
  handshake.delete("Content-Type");
  handshake.set("OpenAI-Beta", "responses_websockets=2026-02-06");
  const socket = new WebSocket(endpoint, { headers: Object.fromEntries(handshake), maxPayload: 8 * 1024 * 1024, handshakeTimeout: 30_000, followRedirects: false });
  const queue: Record<string, any>[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let failure: Error | undefined;
  const notify = () => { wake?.(); wake = undefined; };
  const abort = () => { failure = new Error("Codex request aborted"); socket.terminate(); notify(); };
  signal?.addEventListener("abort", abort, { once: true });
  socket.on("open", () => socket.send(JSON.stringify({ type: "response.create", ...payload })));
  socket.on("message", bytes => {
    try {
      if (queue.length >= 1600) throw new Error("Codex event buffer exceeded");
      queue.push(JSON.parse(bytes.toString()));
    } catch { failure = new Error("Invalid Codex WebSocket event"); socket.terminate(); }
    notify();
  });
  socket.on("error", () => { failure = new Error("Codex WebSocket connection failed"); notify(); });
  socket.on("close", () => { ended = true; notify(); });
  try {
    while (true) {
      if (failure) throw failure;
      const event = queue.shift();
      if (event) { yield event; continue; }
      if (ended) break;
      await new Promise<void>(resolve => { wake = resolve; });
    }
  } finally { signal?.removeEventListener("abort", abort); socket.terminate(); }
}
