import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTui } from "../src/chat/tui.js";
import { api, initContext } from "../src/http.js";
import { localState } from "../src/chat/state.js";
import type { Conversation } from "../src/chat/protocol.js";
import { ScreenTerminal } from "./tui/terminal.js";

it("auto-approves successive real local tools through the real app, then restores manual approval", async () => {
  const file = process.env.FWCODE_TEST_CONFIG;
  if (!file) throw new Error("Start the app's scripts/fwcode-test-server.ts and set FWCODE_TEST_CONFIG to its credential file. See tests/tui/README.md.");
  const { apiUrl, token } = JSON.parse(await readFile(file, "utf8")) as { apiUrl: string; token: string };
  if (!/^https?:$/.test(new URL(apiUrl).protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(apiUrl).hostname)) throw new Error("The live harness requires a loopback test server");
  const root = await mkdtemp(path.join(tmpdir(), "fwcode-real-tui-"));
  vi.stubEnv("XDG_STATE_HOME", root);
  vi.stubEnv("XDG_CONFIG_HOME", root);
  vi.stubEnv("NO_COLOR", undefined);
  initContext({ apiUrl, token });
  const terminal = new ScreenTerminal(110, 42);
  const running = runTui({ root, model: "mock-toolgpt-1" }, terminal);
  async function screen(text: string) {
    await vi.waitFor(async () => { await terminal.flush(); expect(terminal.lines().join("\n")).toContain(text); }, { timeout: 60_000, interval: 50 });
  }
  async function conversation(): Promise<Conversation> {
    const id = localState(root).conversation;
    expect(id).toBeDefined();
    const response = await api(`/api/conversations/${id}`);
    expect(response.status).toBe(200);
    return response.json();
  }
  function submit(text: string) { terminal.type(text); terminal.key("\r"); }
  try {
    await screen("mock-toolgpt-1");
    submit("Run [chain-bash-image]");
    await screen("Run shell command");
    await screen("Auto-approve tools");
    await terminal.screenshot("live-01-first-tool-approval");
    terminal.key("\x1b[B"); terminal.key("\x1b[B"); terminal.key("\r");
    await screen("Finished the tool run.");
    await screen("Auto-approve ON");
    const first = await conversation();
    expect(first.auto_approve).toBe(true);
    expect(first.turn_active).toBe(false);
    const tools = first.messages!.flatMap(message => message.parts).filter(part => part.type === "tool-bash");
    expect(tools).toHaveLength(3);
    for (const [index, word] of ["one", "two", "three"].entries()) {
      expect(tools[index]).toMatchObject({ state: "output-available", output: { output: expect.stringContaining(`${word}\n`), exit_code: 0, success: true } });
    }
    expect(terminal.lines().join("\n")).not.toContain("Run shell command");
    await terminal.screenshot("live-02-three-tools-complete");

    submit("Run [bash: printf fourth > proof]");
    await vi.waitFor(async () => { expect(await readFile(path.join(root, "proof"), "utf8")).toBe("fourth"); }, { timeout: 30_000 });
    await screen("mock-toolgpt-1");
    expect((await conversation()).auto_approve).toBe(true);
    expect(terminal.lines().join("\n")).not.toContain("Run shell command");
    await terminal.screenshot("live-03-next-turn-complete");

    terminal.key("\x07");
    await screen("Auto-approve OFF");
    submit("Run [bash: touch denied]");
    await screen("Run shell command");
    terminal.key("\r");
    await screen("bash · Denied");
    await screen("mock-toolgpt-1");
    await expect(readFile(path.join(root, "denied"))).rejects.toThrow();
    await terminal.screenshot("live-04-disabled-and-denied");

    terminal.key("\x07");
    await screen("Auto-approve ON");
    const id = localState(root).conversation;
    const planMode = await api(`/api/conversations/${id}`, {
      method: "PATCH", headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ plan_mode: true }),
    });
    expect(planMode.status).toBe(200);
    submit('Plan [present_plan: {"plan":"Review the implementation."}]');
    await screen("Approve plan");
    expect((await conversation()).messages!.flatMap(message => message.parts)).toContainEqual(expect.objectContaining({ type: "tool-present_plan", state: "approval-requested" }));
    expect(terminal.lines().join("\n")).not.toContain("Auto-approve tools");
    await terminal.screenshot("live-05-plan-still-explicit");
  } catch (error) {
    await terminal.screenshot("live-failure");
    throw error;
  } finally {
    if (terminal.input) { terminal.key("\x1b"); terminal.key("\x03"); }
    await running;
    await terminal.flush();
    terminal.dispose();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
