// extensions/agentic-harness/editor-border.ts
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

/**
 * Render a border line with left/right content embedded inside horizontal fill.
 *
 * Layout: ─<left>─────<right>─
 *
 * When content doesn't fit: truncates right first, then left.
 * Minimum gap between left and right: 3 fill characters.
 */
export function fitBorder(
  left: string,
  right: string,
  width: number,
  borderColor: (text: string) => string,
  fillColor?: (text: string) => string,
): string {
  if (width <= 0) return "";
  const fill = fillColor ?? borderColor;
  if (width <= 2) return borderColor("─".repeat(width));

  let leftText = left;
  let rightText = right;
  const endCapWidth = 2; // leading ─ and trailing ─
  const minGap = 3;

  // Truncate right first (less important), then left
  while (
    endCapWidth + visibleWidth(leftText) + visibleWidth(rightText) + minGap > width &&
    visibleWidth(rightText) > 0
  ) {
    rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
  }
  while (
    endCapWidth + visibleWidth(leftText) + visibleWidth(rightText) + minGap > width &&
    visibleWidth(leftText) > 0
  ) {
    leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
  }

  const gapWidth = Math.max(
    0,
    width - endCapWidth - visibleWidth(leftText) - visibleWidth(rightText),
  );
  return `${borderColor("─")}${leftText}${fill("─".repeat(gapWidth))}${rightText}${borderColor("─")}`;
}

/** Separator between segments */
const SEP = " · ";

/** oh-my-pi dark theme color palette for status line segments */
export const BORDER_COLORS = {
  model: "#d787af",
  thinking: "#8787af",
  path: "#00afaf",
  gitClean: "#5faf5f",
  gitDirty: "#d7af5f",
  context: "#8787af",
  contextHigh: "#d7af5f",
  contextCritical: "#fc3a4b",
  accent: "#febc38",
  muted: "#777d88",
} as const;

/** ANSI 24-bit foreground color helper */
export function fg24(hex: string, text: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export interface BorderContext {
  modelName: string;
  thinkingLevel: string;
  cwd: string;
  gitBranch: string | null;
  gitDirty: boolean;
  contextPercent: number;
  contextWindow: number;
}

/** Build the left segment string for the top border */
export function buildTopLeftSegments(ctx: BorderContext): string {
  const parts: string[] = [];

  // Model name
  const model = ctx.modelName;
  parts.push(fg24(BORDER_COLORS.model, model));

  // Thinking level (only if not "off")
  if (ctx.thinkingLevel && ctx.thinkingLevel !== "off") {
    parts.push(fg24(BORDER_COLORS.thinking, ctx.thinkingLevel));
  }

  return parts.join(fg24(BORDER_COLORS.muted, SEP));
}

/** Build the right segment string for the top border */
export function buildTopRightSegments(ctx: BorderContext): string {
  const parts: string[] = [];

  // Shortened path
  const home = process.env.HOME || process.env.USERPROFILE || "";
  let shortPath = ctx.cwd;
  if (home && shortPath.startsWith(home)) {
    shortPath = "~" + shortPath.slice(home.length);
  }
  if (shortPath.length > 30) {
    shortPath = "…" + shortPath.slice(-29);
  }
  parts.push(fg24(BORDER_COLORS.path, shortPath));

  // Git branch
  if (ctx.gitBranch) {
    const branchColor = ctx.gitDirty ? BORDER_COLORS.gitDirty : BORDER_COLORS.gitClean;
    const dirtyMark = ctx.gitDirty ? "*" : "";
    parts.push(fg24(branchColor, `⎇ ${ctx.gitBranch}${dirtyMark}`));
  }

  // Context usage
  const pctStr = `${ctx.contextPercent.toFixed(0)}%`;
  let ctxColor: string = BORDER_COLORS.context;
  if (ctx.contextPercent > 80) ctxColor = BORDER_COLORS.contextCritical;
  else if (ctx.contextPercent > 50) ctxColor = BORDER_COLORS.contextHigh;
  const ctxTotal = ctx.contextWindow > 0
    ? `${pctStr}/${(ctx.contextWindow / 1000).toFixed(0)}k`
    : pctStr;
  parts.push(fg24(ctxColor, `ctx ${ctxTotal}`));

  return parts.join(fg24(BORDER_COLORS.muted, SEP));
}

/**
 * Build the top border line with embedded status segments.
 * Returns undefined to fall back to default border (e.g., during scroll).
 */
export function buildTopBorder(
  ctx: BorderContext,
  width: number,
  borderColor: (text: string) => string,
): string {
  const left = buildTopLeftSegments(ctx);
  const right = buildTopRightSegments(ctx);
  const fillFn = (text: string) => borderColor(text);
  return fitBorder(left, right, width, borderColor, fillFn);
}

/**
 * Build a simple bottom border line (no segments, just styled fill).
 * Preserves scroll indicator if applicable.
 */
export function buildBottomBorder(
  width: number,
  borderColor: (text: string) => string,
): string {
  return borderColor("─".repeat(width));
}
