import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTui } from "../src/chat/tui.js";
import { initContext } from "../src/http.js";
import { mockBackend, deferred } from "./tui/backend.js";
import { ScreenTerminal } from "./tui/terminal.js";

let backend: Awaited<ReturnType<typeof mockBackend>>;
let terminal: ScreenTerminal;
let running: Promise<void>;
let temporary: string;
async function screen(text: string) {
  await vi.waitFor(async () => { await terminal.flush(); expect(terminal.lines().join("\n")).toContain(text); }, { timeout: 4000, interval: 20 });
}
async function submit(text: string) { terminal.type(text); terminal.key("\r"); }
function approvalAboveEditor(editorRows = 3) {
  const lines = terminal.lines();
  const bottom = lines.findLastIndex(line => line.startsWith("└"));
  expect(bottom).toBe(terminal.rows - editorRows - 3);
  expect(lines[bottom + 1]).toMatch(/^─/);
}
function footer() { expect(terminal.lines().at(-1)).toContain("Enter send"); }
beforeEach(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), "fwcode-tui-"));
  vi.stubEnv("NO_COLOR", undefined);
  vi.stubEnv("XDG_STATE_HOME", temporary);
  vi.stubEnv("XDG_CONFIG_HOME", temporary);
  backend = await mockBackend();
  initContext({ apiUrl: backend.url, token: "test-only" });
  terminal = new ScreenTerminal();
  running = runTui({}, terminal);
  await screen("What would you like to work on?");
  await screen("Scripted model");
});
afterEach(async () => {
  await backend.close();
  if (terminal.input) { terminal.key("\x03"); await new Promise(resolve => setTimeout(resolve, 30)); if (terminal.input) terminal.key("\x03"); }
  await running;
  await terminal.flush();
  terminal.dispose();
  vi.unstubAllEnvs();
  await rm(temporary, { recursive: true, force: true });
});

