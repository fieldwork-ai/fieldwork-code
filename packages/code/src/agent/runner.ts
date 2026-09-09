import { setTimeout as delay } from "node:timers/promises";
import { routes } from "./router.js";
import { runnerRoots, runnerSignal, resolveRoot } from "./tools/workspace.js";
import { interruptForeground, reapBackground } from "./tools/bash.js";

interface ConnectionOptions { apiUrl: string; getToken: () => Promise<string>; onStatus?: (online: boolean) => void }
export interface RunnerOptions extends ConnectionOptions { sessionId: string; roots: string[]; reconnect?: boolean; onClose?: () => void }
async function request(options: ConnectionOptions, path: string, signal: AbortSignal, init: RequestInit = {}) {
  const response = await fetch(`${options.apiUrl.replace(/\/$/, "")}${path}`, { ...init, signal, headers: { ...init.headers, Authorization: `Bearer ${await options.getToken()}` } });
  if (!response.ok) throw new Error(`Executor request failed (${response.status})`);
  return response;
}
async function events(response: Response, onEvent: (event: Record<string, unknown>) => void) {
  if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) throw new Error("Expected an execution stream");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (frame.length > 16_384) throw new Error("Execution event exceeds limit");
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data) onEvent(JSON.parse(data));
      }
      if (buffer.length > 16_384) throw new Error("Execution event exceeds limit");
    }
  } finally { await reader.cancel().catch(() => {}); }
}
export function startRunner(options: RunnerOptions): { stop: () => void } {
  const lifetime = new AbortController(), seen = new Set<string>();
  let active: AbortController | undefined;
  const prefix = `/api/runner-sessions/${encodeURIComponent(options.sessionId)}`;
  async function connect() {
    let attempts = 0;
    do {
      const connection = new AbortController(); active = connection;
      const signal = AbortSignal.any([connection.signal, lifetime.signal]);
      const calls = new Map<string, AbortController>();
      let connectionId: string | undefined;
      try {
        await events(await request(options, `${prefix}/events`, signal), frame => {
          if (frame.type === "ready" && typeof frame.connection_id === "string") { connectionId = frame.connection_id; attempts = 0; options.onStatus?.(true); return; }
          if (frame.type === "heartbeat") return;
          if (frame.type === "cancel" && typeof frame.id === "string") { calls.get(frame.id)?.abort(); return; }
          if (frame.type !== "request" || typeof frame.id !== "string" || typeof frame.path !== "string" || !connectionId || !routes[`POST ${frame.path}`]) throw new Error("Invalid execution request");
          if (seen.has(frame.id) || seen.size >= 100_000 || calls.size >= 16) throw new Error("Duplicate or excessive execution request");
          const id = frame.id, route = frame.path, abort = new AbortController();
          seen.add(id); calls.set(id, abort);
          const callSignal = AbortSignal.any([signal, abort.signal]);
          const headers = { "X-Runner-Connection": connectionId, "Content-Type": "application/json" };
          const path = `${prefix}/requests/${encodeURIComponent(id)}`;
          void (async () => {
            const input = await request(options, path, callSignal, { headers });
            if (Number(input.headers.get("content-length")) > 750 * 1024 * 1024) throw new Error("Execution input exceeds limit");
            const params = await input.json();
            const result = await runnerRoots.run(options.roots, async () => {
              const checked = resolveRoot(params.workdir);
              if (!checked.ok) return { success: false, error: checked.error };
              try { return await runnerSignal.run(callSignal, () => routes[`POST ${route}`]({ ...params, workdir: checked.root })); }
              catch (error) { return { success: false, error: error instanceof Error ? error.message : "Local execution failed" }; }
            });
            await request(options, path, callSignal, { method: "POST", headers, body: JSON.stringify(result) });
          })().catch(() => { if (!callSignal.aborted) connection.abort(); }).finally(() => calls.delete(id));
        });
      } catch {} finally {
        connection.abort(); options.onStatus?.(false);
        for (const root of options.roots) interruptForeground(root);
      }
      if (options.reconnect === false || lifetime.signal.aborted) break;
      await delay(Math.min(30_000, 1000 * 2 ** attempts++), undefined, { signal: lifetime.signal }).catch(() => {});
    } while (!lifetime.signal.aborted);
    options.onClose?.();
  }
  void connect();
  return { stop() { lifetime.abort(); active?.abort(); for (const root of options.roots) { interruptForeground(root); reapBackground(root); } } };
}
export function startDeviceRunner(options: ConnectionOptions & { roots: string[] }): { stop: () => void } {
  const lifetime = new AbortController(), jobs = new Map<string, ReturnType<typeof startRunner>>();
  void (async () => {
    let attempts = 0;
    while (!lifetime.signal.aborted) {
      try {
        await events(await request(options, "/api/runners/events", lifetime.signal), frame => {
          if (frame.type === "ready") { attempts = 0; options.onStatus?.(true); return; }
          if (frame.type === "heartbeat") return;
          if (frame.type !== "start" || typeof frame.session_id !== "string" || typeof frame.root !== "string" || !options.roots.includes(frame.root)) throw new Error("Invalid job notification");
          const id = frame.session_id;
          if (!jobs.has(id)) jobs.set(id, startRunner({ ...options, sessionId: id, roots: [frame.root], onStatus: undefined, reconnect: false, onClose: () => jobs.delete(id) }));
        });
      } catch {} finally { options.onStatus?.(false); }
      await delay(Math.min(30_000, 1000 * 2 ** attempts++), undefined, { signal: lifetime.signal }).catch(() => {});
    }
  })();
  return { stop() { lifetime.abort(); for (const job of jobs.values()) job.stop(); jobs.clear(); } };
}
