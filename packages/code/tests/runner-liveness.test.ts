import { afterEach, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { startRunner, startDeviceRunner } from "../src/agent/runner.js";

/**
 * A stream can die without either end seeing it: the server's writes still
 * succeed and the client's socket says nothing for minutes. The runner gives up
 * on a stream that goes quiet and connects again.
 */

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function server(handle: (req: IncomingMessage, res: ServerResponse, attempt: number) => void) {
  const attempts = new Map<string, number>();
  const http = createServer((req, res) => {
    const attempt = (attempts.get(req.url!) ?? 0) + 1;
    attempts.set(req.url!, attempt);
    handle(req, res, attempt);
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  cleanups.push(() => { http.closeAllConnections(); http.close(); });
  return { apiUrl: `http://127.0.0.1:${(http.address() as { port: number }).port}`, attempts: (url: string) => attempts.get(url) ?? 0 };
}
const sse = (res: ServerResponse, frame: object) => {
  if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
};

it("reconnects the device stream once it goes quiet, though the server never closes it", async () => {
  const statuses: boolean[] = [];
  // Every stream says ready and then nothing more, the socket left open.
  const api = await server((_req, res) => sse(res, { type: "ready" }));
  const runner = startDeviceRunner({ apiUrl: api.apiUrl, roots: [], getToken: async () => "token", streamIdleMs: 200, onStatus: online => statuses.push(online) });
  cleanups.push(() => runner.stop());
  await vi.waitFor(() => expect(api.attempts("/api/runners/events")).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
  expect(statuses.slice(0, 3)).toEqual([true, false, true]);
});

it("keeps a stream that hears heartbeats", async () => {
  const api = await server((_req, res) => {
    sse(res, { type: "ready" });
    const beat = setInterval(() => sse(res, { type: "heartbeat" }), 50);
    res.on("close", () => clearInterval(beat));
  });
  const runner = startDeviceRunner({ apiUrl: api.apiUrl, roots: [], getToken: async () => "token", streamIdleMs: 200 });
  cleanups.push(() => runner.stop());
  await new Promise(resolve => setTimeout(resolve, 800));
  expect(api.attempts("/api/runners/events")).toBe(1);
});

it("counts a token that never arrives against the same deadline", async () => {
  const api = await server((_req, res) => sse(res, { type: "ready" }));
  let calls = 0;
  const getToken = () => (++calls === 1 ? new Promise<string>(() => {}) : Promise.resolve("token"));
  const runner = startDeviceRunner({ apiUrl: api.apiUrl, roots: [], getToken, streamIdleMs: 200 });
  cleanups.push(() => runner.stop());
  await vi.waitFor(() => expect(api.attempts("/api/runners/events")).toBeGreaterThanOrEqual(1), { timeout: 5_000 });
});

it("brings back a session that does not reconnect once its stream goes quiet, until the server refuses it", async () => {
  const path = "/api/runner-sessions/session/events";
  const api = await server((_req, res, attempt) => {
    if (attempt <= 2) return sse(res, { type: "ready", connection_id: `connection-${attempt}` });
    res.writeHead(403).end();
  });
  let closed = false;
  const runner = startRunner({ apiUrl: api.apiUrl, roots: [], sessionId: "session", reconnect: false, getToken: async () => "token", streamIdleMs: 200, onClose: () => { closed = true; } });
  cleanups.push(() => runner.stop());
  await vi.waitFor(() => expect(closed).toBe(true), { timeout: 10_000 });
  expect(api.attempts(path)).toBe(3);
});

it("ends a session that does not reconnect when the server ends its stream", async () => {
  const path = "/api/runner-sessions/session/events";
  const api = await server((_req, res) => { sse(res, { type: "ready", connection_id: "connection" }); res.end(); });
  let closed = false;
  const runner = startRunner({ apiUrl: api.apiUrl, roots: [], sessionId: "session", reconnect: false, getToken: async () => "token", streamIdleMs: 200, onClose: () => { closed = true; } });
  cleanups.push(() => runner.stop());
  await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5_000 });
  await new Promise(resolve => setTimeout(resolve, 400));
  expect(api.attempts(path)).toBe(1);
});