describe("TUI through keystrokes, HTTP, SSE and an ANSI terminal emulator", () => {
  it("keeps the submitted message visible throughout a delayed reply and prevents duplicates", async () => {
    await terminal.screenshot("01-ready");
    const gate = deferred();
    backend.replies.push({ text: "I’m inspecting the project.", wait: gate.promise });
    await submit("Inspect the project and explain its entry point.");
    await screen("Inspect the project and explain its entry point.");
    await screen("I’m inspecting the project.");
    await screen("Working…");
    footer();
    await terminal.screenshot("02-streaming");
    terminal.type("Keep this next draft"); terminal.key("\r");
    await screen("A turn is running");
    expect(terminal.lines().join("\n")).toContain("Keep this next draft");
    expect(backend.requests).toHaveLength(1);
    gate.resolve();
    await screen("Scripted model");
    expect(terminal.lines().join("\n").match(/Inspect the project and explain its entry point\./g)).toHaveLength(1);
    expect(terminal.lines().join("\n").match(/I’m inspecting the project\./g)).toHaveLength(1);
    expect(backend.requests[0]).not.toHaveProperty("autoApprove");
    await terminal.screenshot("03-complete-with-draft");
  });

  it("restores a rejected draft and can retry it", async () => {
    backend.replies.push({ fail: "Server is busy. Try again." });
    await submit("Please inspect README.md");
    await screen("Server is busy. Try again.");
    await screen("Send failed");
    footer();
    await terminal.screenshot("04-rejected-draft");
    backend.replies.push({ text: "The README describes the CLI." });
    terminal.key("\r");
    await screen("The README describes the CLI.");
    expect(backend.requests).toHaveLength(2);
    expect((backend.requests[1].message as { parts: unknown[] }).parts).toEqual([{ type: "text", text: "Please inspect README.md" }]);
  });

  it("renders a shell approval, cancels without deciding, then approves through the keyboard", async () => {
    backend.replies.push({ text: "I’ll list the source files.", tool: { name: "bash", input: { command: "rg --files src", timeout_ms: 10000 } } });
    await submit("List the source files");
    await screen("Run shell command");
    expect(terminal.lines().join("\n")).not.toContain('"command":');
    await screen("timeout ms: 10000");
    approvalAboveEditor();
    await terminal.screenshot("05-shell-approval");
    terminal.key("\x1b");
    await submit("another message");
    await screen("Answer the pending approval");
    expect(backend.requests).toHaveLength(1);
    // Clear the preserved draft and reopen the pending decision without sending a new user turn.
    terminal.key("\x15");
    backend.replies.push({ text: "The source files are listed." });
    await submit("/approve");
    await screen("The source files are listed.");
    const approved = backend.requests[1].message as { parts: { approval?: { approved?: boolean } }[] };
    expect(approved.parts.find(part => part.approval)?.approval?.approved).toBe(true);
    await terminal.screenshot("06-approved");
  });

  it("renders an edit diff and denies it without losing the transcript", async () => {
    backend.replies.push({ tool: { name: "edit", input: { file_path: "src/greeting.ts", old_string: 'return "Hello";', new_string: 'return "Hello, world!";' } } });
    await submit("Improve the greeting");
    await screen("Edit file");
    await screen('- return "Hello";');
    await screen('+ return "Hello, world!";');
    await terminal.screenshot("07-edit-diff");
    backend.replies.push({ text: "The file was left unchanged." });
    terminal.key("\r");
    await screen("The file was left unchanged.");
    const denied = backend.requests[1].message as { parts: { approval?: { approved?: boolean } }[] };
    expect(denied.parts.find(part => part.approval)?.approval?.approved).toBe(false);
    await screen("edit · Denied");
  });

  it("keeps approval choices visible while scrolling a long plan and resizing", async () => {
    backend.replies.push({ tool: { name: "present_plan", input: { plan: Array.from({ length: 45 }, (_, i) => `${i + 1}. Review module ${i + 1} and its integration boundary.`).join("\n") } } });
    await submit("Plan the refactor");
    await screen("Approve plan");
    await screen("1. Review module 1");
    await terminal.resize(60, 24);
    await screen("PgUp/PgDn details");
    terminal.key("\x1b[6~");
    await vi.waitFor(async () => { await terminal.flush(); expect(terminal.lines().join("\n")).not.toContain("1. Review module 1 "); });
    await screen("Approve plan");
    await screen("Deny");
    await screen("Esc back");
    approvalAboveEditor();
    await terminal.screenshot("08-plan-narrow");
    for (const [cols, rows] of [[40, 16], [80, 24], [120, 40]]) {
      await terminal.resize(cols, rows);
      approvalAboveEditor();
      expect(terminal.lines().join("\n")).toContain("Deny");
      await terminal.screenshot(`08-plan-bottom-${cols}x${rows}`);
    }
    backend.replies.push({ text: "The plan is approved." });
    terminal.key("\x1b[B"); terminal.key("\r");
    await screen("The plan is approved.");
    footer();
  });

  it("pins the composer through long output, manual scroll, multiline input and resize", async () => {
    const gate = deferred();
    backend.replies.push({ text: Array.from({ length: 80 }, (_, i) => `Line ${i + 1}: deterministic streaming output.`).join("\n\n"), wait: gate.promise });
    await submit("Show a long response");
    await screen("Line 80:");
    footer();
    terminal.key("\x1b[5~");
    await vi.waitFor(async () => { await terminal.flush(); expect(terminal.lines().join("\n")).not.toContain("Line 80:"); });
    footer();
    await terminal.screenshot("09-scrollback");
    terminal.key("\x1b[200~first draft line\nsecond draft line\x1b[201~");
    await screen("second draft line");
    for (const [cols, rows] of [[40, 16], [80, 24], [120, 40]]) {
      await terminal.resize(cols, rows);
      await vi.waitFor(async () => { await terminal.flush(); footer(); expect(terminal.lines().join("\n")).toContain("second draft line"); });
      await terminal.screenshot(`10-resize-${cols}x${rows}`);
    }
    gate.resolve();
    await screen("Scripted model");
    footer();
  });

  it("can answer a cloud-side approval discovered after a rejected send", async () => {
    backend.replies.push({ fail: "Pending approval", pending: {
      id: "cloud-assistant", role: "assistant", parts: [{ type: "tool-bash", toolCallId: "cloud-call", state: "approval-requested", input: { command: "pwd" }, approval: { id: "cloud-approval" } }],
    } });
    await submit("A draft from before the cloud approval");
    await screen("Answer the pending approval, then send your message again.");
    terminal.key("\x15");
    backend.replies.push({ text: "The cloud-side request was denied." });
    await submit("/deny");
    await screen("The cloud-side request was denied.");
    expect((backend.requests[1].message as { id: string }).id).toBe("cloud-assistant");
  });

  it("does not overwrite a newer draft when an earlier send is rejected", async () => {
    const gate = deferred();
    backend.replies.push({ fail: "Try again later.", wait: gate.promise });
    await submit("The rejected message");
    await vi.waitFor(() => expect(backend.requests).toHaveLength(1));
    terminal.type("The newer draft");
    gate.resolve();
    await screen("Try again later.");
    const lines = terminal.lines();
    expect(lines.slice(-5).join("\n")).toContain("The newer draft");
    expect(lines.slice(0, -5).join("\n")).toContain("The rejected message");
  });

  it("renders file contents and preserves extra arguments in approvals", async () => {
    backend.replies.push({ tool: { name: "write", input: { file_path: "src/config.ts", content: 'export const retries = 3;\nexport const timeout = 1000;', workdir: "/project" } } });
    await submit("Write the configuration");
    await screen("Write file");
    await screen("export const retries = 3;");
    await screen("workdir: /project");
    await terminal.screenshot("12-write-approval");
    terminal.key("\x1b");
  });

  it("shows unfamiliar tool arguments as labeled values, including nested values", async () => {
    backend.replies.push({ tool: { name: "connector_update", input: { record_id: "customer-42", changes: { name: "Jane", tags: ["new", "trial"] }, dry_run: false } } });
    await submit("Update the customer");
    await screen("Allow connector update");
    await screen("record id: customer-42");
    await screen("name: Jane");
    await screen("• trial");
    await screen("dry run: false");
    await terminal.screenshot("13-connector-approval");
    terminal.key("\x1b");
  });

  it.each(["\x03", "\x1b"])("stops a held stream with %j and preserves the next draft", async key => {
    const gate = deferred();
    backend.replies.push({ text: "Waiting for a slow operation.", wait: gate.promise });
    await submit("Run a slow operation");
    await screen("Waiting for a slow operation.");
    terminal.type("My next draft");
    terminal.key(key);
    await vi.waitFor(() => expect(backend.requests).toHaveLength(1));
    await screen("My next draft");
    await screen("Stopped");
    expect(backend.stops).toHaveLength(1);
    await terminal.settled();
    footer();
    gate.resolve();
    await terminal.screenshot("14-stopped");
  });

  it("shows interrupted streaming content with an actionable error", async () => {
    backend.replies.push({ text: "This partial reply must remain visible.", truncate: true });
    await submit("Simulate an interrupted connection");
    await screen("Connection ended before the turn finished.");
    await screen("This partial reply must remain visible.");
    footer();
    await terminal.screenshot("11-interrupted");
  });
});


