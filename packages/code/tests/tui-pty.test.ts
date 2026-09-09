import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ScreenTerminal } from "./tui/terminal.js";

it.skipIf(process.platform === "win32")("drives ProcessTerminal in a real PTY against the scripted HTTP backend", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fwcode-pty-"));
  try {
    await promisify(execFile)("python3", ["-B", "tests/tui/drive_terminal.py", directory, "node_modules/.bin/tsx", "tests/tui/demo.ts"], { timeout: 25000 });
    const frames = JSON.parse(await readFile(path.join(directory, "frames.json"), "utf8")) as { name: string; file: string; columns: number; rows: number }[];
    for (const frame of frames) {
      const terminal = new ScreenTerminal(frame.columns, frame.rows);
      try {
        terminal.write(await readFile(path.join(directory, frame.file), "utf8"));
        await terminal.flush();
        const text = terminal.lines().join("\n");
        expect(text).toContain("Fieldwork Code");
        if (frame.name.includes("streaming")) {
          expect(text).toContain("You");
          expect(text).toContain("stream");
          expect(text).toContain("held open");
        }
        if (frame.name.includes("edit")) {
          expect(text).toContain("Edit file");
          expect(text).toContain('- return "Hello";');
          expect(text).toContain('+ return "Hello, world!";');
          expect(text).toContain("Deny");
          expect(text).toContain("Approve");
        } else expect(terminal.lines().at(-1)).toContain("Enter send");
        if (frame.name.includes("scrolled")) expect(text).not.toContain("Line 80:");
        await terminal.screenshot(frame.name);
      } finally { terminal.dispose(); }
    }
  } catch (error) {
    const evidence = path.resolve("../../.logs/tui-pty-failure");
    await mkdir(evidence, { recursive: true });
    await cp(directory, evidence, { recursive: true });
    throw error;
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);
