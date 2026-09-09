import type { UIMessage } from "ai";
import type { Component } from "@earendil-works/pi-tui";
import { CodeSession, type Choose } from "./session.js";
import { messageText, terminalText } from "./protocol.js";

export async function runTui(options: { conversation?: string; model?: string; root?: string }) {
  const { TuiMainScreen, ProcessTerminal, Text, Editor, SelectList, CombinedAutocompleteProvider, matchesKey } = await import("@earendil-works/pi-tui");
  const plain = (text: string) => text;
  const theme = { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain };
  class Transcript implements Component {
    private entries: { key: string; text: InstanceType<typeof Text>; width?: number; lines?: string[] }[] = [];
    set(messages: UIMessage[]) {
      const previous = new Map(this.entries.map(entry => [entry.key, entry]));
      this.entries = messages.map(message => {
        const content = `${message.role === "user" ? "You" : "Fieldwork Code"}\n${terminalText(messageText(message))}`;
        const key = `${message.id}:${content}`;
        return previous.get(key) ?? { key, text: new Text(content, 1, 1) };
      });
    }
    invalidate() { for (const entry of this.entries) { entry.width = undefined; entry.text.invalidate(); } }
    render(width: number) {
      return this.entries.flatMap(entry => {
        if (entry.width !== width) { entry.lines = entry.text.render(width); entry.width = width; }
        return entry.lines ?? [];
      });
    }
  }
  const tui = new TuiMainScreen(new ProcessTerminal());
  const transcript = new Transcript();
  const tail = new Text("", 1, 1);
  const status = new Text("", 1, 0);
  const editor = new Editor(tui, { borderColor: plain, selectList: theme });
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(["model", "codex", "logs", "compact", "stop", "approve", "deny", "older", "quit"].map(name => ({ name })), process.cwd()));
  tui.addChild(new Text("Fieldwork Code", 1, 1));
  tui.addChild(transcript);
  tui.addChild(tail);
  tui.addChild(status);
  tui.addChild(editor);
  const session = new CodeSession({
    transcript(messages) { transcript.set(messages); tail.setText(""); tui.requestRender(); },
    streaming(message) { tail.setText(terminalText(messageText(message))); tui.requestRender(); },
    status(text) { status.setText(terminalText(text)); tui.requestRender(); },
  });
  await session.open(options);
  let overlayOpen = false;
  const choose: Choose = (title, items) => new Promise(resolve => {
    const list = new SelectList(items, 10, theme);
    const details = new Text(terminalText(title), 1, 1);
    const box: Component = new (class implements Component {
      private offset = 0;
      private pageSize = 1;
      private maximumOffset = 0;
      invalidate() { details.invalidate(); list.invalidate(); }
      render(width: number) {
        const choices = list.render(width);
        const lines = details.render(width);
        this.pageSize = Math.max(1, Math.floor((process.stdout.rows || 24) * 0.8) - choices.length - 1);
        this.maximumOffset = Math.max(0, lines.length - this.pageSize);
        this.offset = Math.min(this.offset, this.maximumOffset);
        const hint = this.maximumOffset ? new Text("Page Up/Down: scroll details", 1, 0).render(width).slice(0, 1) : [""];
        return [...lines.slice(this.offset, this.offset + this.pageSize), ...hint, ...choices];
      }
      handleInput(data: string) {
        if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - this.pageSize);
        else if (matchesKey(data, "pageDown")) this.offset = Math.min(this.maximumOffset, this.offset + this.pageSize);
        else list.handleInput(data);
        tui.requestRender();
      }
    })();
    overlayOpen = true;
    const handle = tui.showOverlay(box, { width: "90%", maxHeight: "80%", anchor: "center" });
    const finish = (value?: string) => { handle.hide(); overlayOpen = false; tui.setFocus(editor); resolve(value); };
    list.onSelect = item => finish(item.value);
    list.onCancel = () => finish();
  });
  let closed = false;
  const report = (error: unknown) => session.events.status(error instanceof Error ? error.message : String(error));
  async function offerApprovals() {
    while (!closed && session.pending.length && !overlayOpen) {
      const pending = session.pending[0];
      const verdict = await choose(`Approval required: ${pending.tool}\n${JSON.stringify(pending.input, null, 2)}`, [
        { value: "deny", label: "Deny" }, { value: "approve", label: "Approve" },
      ]);
      if (!verdict) break;
      try { await session.approve(verdict === "approve", pending.id); } catch (error) { report(error); break; }
    }
  }
  await new Promise<void>(resolve => {
    const close = () => { if (closed) return; closed = true; process.off("SIGTERM", terminate); process.off("SIGHUP", terminate); tui.stop(); void session.close().finally(resolve); };
    const terminate = () => close();
    process.once("SIGTERM", terminate);
    process.once("SIGHUP", terminate);
    editor.onSubmit = text => {
      const line = text.trim();
      if (!line) return;
      if (line === "/quit") {
        if (session.busy) { report(new Error("Use /stop before quitting a running turn")); return; }
        close(); return;
      }
      editor.setText("");
      editor.addToHistory(line);
      void (line.startsWith("/") ? session.command(line, choose) : session.send(line)).then(offerApprovals).catch(report);
    };
    tui.addInputListener(data => {
      if (matchesKey(data, "ctrl+c")) {
        if (session.busy) void session.stop().catch(report);
        else close();
        return { consume: true };
      }
      return undefined;
    });
    tui.setFocus(editor);
    tui.start();
    void offerApprovals().catch(report);
  });
}
