import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConversationLog } from "../src/chat/log.js";
import { initContext } from "../src/http.js";
import { localState, saveLocalState, machineKey } from "../src/chat/state.js";
import { resolveConfig } from "../src/config.js";
afterEach(() => vi.unstubAllEnvs());
it("appends snapshots and approvals, deduplicates resume, and excludes message metadata", () => {
  vi.stubEnv("XDG_STATE_HOME", mkdtempSync(path.join(tmpdir(), "fwcode-log-")));
  const warn = vi.fn();
  initContext({ apiUrl: "https://example.test", token: "known-access-secret" });
  const log = new ConversationLog("conversation-1", warn);
  const message = { id: "m", role: "assistant" as const, parts: [{ type: "text" as const, text: "hello known-access-secret" }], metadata: { authorization: "SECRET" } };
  log.message(message); log.message(message);
  log.append("approval", { approval_id: "a", approved: false });
  const resumed = new ConversationLog("conversation-1", warn);
  resumed.message(message);
  resumed.message({ ...message, parts: [{ type: "text", text: "complete" }] });
  resumed.append("interruption", {});
  const contents = readFileSync(log.path, "utf8");
  expect(contents.trim().split("\n").map(line => JSON.parse(line).type)).toEqual(["message", "approval", "message", "interruption"]);
  expect(contents).not.toContain("SECRET");
  expect(contents).not.toContain("known-access-secret");
  expect(statSync(log.path).mode & 0o777).toBe(0o600);
  expect(statSync(path.dirname(log.path)).mode & 0o777).toBe(0o700);
  expect(warn).not.toHaveBeenCalled();
});
it("warns once and continues when storage is not writable", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fwcode-log-"));
  const file = path.join(root, "file"); writeFileSync(file, "");
  vi.stubEnv("XDG_STATE_HOME", file);
  const warn = vi.fn(); const log = new ConversationLog("c", warn);
  expect(() => { log.append("interruption", {}); log.append("interruption", {}); }).not.toThrow();
  expect(warn).toHaveBeenCalledOnce();
});
it("scopes directory resume to the account, org, API and directory", () => {
  vi.stubEnv("XDG_STATE_HOME", mkdtempSync(path.join(tmpdir(), "fwcode-state-")));
  const token = (sub: string) => Buffer.from(JSON.stringify({ sub, org: "org" })).toString("base64url") + ".sig";
  initContext({ apiUrl: "https://one", token: token("one") });
  saveLocalState("/repo", { approved: true, conversation: "c1" });
  expect(localState("/repo").conversation).toBe("c1");
  expect(localState("/elsewhere")).toEqual({});
  initContext({ apiUrl: "https://one", token: token("two") });
  expect(localState("/repo")).toEqual({});
});
it("does not reuse the asset CLI's login or environment", () => {
  vi.stubEnv("XDG_CONFIG_HOME", mkdtempSync(path.join(tmpdir(), "fwcode-auth-")));
  vi.stubEnv("FIELDWORK_TOKEN", "asset-secret"); vi.stubEnv("FIELDWORK_API_URL", "https://asset");
  vi.stubEnv("FWCODE_TOKEN", ""); vi.stubEnv("FWCODE_API_URL", "");
  expect(resolveConfig({}).token).toBeNull();
});

it("keeps machine identity stable across directories and scopes it to the account", () => {
  vi.stubEnv("XDG_STATE_HOME", mkdtempSync(path.join(tmpdir(), "fwcode-machine-")));
  const token = (sub: string) => Buffer.from(JSON.stringify({ sub, org: "org" })).toString("base64url") + ".sig";
  initContext({ apiUrl: "https://one", token: token("one") });
  const key = machineKey();
  saveLocalState("/repo", { approved: true });
  expect(machineKey()).toBe(key);
  initContext({ apiUrl: "https://one", token: token("two") });
  expect(machineKey()).not.toBe(key);
});
