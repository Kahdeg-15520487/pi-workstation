import { describe, expect, it } from "vitest";
import { visibleWidth } from "@mariozechner/pi-tui";
import { shimmerSegments, shimmerText, stripAnsi } from "../shimmer.js";

const theme = {
  getFgAnsi: (color: string) => `<${color}>`,
} as any;

describe("shimmer formatter", () => {
  it("preserves visible text while adding ANSI/style sequences", () => {
    const rendered = shimmerText("Working…", theme, undefined, 0);

    expect(stripAnsi(rendered).replace(/<[^>]+>/g, "")).toBe("Working…");
    expect(rendered).toContain("<");
  });

  it("returns an empty string for empty input", () => {
    expect(shimmerText("", theme, undefined, 0)).toBe("");
    expect(shimmerSegments([], theme, 0)).toBe("");
  });

  it("keeps terminal visible width equal to source text width when ANSI colors are used", () => {
    const ansiTheme = {
      getFgAnsi: (color: string) => color === "accent" ? "\x1b[38;5;33m" : "\x1b[38;5;244m",
    } as any;
    const rendered = shimmerText("Reading files", ansiTheme, undefined, 350);

    expect(visibleWidth(rendered)).toBe(visibleWidth("Reading files"));
  });

  it("moves the shimmer band as time changes", () => {
    const first = shimmerText("Working…", theme, undefined, 0);
    const second = shimmerText("Working…", theme, undefined, 700);

    expect(second).not.toBe(first);
    expect(stripAnsi(second).replace(/<[^>]+>/g, "")).toBe("Working…");
  });
});