it.each(["shortcut", "dialog"])("enables cloud auto-approval through the %s and follows the resumed transcript", async control => {
  backend.replies.push({ tool: { name: "bash", input: { command: "git status" } } });
  await submit("Check the repository");
  await screen("Run shell command");
  await screen("Auto-approve OFF");
  if (control === "dialog") {
    await screen("Auto-approve tools");
    await terminal.screenshot("21-auto-approve-dialog-option");
    terminal.key("\x1b[B"); terminal.key("\x1b[B"); terminal.key("\r");
  } else terminal.key("\x07");
  await screen("Cloud resumed the tool.");
  await screen("Auto-approve ON");
  expect(backend.approvalSettings).toEqual([true]);
  expect(backend.requests).toHaveLength(1);
  backend.replies.push({ tool: { name: "bash", input: { command: "git diff" } } });
  await submit("Check the diff too");
  await screen("Cloud auto-approved the tool.");
  expect(backend.requests[1]).not.toHaveProperty("autoApprove");
  expect(terminal.lines().join("\n")).not.toContain("Run shell command");
  terminal.key("\x07");
  await screen("Auto-approve OFF");
  expect(backend.approvalSettings).toEqual([true, false]);
});

it.each(["shortcut", "dialog"])("keeps explicit plan approval after enabling auto-approval through the %s", async control => {
  backend.replies.push({ tool: { name: "present_plan", input: { plan: "Review the changes" } } });
  await submit("Make a plan");
  await screen("Approve plan");
  if (control === "dialog") {
    terminal.key("\x1b[B"); terminal.key("\x1b[B"); terminal.key("\r");
  } else terminal.key("\x07");
  await screen("Auto-approve ON");
  await screen("Approve plan");
  expect(backend.requests).toHaveLength(1);
  approvalAboveEditor();
  expect(terminal.lines().join("\n")).not.toContain("Auto-approve tools");
});

it("supports approval mode commands and preserves the saved mode when a toggle is rejected", async () => {
  await submit("/approvals on");
  await screen("Auto-approve ON");
  backend.approvalFailures.push("Only the owner can change approvals");
  terminal.key("\x07");
  await screen("Only the owner can change approvals");
  expect(terminal.lines().join("\n")).toContain("Auto-approve ON");
  await submit("/approvals off");
  await screen("Auto-approve OFF");
  expect(backend.approvalSettings).toEqual([true, false]);
  expect(backend.requests).toHaveLength(0);
});

