import { setTimeout as delay } from "node:timers/promises";
import { routes } from "./router.js";
import { runnerRoots, runnerSignal, resolveRoot } from "./tools/workspace.js";
import { interruptForeground, reapBackground } from "./tools/bash.js";
import { runnerShell, ShellSessionManager, PERSISTENT_SHELL_CAPABILITY } from "./tools/shell-session.js";

export interface ConnectionOptions { apiUrl: string; getToken: () => Promise<string>; onStatus?: (online: boolean) => void; streamIdleMs?: number }
export interface RunnerOptions extends ConnectionOptions { sessionId: string; roots: string[]; reconnect?: boolean; onClose?: () => void; shellManager?: ShellSessionManager }
/**
 * The server writes a heartbeat every 5 seconds. A connection can die without
 * either end seeing it, and the socket may take many minutes to say so, so a
 * stream that has gone this long without a byte is treated as dead.
 */
export const STREAM_IDLE_MS = 20_000;
class StreamStalled extends Error { constructor() { super("Execution stream went quiet"); } }
class HttpError extends Error { constructor(readonly status: number) { super(`Executor request failed (${status})`); } }
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
async function request(options: ConnectionOptions, path: string, signal: AbortSignal, init: RequestInit = {}) {
  const token = await untilAborted(options.getToken(), signal);
  const response = await fetch(`${options.apiUrl.replace(/\/$/, "")}${path}`, { ...init, signal, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new HttpError(response.status);
  return response;
}
/** Opens an event stream and reads it to its end, aborting it once it goes quiet (`streamIdleMs`). */
async function events(options: ConnectionOptions, path: string, signal: AbortSignal, init: RequestInit, onEvent: (event: Record<string, unknown>) => void) {
  const quiet = new AbortController(), connection = AbortSignal.any([signal, quiet.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => quiet.abort(new StreamStalled()), options.streamIdleMs ?? STREAM_IDLE_MS); };
  arm();
  try {
    const response = await request(options, path, connection, init);
    if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) throw new Error("Expected an execution stream");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        arm();
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
  } catch (error) {
    throw quiet.signal.aborted && !signal.aborted ? quiet.signal.reason : error;
  } finally { clearTimeout(timer); quiet.abort(); }
}
export function startRunner(options: RunnerOptions): { stop: () => void } {
  const lifetime = new AbortController(), seen = new Set<string>();
  let active: AbortController | undefined;
  const prefix = `/api/runner-sessions/${encodeURIComponent(options.sessionId)}`;
  async function connect() {
    let attempts = 0, recovering = false;
    do {
      const connection = new AbortController(); active = connection;
      const signal = AbortSignal.any([connection.signal, lifetime.signal]);
      const calls = new Map<string, AbortController>();
      let connectionId: string | undefined, failure: unknown;
      try {
        await events(options, `${prefix}/events`, signal, {}, frame => {
          if (frame.type === "ready" && typeof frame.connection_id === "string") { connectionId = frame.connection_id; attempts = 0; recovering = false; options.onStatus?.(true); return; }
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
              try {
                const execute = () => runnerSignal.run(callSignal, () => routes[`POST ${route}`]({ ...params, workdir: checked.root }));
                return await (options.shellManager
                  ? runnerShell.run({ manager: options.shellManager, key: options.sessionId, root: checked.root }, execute)
                  : execute());
              }
              catch (error) { return { success: false, error: error instanceof Error ? error.message : "Local execution failed" }; }
            });
            await request(options, path, callSignal, { method: "POST", headers, body: JSON.stringify(result) });
          })().catch(() => { if (!callSignal.aborted) connection.abort(); }).finally(() => calls.delete(id));
        });
      } catch (error) { failure = error; } finally {
        connection.abort(); options.onStatus?.(false);
        options.shellManager?.interrupt(options.sessionId);
        for (const root of options.roots) interruptForeground(root);
      }
      if (lifetime.signal.aborted) break;
      // A runner that does not reconnect still comes back from a stream it gave
      // up on itself, since the server cannot know that one died and holds the
      // session for it. It retries until the server answers: a new stream, or a refusal.
      if (failure instanceof StreamStalled) recovering = true;
      else if (failure instanceof HttpError) recovering = false;
      if (options.reconnect === false && !recovering) break;
      await delay(Math.min(30_000, 1000 * 2 ** attempts++), undefined, { signal: lifetime.signal }).catch(() => {});
    } while (!lifetime.signal.aborted);
    for (const root of options.roots) reapBackground(root);
    options.onClose?.();
  }
  void connect();
  return { stop() { lifetime.abort(); active?.abort(); options.shellManager?.dispose(options.sessionId); for (const root of options.roots) { interruptForeground(root); reapBackground(root); } } };
}
export interface DeviceRunnerOptions extends ConnectionOptions {
  roots: string[];
  prepareJob?: (frame: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
  onControl?: (frame: Record<string, unknown>, signal: AbortSignal) => Promise<void>;
  capabilities?: string[];
}
export function startDeviceRunner(options: DeviceRunnerOptions): { stop: () => void } {
  const shellManager = process.platform === 'darwin' ? new ShellSessionManager() : undefined;
  const capabilities = [...(options.capabilities ?? []), ...(shellManager ? [PERSISTENT_SHELL_CAPABILITY] : [])];
  const lifetime = new AbortController(), jobs = new Map<string, ReturnType<typeof startRunner>>();
  const preparing = new Set<string>(), controls = new Set<string>();
  void (async () => {
    let attempts = 0;
    while (!lifetime.signal.aborted) {
      try {
        await events(options, "/api/runners/events", lifetime.signal, { headers: { "X-Runner-Capabilities": capabilities.join(",") } }, frame => {
          if (frame.type === "ready") { attempts = 0; options.onStatus?.(true); return; }
          if (frame.type === "heartbeat") return;
          if (frame.type === "control" && typeof frame.id === "string" && options.onControl) {
            const id = frame.id;
            if (!jobs.size && !preparing.size && !controls.has(id) && controls.size < 16) {
              controls.add(id);
              shellManager?.close();
              void options.onControl(frame, lifetime.signal).catch(() => {}).finally(() => controls.delete(id));
            }
            return;
          }
          if (frame.type !== "start" || typeof frame.session_id !== "string" || typeof frame.root !== "string") throw new Error("Invalid job notification");
          const id = frame.session_id, root = frame.root;
          if (!options.prepareJob && !options.roots.includes(root)) throw new Error("Invalid job notification");
          if (!controls.size && !jobs.has(id) && !preparing.has(id) && preparing.size < 16) {
            preparing.add(id);
            void (async () => {
              const checked = options.prepareJob ? await options.prepareJob(frame, lifetime.signal) : root;
              lifetime.signal.throwIfAborted();
              if (checked !== root) throw new Error("Prepared directory does not match job");
              jobs.set(id, startRunner({ ...options, shellManager, sessionId: id, roots: [checked], onStatus: undefined, reconnect: false, onClose: () => jobs.delete(id) }));
            })().catch(() => {}).finally(() => preparing.delete(id));
          }
        });
      } catch {} finally { shellManager?.close(); options.onStatus?.(false); }
      await delay(Math.min(30_000, 1000 * 2 ** attempts++), undefined, { signal: lifetime.signal }).catch(() => {});
    }
  })();
  return { stop() { lifetime.abort(); for (const job of jobs.values()) job.stop(); jobs.clear(); shellManager?.close(); } };
}
