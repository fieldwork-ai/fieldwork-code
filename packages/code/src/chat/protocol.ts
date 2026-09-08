import type { UIMessage } from "ai";

export interface Conversation {
  conversation_id: string;
  model: string;
  messages?: UIMessage[];
  next_cursor?: string | null;
  turn_active?: boolean;
}
export interface PendingApproval {
  id: string;
  tool: string;
  input: unknown;
}
export function pendingApprovals(message?: UIMessage): PendingApproval[] {
  if (message?.role !== "assistant") return [];
  return message.parts.flatMap(part => {
    if (!(part.type.startsWith("tool-") || part.type === "dynamic-tool") || !("state" in part) || part.state !== "approval-requested" || !("approval" in part) || !part.approval) return [];
    return [{ id: part.approval.id, tool: "toolName" in part ? String(part.toolName) : part.type.slice(5), input: "input" in part ? part.input : undefined }];
  });
}
export function respondToApproval(message: UIMessage, id: string, approved: boolean): UIMessage {
  if (!pendingApprovals(message).some(part => part.id === id)) throw new Error("That approval is no longer pending");
  return { ...message, parts: message.parts.map(part => {
    if ("approval" in part && part.approval?.id === id && "state" in part && part.state === "approval-requested") {
      return { ...part, state: "approval-responded", approval: { ...part.approval, approved } };
    }
    return part;
  }) };
}
export function messageText(message: UIMessage): string {
  return message.parts.map(part => {
    if (part.type === "text") return part.text;
    if (part.type === "reasoning") return `Thinking: ${part.text}`;
    if ("toolCallId" in part && "state" in part) {
      const name = "toolName" in part ? part.toolName : part.type.slice(5);
      const result = "output" in part && part.output !== undefined ? `\n${JSON.stringify(part.output, null, 2)}` : "errorText" in part && part.errorText ? `\n${part.errorText}` : "";
      return `[${name}: ${part.state}]${result}`;
    }
    if (part.type === "file") return `[File: ${part.filename ?? part.mediaType}] ${part.url}`;
    return "";
  }).filter(Boolean).join("\n\n");
}
export function terminalText(text: string): string {
  // Strip control bytes before handing server content to a terminal renderer.
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
