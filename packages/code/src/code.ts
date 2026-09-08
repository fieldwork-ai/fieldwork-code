#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "node:module";
import { rmSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { initContext } from "./http.js";
import { login } from "./oauth.js";
import { loginConfigPath } from "./config.js";
import { localState, saveLocalState } from "./chat/state.js";

const { version } = createRequire(import.meta.url)("../package.json");
const program = new Command("fwcode").description("Chat with Fieldwork using tools in this directory").version(version);
program.command("login").description("Sign into Fieldwork and choose an organization").action(async () => { await login(initContext({}).config.apiUrl); });
program.command("logout").description("Remove this client's Fieldwork login").action(() => { rmSync(loginConfigPath(), { force: true }); });
program.option("--continue", "resume this directory's last conversation").option("--resume <id>", "resume a conversation").action(async options => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("fwcode requires an interactive terminal");
  if (options.continue && options.resume) throw new Error("Choose --continue or --resume");
  if (!initContext({}).config.token) { await login(initContext({}).config.apiUrl); initContext({}); }
  const root = realpathSync(process.cwd());
  const state = localState(root);
  if (!state.approved) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    let answer: string;
    try { answer = await input.question(`Allow Fieldwork to read, write, edit, and run shell commands in ${root}? Shell commands run with your OS permissions. [y/N] `); } finally { input.close(); }
    if (!/^y(es)?$/i.test(answer.trim())) return;
    saveLocalState(root, { ...state, approved: true });
  }
  const conversation = options.resume ?? (options.continue ? state.conversation : undefined);
  if (options.continue && !conversation) throw new Error("No previous conversation for this directory");
  const { runTui } = await import("./chat/tui.js");
  await runTui({ conversation, root });
});
program.parseAsync().catch(error => { process.stderr.write(`fwcode: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
