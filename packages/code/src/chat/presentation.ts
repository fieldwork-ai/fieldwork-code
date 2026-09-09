import { Container, Markdown, Text, Spacer, truncateToWidth, visibleWidth, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { UIMessage } from "ai";
import { terminalText, isUnsentMessage, type PendingApproval } from "./protocol.js";

const style = (code: number) => (text: string) => process.env.NO_COLOR !== undefined ? text : `\x1b[${code}m${text}\x1b[0m`;
export const ink = { bold: style(1), muted: style(2), accent: style(36), success: style(32), error: style(31) };
export const selectionTheme = {
  selectedPrefix: ink.accent, selectedText: ink.bold, description: ink.muted,
  scrollInfo: ink.muted, noMatch: ink.muted,
};
const markdownTheme: MarkdownTheme = {
  heading: ink.bold, bold: ink.bold, italic: text => text, strikethrough: style(9), underline: style(4),
  link: ink.accent, linkUrl: ink.muted, code: ink.accent, codeBlock: text => text,
  codeBlockBorder: ink.muted, quote: ink.muted, quoteBorder: ink.muted, hr: ink.muted, listBullet: ink.accent,
};
const prose = (text: string) => new Markdown(terminalText(text), 1, 0, markdownTheme);
const literal = (text: string) => new Text(terminalText(text), 1, 0);
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (key: string) => key.replace(/_/g, " ");

export function readableValue(value: unknown, depth = 0): string {
  if (typeof value === "string") return terminalText(value);
  if (value === undefined) return "—";
  if (value === null || typeof value !== "object") return String(value);
  const indent = "  ".repeat(depth);
  if (Array.isArray(value)) return value.map(item => {
    const nested = item !== null && typeof item === "object";
    return `${indent}• ${nested ? "\n" + readableValue(item, depth + 1) : readableValue(item)}`;
  }).join("\n");
  return Object.entries(value).map(([key, item]) => {
    const nested = item !== null && typeof item === "object";
    return nested
      ? `${indent}${label(key)}:\n${readableValue(item, depth + 1)}`
      : `${indent}${label(key)}: ${readableValue(item)}`;
  }).join("\n");
}

export function approvalContent(approval: PendingApproval): { title: string; component: Component } {
  const input = record(approval.input);
  const body = new Container();
  const consumed = new Set<string>();
  const field = (key: string) => { consumed.add(key); return typeof input[key] === "string" ? terminalText(input[key] as string) : readableValue(input[key]); };
  let title: string;
  switch (approval.tool) {
    case "bash":
      title = "Run shell command";
      body.addChild(literal(field("command")));
      break;
    case "read":
      title = "Read file";
      body.addChild(literal(field("file_path")));
      break;
    case "write":
      title = "Write file";
      body.addChild(new Text(ink.bold(field("file_path")), 1, 1));
      body.addChild(literal(field("content")));
      break;
    case "edit": {
      title = "Edit file";
      body.addChild(new Text(ink.bold(field("file_path")), 1, 1));
      const before = field("old_string"), after = field("new_string");
      body.addChild(new Text(before.split("\n").map(line => ink.error(`- ${line}`)).join("\n"), 1, 0));
      body.addChild(new Text(after.split("\n").map(line => ink.success(`+ ${line}`)).join("\n"), 1, 0));
      break;
    }
    case "present_plan":
      title = "Approve plan";
      body.addChild(prose(field("plan")));
      break;
    default:
      title = `Allow ${label(approval.tool)}`;
  }
  const remaining = Object.fromEntries(Object.entries(input).filter(([key]) => !consumed.has(key)));
  if (Object.keys(remaining).length) body.addChild(literal(readableValue(remaining)));
  else if (!Object.keys(input).length) body.addChild(literal(readableValue(approval.input)));
  return { title, component: body };
}

const states: Record<string, string> = {
  "input-streaming": "Preparing", "input-available": "Running", "approval-requested": "Approval needed",
  "approval-responded": "Decision recorded", "output-available": "Done", "output-error": "Failed", "output-denied": "Denied",
};
function turnHeading(title: string): Component {
  return {
    invalidate() {},
    render(width) {
      const heading = truncateToWidth(`── ${title} `, Math.max(1, width - 2));
      return ["", ` ${heading}${ink.muted("─".repeat(Math.max(0, width - visibleWidth(heading) - 2)))}`, ""];
    },
  };
}
function toolPanel(title: string, content: Component): Component {
  return {
    invalidate() { content.invalidate(); },
    render(width) {
      const inner = Math.max(1, width - 4);
      const heading = truncateToWidth(` ${title} `, inner);
      const edge = (left: string, middle: string, right: string) => ` ${ink.muted(left)}${middle}${ink.muted(right)}`;
      return ["", edge("┌", heading + ink.muted("─".repeat(Math.max(0, inner - visibleWidth(heading)))), "┐"),
        ...content.render(inner).map(line => {
          const clipped = truncateToWidth(line, inner);
          return edge("│", clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))), "│");
        }), edge("└", ink.muted("─".repeat(inner)), "┘"), ""];
    },
  };
}
function messageComponent(message: UIMessage): Component {
  const body = new Container();
  const failed = isUnsentMessage(message);
  body.addChild(turnHeading(ink.bold(message.role === "user" ? "You" : "Fieldwork") + (failed ? ink.error(" · Send failed") : "")));
  for (const part of message.parts) {
    if (part.type === "text") body.addChild(message.role === "user" ? literal(part.text) : prose(part.text));
    else if (part.type === "reasoning" && part.text) {
      body.addChild(new Text(ink.muted("Thinking"), 1, 0));
      body.addChild(new Markdown(terminalText(part.text), 1, 0, markdownTheme, { color: ink.muted }));
      body.addChild(new Spacer(1));
    }
    else if ("toolCallId" in part && "state" in part) {
      const tool = "toolName" in part ? String(part.toolName) : part.type.slice(5);
      const input = record("input" in part ? part.input : undefined);
      const subject = input.command ?? input.file_path;
      const details = new Container();
      if (subject) details.addChild(literal(readableValue(subject)));
      if ("output" in part && part.output !== undefined) {
        const output = record(part.output);
        if (subject) details.addChild(new Text(ink.muted("Output"), 1, 1));
        details.addChild(literal(readableValue(output.output ?? output.text ?? part.output)));
      } else if ("errorText" in part && part.errorText) details.addChild(new Text(ink.error(terminalText(part.errorText)), 1, 0));
      body.addChild(toolPanel(ink.bold(label(tool)) + ink.muted(` · ${states[part.state] ?? part.state}`), details));
    } else if (part.type === "file") body.addChild(literal(`${part.filename ?? part.mediaType}\n${part.url}`));
  }
  return body;
}

export class Transcript implements Component {
  private messages: UIMessage[] = [];
  private entries: { key: string; component: Component }[] = [];
  set(messages: UIMessage[]) {
    this.messages = messages;
    const previous = new Map(this.entries.map(entry => [entry.key, entry]));
    this.entries = messages.map(message => {
      const key = JSON.stringify(message);
      return previous.get(key) ?? { key, component: messageComponent(message) };
    });
  }
  streaming(message: UIMessage) {
    const existing = this.messages.some(item => item.id === message.id);
    this.set(existing ? this.messages.map(item => item.id === message.id ? message : item) : [...this.messages, message]);
  }
  invalidate() { for (const entry of this.entries) entry.component.invalidate(); }
  render(width: number) {
    if (!this.entries.length) return new Text("What would you like to work on?", 1, 1).render(width);
    return this.entries.flatMap(entry => entry.component.render(width));
  }
}
