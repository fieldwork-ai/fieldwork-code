const FIELDWORK_ATTRIBUTION = { originator: "fieldwork", userAgent: "fieldwork/0.1.0", version: "0.1.0" };
import { describe, expect, it } from "vitest";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { toCodexContext } from "../src/language-model.js";
import { responsesInput } from "../src/client.js";

/**
 * The projection runs on every turn against stored messages, so a throw here is
 * not a failed request — it is a conversation nobody can type into again. These
 * tests pin the degrade-never-throw rule for each shape a conversation can hold.
 */

const MODEL = "gpt-5.6-sol";

function project(prompt: LanguageModelV4CallOptions["prompt"]) {
  return toCodexContext(prompt, undefined, MODEL);
}

function toolResultPrompt(
  output: Extract<
    Extract<LanguageModelV4CallOptions["prompt"][number], { role: "tool" }>["content"][number],
    { type: "tool-result" }
  >["output"],
): LanguageModelV4CallOptions["prompt"] {
  return [
    { role: "user", content: [{ type: "text", text: "read the file" }] },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: {} }],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output }],
    },
  ];
}

describe("openai subscription projection", () => {
  it("sends an image tool result as an image block", () => {
    const context = project(
      toolResultPrompt({
        type: "content",
        value: [
          {
            type: "file",
            data: { type: "data", data: "QUJD" },
            mediaType: "image/png",
          },
          { type: "text", text: "Image file (image/png)" },
        ],
      }),
    );

    expect(context.messages.at(-1)).toMatchObject({
      role: "toolResult",
      isError: false,
      content: [
        { type: "image", data: "QUJD", mimeType: "image/png" },
        { type: "text", text: "Image file (image/png)" },
      ],
    });
  });

  it("sends a PDF tool result as a document", () => {
    const context = project(
      toolResultPrompt({
        type: "content",
        value: [
          {
            type: "file",
            data: { type: "data", data: "JVBERi0=" },
            mediaType: "application/pdf",
            filename: "invoice.pdf",
          },
          { type: "text", text: "invoice.pdf" },
        ],
      }),
    );

    expect(context.messages.at(-1)).toMatchObject({
      role: "toolResult",
      isError: false,
      content: [
        { type: "document", data: "JVBERi0=", mimeType: "application/pdf", filename: "invoice.pdf" },
        { type: "text", text: "invoice.pdf" },
      ],
    });
    expect(responsesInput(context).at(-1)).toMatchObject({
      type: "function_call_output",
      output: [
        { type: "input_file", filename: "invoice.pdf", file_data: "data:application/pdf;base64,JVBERi0=" },
        { type: "input_text", text: "invoice.pdf" },
      ],
    });
  });

  it("keeps a tool result non-empty when every part is unrepresentable", () => {
    const context = project(
      toolResultPrompt({
        type: "content",
        value: [{ type: "custom", providerOptions: { anthropic: { type: "tool-reference" } } }],
      }),
    );

    expect(context.messages.at(-1)).toMatchObject({
      content: [{ type: "text", text: "[Tool returned no readable content]" }],
    });
  });

  it("drops the approval response an approved tool call carries", () => {
    const context = project([
      { role: "user", content: [{ type: "text", text: "read the file" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: {} }],
      },
      {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "ap1", approved: true },
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "read",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ]);

    expect(context.messages).toHaveLength(3);
    expect(context.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "c1",
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("sends an image attachment and a PDF attachment", () => {
    const context = project([
      {
        role: "user",
        content: [
          { type: "text", text: "what is in these?" },
          { type: "file", data: { type: "data", data: "QUJD" }, mediaType: "image/png" },
          {
            type: "file",
            data: { type: "data", data: "JVBERi0=" },
            mediaType: "application/pdf",
            filename: "invoice.pdf",
          },
        ],
      },
    ]);

    expect(context.messages[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "what is in these?" },
        { type: "image", data: "QUJD", mimeType: "image/png" },
        { type: "document", data: "JVBERi0=", mimeType: "application/pdf", filename: "invoice.pdf" },
      ],
    });
    expect(responsesInput(context)[0]).toEqual({
      role: "user",
      content: [
        { type: "input_text", text: "what is in these?" },
        { type: "input_image", image_url: "data:image/png;base64,QUJD" },
        { type: "input_file", filename: "invoice.pdf", file_data: "data:application/pdf;base64,JVBERi0=" },
      ],
    });
  });

  it("names an unnamed PDF, which the backend requires", () => {
    const context = project([
      { role: "user", content: [{ type: "file", data: { type: "data", data: new Uint8Array([37, 80, 68, 70]) }, mediaType: "application/pdf" }] },
    ]);
    expect(context.messages[0]).toMatchObject({
      content: [{ type: "document", data: "JVBERg==", filename: "document.pdf" }],
    });
  });

  it("degrades a URL-backed PDF, which the projection may not fetch", () => {
    const context = project([
      { role: "user", content: [{ type: "file", data: { type: "url", url: new URL("https://example.com/a.pdf") }, mediaType: "application/pdf" }] },
    ]);
    expect(context.messages[0]).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("application/pdf") }],
    });
  });

  it("degrades a URL-backed image, which the projection may not fetch", () => {
    const context = project([
      {
        role: "user",
        content: [
          {
            type: "file",
            data: { type: "url", url: new URL("https://example.com/a.png") },
            mediaType: "image/png",
          },
        ],
      },
    ]);

    expect(context.messages[0]).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("image/png") }],
    });
  });

  // An inline text document carries its content in the part itself, so there is
  // nothing to degrade — projecting it as a note would throw away text the model
  // can read perfectly well, which is a quieter failure than the throw.
  it("sends an inline text file as its text, not as a note", () => {
    const context = project([
      {
        role: "user",
        content: [
          {
            type: "file",
            data: { type: "text", text: "the quarterly numbers" },
            mediaType: "text/plain",
            filename: "q3.txt",
          },
        ],
      },
    ]);

    expect(context.messages[0]).toMatchObject({
      content: [{ type: "text", text: "the quarterly numbers" }],
    });
  });

  it("sends an inline text file in a tool result as its text", () => {
    const context = project(
      toolResultPrompt({
        type: "content",
        value: [
          {
            type: "file",
            data: { type: "text", text: "line one\nline two" },
            mediaType: "text/plain",
          },
        ],
      }),
    );

    expect(context.messages.at(-1)).toMatchObject({
      role: "toolResult",
      content: [{ type: "text", text: "line one\nline two" }],
    });
  });

  // `image/*` is not the test. These match it and every provider rejects them,
  // so sending one as an image block is exactly the permanent 400 this whole
  // projection exists to avoid.
  it.each(["image/svg+xml", "image/bmp", "image/x-icon"])(
    "degrades %s rather than sending it as an image block",
    (mediaType) => {
      const context = project([
        {
          role: "user",
          content: [{ type: "file", data: { type: "data", data: "QUJD" }, mediaType }],
        },
      ]);

      expect(context.messages[0]).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining(mediaType) }],
      });
    },
  );

  it("replays an assistant file part as a note instead of throwing", () => {
    const context = project([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "here you go" },
          { type: "file", data: { type: "data", data: "QUJD" }, mediaType: "image/png" },
        ],
      },
    ]);

    expect(context.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "here you go" },
        { type: "text", text: expect.stringContaining("image/png") },
      ],
    });
  });
});