it("anchors the approval above a multiline draft", async () => {
  const gate = deferred();
  backend.replies.push({ wait: gate.promise, tool: { name: "bash", input: { command: "git status" } } });
  await submit("Check this repository");
  await screen("Working…");
  terminal.key("\x1b[200~First draft line\nSecond draft line\x1b[201~");
  gate.resolve();
  await screen("Run shell command");
  approvalAboveEditor(4);
  await screen("Second draft line");
  await terminal.screenshot("18-approval-above-draft");
});


it("anchors the approval-mode picker above the textbox and cancels without changing the mode", async () => {
  await submit("/approvals");
  await screen("Tool approvals");
  approvalAboveEditor();
  await terminal.resize(80, 24);
  approvalAboveEditor();
  await terminal.screenshot("19-approval-mode-picker");
  terminal.key("\x1b");
  await screen("Enter send");
  expect(backend.approvalSettings).toHaveLength(0);
  expect(backend.stops).toHaveLength(0);
  expect(terminal.input).toBeDefined();
});

it("stops the model with Escape even while the approval-mode picker is open", async () => {
  const gate = deferred();
  backend.replies.push({ text: "Still working", wait: gate.promise });
  await submit("Inspect this project");
  await screen("Still working");
  await submit("/approvals");
  await screen("Tool approvals");
  terminal.key("\x1b");
  await screen("Stopped");
  expect(backend.stops).toHaveLength(1);
  expect(backend.approvalSettings).toHaveLength(0);
  expect(terminal.input).toBeDefined();
});

it("renders thinking Markdown and separates tool results from conversation turns", async () => {
  await terminal.resize(100, 44);
  await submit("/approvals on");
  await screen("Auto-approve ON");
  backend.replies.push({ reasoning: "**Inspecting the repository**\n\n- Read `README.md`.\n- Check the current branch.", text: "I’ll inspect the repository and check its current state.", tool: { name: "bash", input: { command: "git status --short" } } });
  await submit("Inspect this repository");
  await screen("Cloud auto-approved the tool.");
  const lines = terminal.lines().join("\n");
  expect(lines).toContain("Inspecting the repository");
  expect(lines).toContain("README.md");
  expect(lines).not.toContain("**Inspecting the repository**");
  expect(lines).not.toContain("`README.md`");
  backend.replies.push({ text: "The working tree is clean. **Ready for the next change.**" });
  await submit("Summarize the result");
  await screen("Ready for the next change.");
  await terminal.screenshot("20-thinking-and-turn-dividers");
});


it.each(["shortcut", "dialog"])("approves the entire pending batch through the %s when the server only saves the setting", async control => {
  backend.approvalBehavior.resumeOnEnable = false;
  backend.replies.push({ tools: ["one", "two", "three"].map(word => ({ name: "bash", input: { command: `echo ${word}` } })) });
  await submit("Run three commands");
  await screen("Run shell command");
  backend.replies.push({ text: "All three commands completed." });
  if (control === "dialog") { terminal.key("\x1b[B"); terminal.key("\x1b[B"); terminal.key("\r"); }
  else terminal.key("\x07");
  await screen("All three commands completed.");
  await screen("Auto-approve ON");
  expect(backend.approvalSettings).toEqual([true]);
  expect(backend.requests).toHaveLength(2);
  const continuation = backend.requests[1].message as { role: string; parts: { approval?: { id: string; approved: boolean } }[] };
  expect(continuation.role).toBe("assistant");
  const approvals = continuation.parts.flatMap(part => part.approval ? [part.approval] : []);
  expect(approvals).toHaveLength(3);
  expect(approvals.every(approval => approval.approved)).toBe(true);
  expect(new Set(approvals.map(approval => approval.id)).size).toBe(3);
  expect(terminal.lines().join("\n")).not.toContain("Run shell command");
  await terminal.screenshot(`22-client-batch-approval-${control}`);
});

it.each(["present_plan", "ea_calendar_change"])("keeps %s explicit in a mixed batch when the server does not resume", async tool => {
  backend.approvalBehavior.resumeOnEnable = false;
  backend.replies.push({ tools: [{ name: "bash", input: { command: "echo one" } }, { name: tool, input: { plan: "Review this decision." } }] });
  await submit("Request tools and an explicit decision");
  await screen("Run shell command");
  terminal.key("\x1b[B"); terminal.key("\x1b[B"); terminal.key("\r");
  await screen("Auto-approve ON");
  await screen("Review this decision.");
  expect(backend.requests).toHaveLength(1);
  expect(terminal.lines().join("\n")).not.toContain("Auto-approve tools");
  backend.replies.push({ text: "Explicit decision accepted." });
  terminal.key("\x1b[B"); terminal.key("\r");
  await screen("Explicit decision accepted.");
  expect(backend.requests).toHaveLength(2);
});
