import { appendFileSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { UIMessage } from "ai";
import { getContext } from "../http.js";
import { stateHome } from "./state.js";

export class ConversationLog {
  readonly path: string;
  private snapshots = new Map<string, string>();
  private failed = false;
  constructor(readonly conversationId: string, private warn: (text: string) => void) {
    if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) throw new Error("Invalid conversation identifier");
    this.path = path.join(stateHome(), "conversations", `${conversationId}.jsonl`);
    try {
      const existing = readFileSync(this.path, "utf8");
      if (existing && !existing.endsWith("\n")) appendFileSync(this.path, "\n");
      for (const line of existing.split("\n")) {
        try { const record = JSON.parse(line); if (record.type === "message" && record.message?.id && record.digest) this.snapshots.set(record.message.id, record.digest); } catch { /* A crash can leave an incomplete final record. */ }
      }
    } catch {}
  }
  private serialize(value: unknown): string {
    let secrets: string[] = [];
    try { const config = getContext().config; secrets = [config.token, config.login?.refresh_token].filter((s): s is string => !!s); } catch {}
    return JSON.stringify(value, (key, item) => {
      if (/^(authorization|access_?token|refresh_?token)$/i.test(key)) return "[redacted]";
      if (typeof item !== "string") return item;
      for (const secret of secrets) item = item.split(secret).join("[redacted]");
      return item;
    });
  }
  append(type: string, data: Record<string, unknown>) {
    if (this.failed) return;
    try {
      mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
      chmodSync(path.dirname(this.path), 0o700);
      appendFileSync(this.path, this.serialize({ version: 1, timestamp: new Date().toISOString(), conversation_id: this.conversationId, type, ...data }) + "\n", { mode: 0o600 });
      chmodSync(this.path, 0o600);
    } catch { this.failed = true; this.warn(`Could not write conversation log: ${this.path}`); }
  }
  message(message: UIMessage) {
    // Explicit fields prevent transport metadata or authentication headers entering the log.
    const snapshot = { id: message.id, role: message.role, parts: message.parts };
    const digest = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    if (this.snapshots.get(message.id) === digest) return;
    this.append("message", { message: snapshot, digest });
    this.snapshots.set(message.id, digest);
  }
}
