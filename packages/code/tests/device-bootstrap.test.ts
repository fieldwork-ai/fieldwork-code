import { afterEach, expect, it, vi } from "vitest";
import { startDeviceRunner } from "../src/agent/runner.js";
const runners: ReturnType<typeof startDeviceRunner>[] = [];
afterEach(() => { for (const runner of runners.splice(0)) runner.stop(); vi.unstubAllGlobals(); });
function stream(frames: object[]) {
  return new Response(new ReadableStream({ start(c) { for (const frame of frames) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`)); } }), { headers: { "Content-Type": "text/event-stream" } });
}
it("waits for preparation, deduplicates notifications, and advertises capabilities", async () => {
  let release!: (root: string) => void;
  const prepareJob = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
  const fetcher = vi.fn(async (url: string) => url.endsWith('/api/runners/events') ? stream([{ type: "start", session_id: "job", root: "/working/conversation" }, { type: "start", session_id: "job", root: "/working/conversation" }]) : stream([{ type: "ready", connection_id: "connection" }]));
  vi.stubGlobal("fetch", fetcher);
  runners.push(startDeviceRunner({ apiUrl: "https://example.test", roots: ["/working"], capabilities: ["managed-worktrees-v1"], getToken: async () => "token", prepareJob }));
  await vi.waitFor(() => expect(prepareJob).toHaveBeenCalledTimes(1));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toBeDefined();
  release("/working/conversation");
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
});
it("does not start after a rejected preparation or after shutdown", async () => {
  let release!: (root: string) => void;
  const fetcher = vi.fn(async () => stream([{ type: "start", session_id: "job", root: "/working/conversation" }]));
  vi.stubGlobal("fetch", fetcher);
  const prepareJob = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
  const runner = startDeviceRunner({ apiUrl: "https://example.test", roots: [], getToken: async () => "token", prepareJob }); runners.push(runner);
  await vi.waitFor(() => expect(prepareJob).toHaveBeenCalledOnce());
  runner.stop(); release("/working/conversation");
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("legacy devices reject directories they did not authorize", async () => {
  const fetcher = vi.fn(async () => stream([{ type: "start", session_id: "job", root: "/elsewhere" }])); vi.stubGlobal("fetch", fetcher);
  runners.push(startDeviceRunner({ apiUrl: "https://example.test", roots: ["/working"], getToken: async () => "token" }));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(fetcher).toHaveBeenCalledTimes(1);
});
