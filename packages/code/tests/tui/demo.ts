import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTui } from "../../src/chat/tui.js";
import { initContext } from "../../src/http.js";
import { mockBackend } from "./backend.js";

const temporary = await mkdtemp(path.join(tmpdir(), "fwcode-demo-"));
const stateBefore = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = temporary;
const backend = await mockBackend([{
  id: "welcome", role: "assistant", parts: [{ type: "text", text: "This is a local, scripted demo. No model or tools execute.\n\nTry **thinking**, **shell**, **edit**, **write**, **plan**, **long**, **stream**, or **fail**. Use /quit to exit." }],
}], message => {
  if (message.role === "assistant") return { text: "Your decision was recorded. This demo does not execute tools." };
  const text = message.parts.filter(part => part.type === "text").map(part => part.text).join(" ").toLowerCase();
  if (text.includes("thinking")) return { reasoning: "**Inspecting the repository**\n\n- Read `README.md`.\n- Check the current branch.\n\nI’ll compare the result with the **project instructions**.", text: "I’ll inspect the repository and check its current state.", tool: { name: "bash", input: { command: "git status --short" } } };
  if (text.includes("shell")) return { tool: { name: "bash", input: { command: "rg --files src", timeout_ms: 10000 } } };
  if (text.includes("edit")) return { tool: { name: "edit", input: { file_path: "src/greeting.ts", old_string: 'return "Hello";', new_string: 'return "Hello, world!";' } } };
  if (text.includes("write")) return { tool: { name: "write", input: { file_path: "src/greeting.ts", content: 'export function greeting(name: string) {\n  return `Hello, ${name}!`;\n}\n' } } };
  if (text.includes("plan")) return { tool: { name: "present_plan", input: { plan: "## Refactor the greeting\n\n1. Inspect the existing implementation.\n2. Update the greeting and callers.\n3. Run the tests and inspect the output.\n\n" + Array.from({ length: 30 }, (_, i) => `- Review module ${i + 1}.`).join("\n") } } };
  if (text.includes("long")) return { text: Array.from({ length: 80 }, (_, i) => `Line ${i + 1}: scroll this transcript while the composer stays at the bottom.`).join("\n\n") };
  if (text.includes("fail")) return { fail: "The scripted server rejected this message. Your draft is preserved." };
  if (text.includes("stream")) return { text: "This reply is held open for three seconds. Try typing the next draft while it runs.", wait: new Promise(resolve => setTimeout(resolve, 3000)) };
  return { text: "Try **thinking**, **shell**, **edit**, **write**, **plan**, **long**, **stream**, or **fail**." };
});
try {
  initContext({ apiUrl: backend.url, token: "local-demo-only" });
  await runTui({});
} finally {
  await backend.close();
  if (stateBefore === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = stateBefore;
  await rm(temporary, { recursive: true, force: true });
}
