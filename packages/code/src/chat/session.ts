import { setTimeout as delay } from "node:timers/promises";
import { hostname } from "node:os";
import { ConversationLog } from "./log.js";
import { connectLocal } from "./local.js";
import { localState, saveLocalState, machineKey } from "./state.js";
import { connectCodex } from "./codex.js";
import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { api, requireOrgId } from "../http.js";
import { consumeTurn } from "./stream.js";
import { pendingApprovals, respondToApproval, isUnsentMessage, type Conversation } from "./protocol.js";

export type Choose = (title: string, items: { value: string; label: string; description?: string }[]) => Promise<string | undefined>;
export class CodeSession {
  conversation!: Conversation;
  messages: UIMessage[] = [];
  busy = false;
  private lifetime = new AbortController();
  private log?: ConversationLog;
  private local?: Awaited<ReturnType<typeof connectLocal>>;
  private partial?: UIMessage;
  private controller?: AbortController;
  private changingApprovals = false;
  constructor(readonly events: {
    transcript: (messages: UIMessage[]) => void;
    streaming: (message: UIMessage) => void;
    status: (text: string) => void;
  }) {}
  private get path() { return `/api/conversations/${encodeURIComponent(this.conversation.conversation_id)}`; }
  private async json<T>(path: string, init?: RequestInit & { body?: string }): Promise<T> {
    const response = await api(path, init);
    if (response.status === 404 && path === "/api/runners/identity") throw new Error("This Fieldwork server needs an upgrade to support fwcode 0.16 own-machine conversations.");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
    return body as T;
  }
  async open(options: { conversation?: string; model?: string; root?: string }) {
    const identity = options.root ? await this.json<{ runner_device_id: string }>("/api/runners/identity", { method: "POST", body: JSON.stringify({ machine_key: machineKey(), name: hostname(), platform: process.platform, root: options.root }) }) : undefined;
    this.conversation = options.conversation
      ? await this.json<Conversation>(`/api/conversations/${encodeURIComponent(options.conversation)}`)
      : await this.json<Conversation>("/api/conversations", { method: "POST", body: JSON.stringify({ title: "Fieldwork Code", model: options.model, ...(identity && { compute_backend: "own_machine", runner_device_id: identity.runner_device_id, runner_root: options.root }) }) });
    this.messages = this.conversation.messages ?? [];
    this.log ??= new ConversationLog(this.conversation.conversation_id, this.events.status);
    for (const message of this.messages) this.log.message(message);
    this.events.transcript(this.messages);
    if (options.root) {
      this.local = await connectLocal(this.conversation.conversation_id, options.root, identity!.runner_device_id, this.events.status);
      try { saveLocalState(options.root, { ...localState(options.root), conversation: this.conversation.conversation_id }); } catch { this.events.status("Could not save directory resume state"); }
    }
    this.events.status(this.conversation.model);
  }
  get pending() { return pendingApprovals(this.messages.findLast(message => !isUnsentMessage(message))); }
  async reload() {
    this.conversation = await this.json<Conversation>(this.path);
    this.messages = this.conversation.messages ?? [];
    this.log ??= new ConversationLog(this.conversation.conversation_id, this.events.status);
    for (const message of this.messages) this.log.message(message);
    this.events.transcript(this.messages);
  }
  async older() {
    if (!this.conversation.next_cursor) { this.events.status("No older messages"); return; }
    const page = await this.json<Conversation>(`${this.path}?cursor=${encodeURIComponent(this.conversation.next_cursor)}`);
    this.conversation.next_cursor = page.next_cursor;
    const ids = new Set(this.messages.map(message => message.id));
    this.messages = [...(page.messages ?? []).filter(message => !ids.has(message.id)), ...this.messages];
    this.events.transcript(this.messages);
  }
  assertCanSend() {
    if (this.busy) throw new Error("A turn is running. Use /stop first.");
    if (this.pending.length) throw new Error("Answer the pending approval with /approve or /deny first.");
    this.local?.assertOnline();
  }
  async turn(body: Record<string, unknown>, continuation?: UIMessage) {
    if (this.busy) throw new Error("A turn is running. Use /stop first.");
    this.local?.assertOnline();
    this.partial = undefined;
    this.busy = true;
    this.controller = new AbortController();
    this.events.status("Working…");
    let accepted = false;
    try {
      const response = await api(`${this.path}/chat`, {
        method: "POST", signal: this.controller.signal,
        body: JSON.stringify({ ...body, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      if (!response.ok) {
        const error = await response.json();
        if (response.status === 409 && error.pending_approval) {
          await this.reload();
          throw new Error("Answer the pending approval, then send your message again.");
        }
        throw new Error(error.error ?? `Turn failed (${response.status})`);
      }
      accepted = true;
      let finalStatus: string | undefined;
      await consumeTurn(response, { message: continuation, compact: body.command === "compact", onMessage: message => {
        this.partial = message;
        const exists = this.messages.some(item => item.id === message.id);
        this.messages = exists ? this.messages.map(item => item.id === message.id ? message : item) : [...this.messages, message];
        this.events.streaming(message);
      }, onStatus: status => { finalStatus = status; this.events.status(status); } });
      await this.reload();
      this.events.status(body.command === "compact" && finalStatus ? finalStatus : this.pending.length ? "Approval needed" : this.conversation.model);
    } catch (error) {
      if (this.controller?.signal.aborted) { this.events.status("Stopped"); return; }
      if (!accepted && body.message && (body.message as UIMessage).role === "user") {
        const message = body.message as UIMessage;
        const failed = { ...message, metadata: { fwcodeDelivery: "failed" } };
        this.messages = [...this.messages.filter(item => item.id !== message.id), failed];
        this.events.transcript(this.messages);
      }
      this.log?.append("interruption", { message: this.partial });
      throw error;
    } finally { this.busy = false; this.controller = undefined; }
  }
  async send(text: string) {
    this.assertCanSend();
    const message: UIMessage = { id: randomUUID(), role: "user", parts: [{ type: "text", text }] };
    this.log?.message(message);
    this.messages = [...this.messages, message];
    this.events.transcript(this.messages);
    await this.turn({ message });
  }
  async approve(approved: boolean, id = this.pending[0]?.id) {
    const last = this.messages.findLast(message => !isUnsentMessage(message));
    if (!last || !id) throw new Error("No pending approval");
    this.log?.append("approval", { approval_id: id, approved });
    const message = respondToApproval(last, id, approved);
    this.messages = this.messages.map(item => item.id === message.id ? message : item);
    if (pendingApprovals(message).length) {
      this.events.transcript(this.messages);
      return;
    }
    await this.turn({ message }, message);
  }
  async setAutoApprove(enabled: boolean) {
    if (this.changingApprovals) throw new Error("Approval settings are still being saved");
    this.changingApprovals = true;
    let resumed: boolean;
    try {
      const result = await this.json<{ resumed: boolean }>(`${this.path}/auto-approve`, { method: "POST", body: JSON.stringify({ enabled }) });
      this.conversation.auto_approve = enabled;
      resumed = result.resumed;
      this.events.status(`Auto-approve ${enabled ? "on" : "off"}. Plans still require approval.`);
    } finally { this.changingApprovals = false; }
    if (resumed && !this.busy) {
      this.busy = true;
      this.events.status("Working…");
      try {
        // The cloud resumes the parked turn; follow its persisted transcript instead of submitting it twice.
        do {
          await this.reload();
          if (!this.conversation.turn_active) break;
          await delay(500, undefined, { signal: this.lifetime.signal });
        } while (!this.lifetime.signal.aborted);
        this.events.status(this.pending.length ? "Approval needed" : this.conversation.model);
      } finally { this.busy = false; }
    }
  }
  async stop() {
    await this.json(`${this.path}/stop`, { method: "POST" });
    this.controller?.abort();
    this.events.status("Stopped");
  }
  async close() {
    this.lifetime.abort();
    this.controller?.abort();
    const local = this.local; this.local = undefined;
    const closing = local?.close();
    if (this.busy) { try { await this.json(`${this.path}/stop`, { method: "POST", signal: AbortSignal.timeout(5000) }); } catch {} }
    await closing;
  }
  async command(line: string, choose?: Choose) {
    const [command, ...args] = line.trim().split(/\s+/);
    if (command === "/approve" || command === "/deny") return this.approve(command === "/approve", args[0]);
    if (command === "/approvals") {
      const selected = args[0] ?? (choose ? await choose("Tool approvals", [
        { value: "off", label: "Ask for approval", description: "Review each tool action" },
        { value: "on", label: "Auto-approve tools", description: "Applies to this conversation; plans still require approval" },
      ]) : undefined);
      if (!selected) return;
      if (selected !== "on" && selected !== "off") throw new Error("Use /approvals on or /approvals off");
      return this.setAutoApprove(selected === "on");
    }
    if (command === "/stop") return this.stop();
    if (command === "/older") return this.older();
    if (command === "/compact") return this.turn({ command: "compact" });
    if (this.busy) throw new Error("A turn is running. Use /stop first.");
    if (command === "/model") {
      const catalog = await this.json<{ models: { id: string; label: string; enabled: boolean }[] }>(`/api/organizations/${encodeURIComponent(requireOrgId())}/models`);
      const items = catalog.models.filter(model => model.enabled).map(model => ({ value: model.id, label: model.label ?? model.id }));
      const selected = args[0] ?? (choose ? await choose("Choose model", items) : undefined);
      if (!selected) { this.events.status(items.map(item => `${item.value}: ${item.label}`).join("\n")); return; }
      if (!items.some(item => item.value === selected)) throw new Error("That model is not available in this organization");
      await this.json(this.path, { method: "PATCH", body: JSON.stringify({ model: selected }) });
      this.conversation.model = selected;
      this.events.status(selected);
      return;
    }
    if (command === "/logs") { this.events.status(this.log?.path ?? "No conversation log"); return; }
    if (command === "/codex" && choose) return connectCodex(choose, this.events.status, this.lifetime.signal);
    throw new Error("Commands: /model /codex /logs /compact /stop /approvals /approve /deny /older /quit");
  }
}
