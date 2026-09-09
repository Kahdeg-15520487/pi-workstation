// extensions/agentic-harness/tests/editor-border.test.ts
import { describe, expect, it } from "vitest";
import { visibleWidth } from "@mariozechner/pi-tui";
import {
  fitBorder,
  buildTopLeftSegments,
  buildTopRightSegments,
  buildTopBorder,
  buildBottomBorder,
  fg24,
  BORDER_COLORS,
  type BorderContext,
} from "../editor-border.js";

const NOOP_COLOR = (text: string) => text;

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "/home/user";

const defaultCtx: BorderContext = {
  modelName: "qwen-latest-v34",
  thinkingLevel: "medium",
  cwd: `${HOME_DIR}/projects/myapp`,
  gitBranch: "main",
  gitDirty: false,
  contextPercent: 12.5,
  contextWindow: 128000,
};

describe("fitBorder", () => {
  it("returns empty string for width <= 0", () => {
    expect(fitBorder("a", "b", 0, NOOP_COLOR)).toBe("");
    expect(fitBorder("a", "b", -1, NOOP_COLOR)).toBe("");
  });

  it("returns pure fill for width <= 2", () => {
    expect(fitBorder("a", "b", 1, NOOP_COLOR)).toBe("─");
    expect(fitBorder("a", "b", 2, NOOP_COLOR)).toBe("──");
  });

  it("renders left and right with fill gap", () => {
    const result = fitBorder(" L ", " R ", 20, NOOP_COLOR);
    expect(visibleWidth(result)).toBe(20);
    expect(result).toContain(" L ");
    expect(result).toContain(" R ");
    // Starts and ends with ─
    expect(result[0]).toBe("─");
    expect(result[result.length - 1]).toBe("─");
  });

  it("truncates right content first when too wide", () => {
    const longRight = "This is a very long right segment";
    const result = fitBorder("L", longRight, 20, NOOP_COLOR);
    expect(visibleWidth(result)).toBe(20);
  });

  it("truncates left content when right is already empty", () => {
    const longLeft = "This is a very long left segment that exceeds everything";
    const result = fitBorder(longLeft, "", 20, NOOP_COLOR);
    expect(visibleWidth(result)).toBe(20);
  });

  it("uses separate fillColor for gap", () => {
    const border = (t: string) => `[B]${t}[/B]`;
    const fill = (t: string) => `[F]${t}[/F]`;
    const result = fitBorder("L", "R", 10, border, fill);
    expect(result).toContain("[F]");
    expect(result).toContain("[B]");
  });
});

describe("buildTopLeftSegments", () => {
  it("includes model and thinking", () => {
    const result = buildTopLeftSegments(defaultCtx);
    expect(visibleWidth(result)).toBeGreaterThan(0);
    // Should contain the model name (sans prefix)
    const plain = result.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("latest-v34");
    expect(plain).toContain("medium");
  });

  it("omits thinking when off", () => {
    const ctx = { ...defaultCtx, thinkingLevel: "off" };
    const result = buildTopLeftSegments(ctx);
    const plain = result.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).not.toContain("off");
  });
});

describe("buildTopRightSegments", () => {
  it("includes path, git, context", () => {
    const result = buildTopRightSegments(defaultCtx);
    const plain = result.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("~");
    expect(plain).toContain("main");
    expect(plain).toContain("ctx");
  });

  it("shows dirty marker when git is dirty", () => {
    const ctx = { ...defaultCtx, gitDirty: true };
    const result = buildTopRightSegments(ctx);
    const plain = result.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("*");
  });

  it("shortens long paths", () => {
    const ctx = { ...defaultCtx, cwd: `${HOME_DIR}/very/deeply/nested/project/structure/src/components` };
    const result = buildTopRightSegments(ctx);
    const plain = result.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain.length).toBeLessThan(60);
  });
});

describe("buildTopBorder", () => {
  it("produces a line of exact width", () => {
    const result = buildTopBorder(defaultCtx, 80, NOOP_COLOR);
    expect(visibleWidth(result)).toBe(80);
  });

  it("handles narrow terminals gracefully", () => {
    const result = buildTopBorder(defaultCtx, 30, NOOP_COLOR);
    expect(visibleWidth(result)).toBe(30);
  });
});

describe("buildBottomBorder", () => {
  it("produces a line of exact width", () => {
    const result = buildBottomBorder(80, NOOP_COLOR);
    expect(visibleWidth(result)).toBe(80);
  });
});
