import {
  TuiAltScreen, ProcessTerminal, Text, Editor, SelectList, CombinedAutocompleteProvider,
  Container, ScrollView, VStack, matchesKey, truncateToWidth, visibleWidth, type Component, type Terminal,
} from "@earendil-works/pi-tui";
import { CodeSession, type Choose } from "./session.js";
import { terminalText, isUnsentMessage } from "./protocol.js";
import { Transcript, approvalContent, ink, selectionTheme } from "./presentation.js";

export async function runTui(
  options: { conversation?: string; model?: string; root?: string },
  terminal: Terminal = new ProcessTerminal(),
) {
  const tui = new TuiAltScreen(terminal, true);
  const transcript = new Transcript();
  let statusText = "Connecting…";
  const editor = new Editor(tui, { borderColor: ink.muted, selectList: selectionTheme }, { paddingX: 1, autocompleteMaxVisible: 5 });
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(["model", "codex", "logs", "compact", "stop", "approve", "deny", "older", "quit"].map(name => ({ name })), options.root ?? process.cwd()));
  const footer: Component = {
    invalidate() {},
    render(width) {
      const activity = ` ${statusText}${tui.isFollowingOutput ? "" : " · Scrolled up"}`;
      const hint = overlayOpen ? "↑/↓ choose · Enter confirm · Esc back" : width >= 72 ? "Enter send · Shift+Enter newline · PgUp/PgDn scroll · Ctrl+C stop" : "Enter send · Ctrl+C stop";
      return [truncateToWidth(activity, width), truncateToWidth(ink.muted(` ${hint}`), width)];
    },
  };
  tui.setLayoutRoot(new VStack([
    { component: new Text(ink.bold("Fieldwork Code") + (options.root ? ink.muted(` · ${terminalText(options.root)}`) : ""), 1, 0), basis: 1, shrink: 0 },
    { component: new ScrollView(transcript, { follow: "end", primary: true }), basis: 0, grow: 1, minSize: 1 },
    { component: editor, basis: "auto", shrink: 1, minSize: 3 },
    { component: footer, basis: 2, shrink: 0 },
  ]));
  const session = new CodeSession({
    transcript(messages) { transcript.set(messages); tui.requestRender(); },
    streaming(message) { transcript.streaming(message); tui.requestRender(); },
    status(text) { statusText = terminalText(text).replace(/\n/g, " "); tui.requestRender(); },
  });
  let overlayOpen = false;
  let dismissOverlay: (() => void) | undefined;
  const select = (title: string, content: Component, items: Parameters<Choose>[1]): ReturnType<Choose> => new Promise(resolve => {
    const list = new SelectList(items, Math.min(items.length, 6), selectionTheme);
    const heading = new Text(ink.bold(terminalText(title)), 1, 0);
    const box: Component = new (class implements Component {
      private offset = 0;
      private pageSize = 1;
      private maximumOffset = 0;
      invalidate() { heading.invalidate(); content.invalidate(); list.invalidate(); }
      render(width: number) {
        const inner = Math.max(1, width - 2);
        const top = heading.render(inner);
        const choices = list.render(inner);
        const lines = content.render(inner);
        this.pageSize = Math.max(1, Math.floor(terminal.rows * 0.8) - top.length - choices.length - 6);
        this.maximumOffset = Math.max(0, lines.length - this.pageSize);
        this.offset = Math.min(this.offset, this.maximumOffset);
        const hint = this.maximumOffset ? "PgUp/PgDn details · Enter confirm · Esc back" : "↑/↓ choose · Enter confirm · Esc back";
        const rows = [...top, "", ...lines.slice(this.offset, this.offset + this.pageSize), "", ...choices, truncateToWidth(ink.muted(` ${hint}`), inner)];
        const rule = ink.muted("─".repeat(inner));
        return [ink.muted("┌") + rule + ink.muted("┐"), ...rows.map(row => {
          const clipped = truncateToWidth(row, inner);
          return ink.muted("│") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + ink.muted("│");
        }), ink.muted("└") + rule + ink.muted("┘")];
      }
      handleInput(data: string) {
        if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - this.pageSize);
        else if (matchesKey(data, "pageDown")) this.offset = Math.min(this.maximumOffset, this.offset + this.pageSize);
        else list.handleInput(data);
        tui.requestRender();
      }
    })();
    overlayOpen = true;
    const handle = tui.showOverlay(box, { width: "100%", maxHeight: "80%", anchor: "center" });
    const finish = (value?: string) => {
      handle.hide(); overlayOpen = false; dismissOverlay = undefined; tui.setFocus(editor); resolve(value);
    };
    dismissOverlay = () => finish();
    list.onSelect = item => finish(item.value);
    list.onCancel = () => finish();
  });
  const choose: Choose = (title, items) => select(title, new Container(), items);
  let closed = false;
  let ready = false;
  const report = (error: unknown) => session.events.status(error instanceof Error ? error.message : String(error));
  async function offerApprovals() {
    while (!closed && session.pending.length && !overlayOpen) {
      const pending = session.pending[0];
      const { title, component } = approvalContent(pending);
      const verdict = await select(title, component, [
        { value: "deny", label: "Deny" }, { value: "approve", label: "Approve" },
      ]);
      if (!verdict) break;
      try { await session.approve(verdict === "approve", pending.id); } catch (error) { report(error); break; }
    }
  }
  await new Promise<void>((resolve, reject) => {
    const close = () => {
      if (closed) return;
      closed = true;
      process.off("SIGTERM", terminate); process.off("SIGHUP", terminate);
      dismissOverlay?.(); tui.stop();
      void session.close().then(resolve, reject);
    };
    const terminate = () => close();
    process.once("SIGTERM", terminate); process.once("SIGHUP", terminate);
    editor.onSubmit = text => {
      const line = text.trim();
      if (!line) return;
      if (line === "/quit") {
        if (session.busy) { report(new Error("Use /stop before quitting a running turn")); return; }
        close(); return;
      }
      if (!ready) { editor.setText(text); report(new Error("Not connected. Restart fwcode to reconnect.")); return; }
      const command = line.startsWith("/");
      try { if (!command) session.assertCanSend(); } catch (error) { editor.setText(text); report(error); return; }
      editor.setText("");
      editor.addToHistory(line);
      if (!command) tui.scrollToBottom();
      void (command ? session.command(line, choose) : session.send(line)).then(offerApprovals).catch(error => {
        const last = session.messages.at(-1);
        const failed = last && isUnsentMessage(last);
        if ((command || failed) && !editor.getText()) editor.setText(text);
        report(error);
      });
    };
    tui.addInputListener(data => {
      if (matchesKey(data, "ctrl+c")) {
        if (overlayOpen) dismissOverlay?.();
        else if (session.busy) void session.stop().catch(report);
        else close();
        return { consume: true };
      }
      return undefined;
    });
    tui.setFocus(editor);
    tui.start();
    editor.disableSubmit = true;
    void session.open(options).then(() => {
      if (closed) { void session.close().catch(report); return; }
      ready = true;
      editor.disableSubmit = false;
      void offerApprovals().catch(report);
    }).catch(error => {
      report(error);
      editor.disableSubmit = false;
    });
  });
}
