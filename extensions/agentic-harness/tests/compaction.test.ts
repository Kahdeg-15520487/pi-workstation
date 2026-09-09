import { describe, it, expect } from "vitest";
import {
  getCompactionPrompt,
  formatCompactSummary,
  microcompactMessages,
  MICROCOMPACT_AGE_MS,
} from "../compaction.js";

describe("Compaction Prompts", () => {
  it("should generate the detailed summary prompt", () => {
    const prompt = getCompactionPrompt();
    expect(prompt).toContain("Primary Request and Intent");
    expect(prompt).toContain("All User Messages");
    expect(prompt).toContain("<analysis>");
    expect(prompt).toContain("<summary>");
    expect(prompt).not.toContain("Active Workflow");
    expect(prompt).not.toContain("goal");
  });

  it("should append custom instructions when provided", () => {
    const prompt = getCompactionPrompt("Focus on TypeScript changes");
    expect(prompt).toContain("Focus on TypeScript changes");
  });

  it("should ignore empty custom instructions", () => {
    const prompt = getCompactionPrompt("   ");
    expect(prompt).not.toContain("Additional Instructions");
  });
});

describe("formatCompactSummary", () => {
  it("should strip analysis block and extract summary", () => {
    const raw = `<analysis>thinking here</analysis>\n<summary>the summary</summary>`;
    const result = formatCompactSummary(raw);
    expect(result).not.toContain("thinking here");
    expect(result).toContain("the summary");
    expect(result).not.toContain("<analysis>");
  });

  it("should handle missing tags gracefully", () => {
    const raw = "plain text summary";
    const result = formatCompactSummary(raw);
    expect(result).toBe("plain text summary");
  });
});

describe("microcompactMessages", () => {
  const now = Date.now();
  const oldTimestamp = now - MICROCOMPACT_AGE_MS - 1000;
  const recentTimestamp = now - 1000;

  it("should truncate old tool results with a stable marker", () => {
    const messages: any[] = [
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "bash",
        content: [{ type: "text", text: "a".repeat(5000) }],
        isError: false,
        timestamp: oldTimestamp,
      },
    ];
    const result = microcompactMessages(messages, now);
    const laterResult = microcompactMessages(messages, now + 60 * 1000);
    expect(result[0].content[0].text).toBe("[Compacted] bash result");
    expect(laterResult[0].content[0].text).toBe(result[0].content[0].text);
  });

  it("should preserve recent tool results", () => {
    const messages: any[] = [
      {
        role: "toolResult",
        toolCallId: "t2",
        toolName: "bash",
        content: [{ type: "text", text: "a".repeat(5000) }],
        isError: false,
        timestamp: recentTimestamp,
      },
    ];
    const result = microcompactMessages(messages, now);
    expect(result[0].content[0].text).toBe("a".repeat(5000));
  });

  it("should preserve error tool results regardless of age", () => {
    const messages: any[] = [
      {
        role: "toolResult",
        toolCallId: "t3",
        toolName: "bash",
        content: [{ type: "text", text: "error details ".repeat(500) }],
        isError: true,
        timestamp: oldTimestamp,
      },
    ];
    const result = microcompactMessages(messages, now);
    expect(result[0].content[0].text).toContain("error details");
  });

  it("should not modify non-toolResult messages", () => {
    const messages: any[] = [
      {
        role: "user",
        content: "hello",
        timestamp: oldTimestamp,
      },
    ];
    const result = microcompactMessages(messages, now);
    expect(result[0]).toEqual(messages[0]);
  });
});