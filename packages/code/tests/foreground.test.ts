import { afterEach, expect, it, vi } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startRunner, startDeviceRunner } from "../src/agent/runner.js";
const cleanups: (() => unknown)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(device = false) {
  const root = await mkdtemp(path.join(tmpdir(), "fwcode-foreground-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let stream: ServerResponse, control: ServerResponse;
  let connections = 0;
  const ready = Promise.withResolvers<void>();
  const pending = new Map<string, { input: object; done: (value: Record<string, unknown>) => void }>();
  const server = createServer(async (req, res) => {
    expect(req.headers.authorization).toBe("Bearer token");
    if (req.url === "/api/runners/events") {
      control = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "ready" })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "start", session_id: "session", root })}\n\n`);
    } else if (req.url?.endsWith("/events")) {
      stream = res;
      connections++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "ready", connection_id: "connection" })}\n\n`);
      ready.resolve();
    } else {
      expect(req.headers["x-runner-connection"]).toBe("connection");
      const request = pending.get(req.url!.split("/").at(-1)!);
      if (!request) { res.writeHead(404).end(); return; }
      if (req.method === "GET") res.end(JSON.stringify(request.input));
      else {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
        request.done(JSON.parse(Buffer.concat(chunks).toString())); res.writeHead(204).end();
      }
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanups.push(() => { server.closeAllConnections(); server.close(); });
  const options = { apiUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, roots: [root], getToken: async () => "token" };
  const runner = device ? startDeviceRunner(options) : startRunner({ ...options, sessionId: "session", reconnect: false });
  cleanups.push(() => runner.stop()); await ready.promise;
  let sequence = 0;
  const send = (frame: object) => stream.write(`data: ${JSON.stringify(frame)}\n\n`);
  const call = (route: string, params: object, id = `request-${++sequence}`) => new Promise<Record<string, unknown>>(done => {
    pending.set(id, { input: { ...params, workdir: root }, done }); send({ type: "request", id, path: route });
  });
  return { root, runner, call, send, disconnect: () => stream.end(), restartJob: async () => {
    const previous = connections;
    stream.end();
    await vi.waitFor(() => {
      control.write(`data: ${JSON.stringify({ type: 'start', session_id: 'session', root })}\n\n`);
      expect(connections).toBeGreaterThan(previous);
    });
  } };
}
it("stops session-owned background processes", async () => {
  const { root, runner, call } = await setup();
  expect((await call("/bash", { command: "sleep 0.5; printf escaped > survived", run_in_background: true })).success).toBe(true);
  runner.stop(); await new Promise(resolve => setTimeout(resolve, 650));
  await expect(readFile(path.join(root, "survived"))).rejects.toThrow();
});
it("rejects a repeated request instead of executing it twice", async () => {
  const { root, send, call } = await setup();
  expect((await call("/bash", { command: "printf once >> counter" }, "same")).success).toBe(true);
  send({ type: "request", id: "same", path: "/bash" });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(await readFile(path.join(root, "counter"), "utf8")).toBe("once");
});
it("supports transfers and rejects escaping paths", async () => {
  const { root, call } = await setup();
  expect((await call("/upload", { filename: "incoming.txt", data: Buffer.from("attachment").toString("base64") })).success).toBe(true);
  expect(await readFile(path.join(root, "incoming.txt"), "utf8")).toBe("attachment");
  expect((await call("/download-archive", { path: root })).success).toBe(true);
  expect((await call("/upload", { filename: "../escape.txt", data: "eA==" })).success).toBe(false);
});
it("does not expose the fwcode API token to local shell commands", async () => {
  vi.stubEnv("FWCODE_TOKEN", "client-secret");
  const { call } = await setup();
  expect((await call("/bash", { command: 'printf "%s" "$FWCODE_TOKEN"' })).stdout).toBe("");
});
it.each(["cancel", "disconnect"])("interrupts foreground work on %s without replay", async action => {
  const { root, call, send, disconnect } = await setup();
  void call("/bash", { command: "printf started > started; sleep 0.5; printf escaped > survived" }, "slow");
  await vi.waitFor(async () => expect(await readFile(path.join(root, "started"), "utf8")).toBe("started"));
  if (action === "cancel") send({ type: "cancel", id: "slow" }); else disconnect();
  await new Promise(resolve => setTimeout(resolve, 650));
  await expect(readFile(path.join(root, "survived"))).rejects.toThrow();
});
it.skipIf(process.platform !== 'darwin')('keeps a desktop shell across executor streams while internal calls stay isolated', async () => {
  vi.stubEnv('SHELL', '/bin/zsh');
  vi.stubEnv('FWCODE_TOKEN', 'client-secret');
  const { root, call, restartJob } = await setup(true);
  vi.stubEnv('ZDOTDIR', root);
  const first = await call('/bash', { command: 'export RETAINED=yes; printf "%s" "$FWCODE_TOKEN"', shell_session: true });
  expect(first.success).toBe(true); expect(first.stdout).toBe('');
  await restartJob();
  const second = await call('/bash', { command: 'printf "%s" "$RETAINED"', shell_session: true });
  expect(second.stdout).toBe('yes'); expect(second.shell_session_id).toBe(first.shell_session_id);
  const isolated = await call('/bash', { command: 'printf "%s" "${RETAINED-unset}"; export RETAINED=no' });
  expect(isolated.stdout).toBe('unset');
  expect((await call('/bash', { command: 'printf "%s" "$RETAINED"', shell_session: true })).stdout).toBe('yes');
  await call('/reap', {});
  expect((await call('/bash', { command: 'printf "%s" "${RETAINED-unset}"', shell_session: true })).stdout).toBe('unset');
});

it("starts an Electron job from the control stream using the same executor", async () => {
  const { root, call } = await setup(true);
  expect((await call("/write", { file_path: "electron.txt", content: "shared executor" })).success).toBe(true);
  expect(await readFile(path.join(root, "electron.txt"), "utf8")).toBe("shared executor");
});
