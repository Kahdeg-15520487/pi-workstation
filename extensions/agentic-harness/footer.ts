import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { basename } from "path";
import { PLAN_PROGRESS_SPINNER_MS } from "./harness-progress.js";
import type { FooterGlyphMode, FooterPresetName } from "./ui-settings.js";
import { getCurrentTodos, subscribeOnChange, getTodoMarker, type SimpleTodoItem } from "./simple-todo.js";
import { shimmerText, type ShimmerPalette } from "./shimmer.js";

// Types

export interface GitStats {
  ahead: number;
  behind: number;
  dirty: number;
  untracked: number;
}

export interface ModelInfo {
  name: string;
  isLatest: boolean;
}

export interface FooterContext {
  cwd: string;
  getModelName: () => string | undefined;
  getContextUsage: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  getGitStats: () => GitStats | undefined;
  getThinkingLevel: () => "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
  getModelInfo: () => ModelInfo | undefined;
}

export interface CacheStats {
  totalInput: number;
  totalCacheRead: number;
  // Most recent turn's telemetry, so the footer can show a per-turn cache-hit
  // rate next to the session average. Optional: absent until the first turn
  // (and in older call sites), in which case only the session rate is shown.
  lastInput?: number;
  lastCacheRead?: number;
}

export interface ActiveToolStatus {
  name: string;
  intent?: string;
  startedAt: number;
}

export interface ActiveTools {
  running: Map<string, string | ActiveToolStatus>;
}

type FooterSegmentId = "logo" | "path" | "git" | "model" | "thinking" | "context" | "goal" | "statuses" | "tools" | "cache";

type FooterSegmentColor = ThemeColor | "logo" | "path" | "git" | "model" | "thinking" | "context" | "default";

type FooterSegment = {
  id: FooterSegmentId;
  text: string;
  icon: string;
  color: FooterSegmentColor;
  priority: number;
};

type FooterPresetDefinition = {
  lines: FooterSegmentId[][];
};

export interface FooterOptions {
  preset?: FooterPresetName;
  glyphs?: FooterGlyphMode;
  getGoalSummary?: () => string | undefined;
  /** Cosmetic override for the displayed model name. Falls back to the real active model name when unset. */
  modelDisplayName?: string;
}

// Nerd Font Icons

const ICONS = {
  logo: "π",
  folder: "",
  branch: "󰘬",
  model: "",
  thinking: "󰌵",
  context: "󰍛",
  cache: "󰆼",
  tool: "󰒓",
  status: "󰄬",
  goal: "󰓎",
} as const;

const ICONS_PLAIN = {
  logo: "π",
  folder: "📁",
  branch: "⎇",
  model: "◆",
  thinking: "◇",
  context: "◈",
  cache: "⊡",
  tool: "▶",
  status: "●",
  goal: "◎",
} as const;

let useNerdIcons = false;
function getIcons(glyphs?: FooterGlyphMode) {
  const mode = glyphs ?? (useNerdIcons ? "nerd" : "plain");
  return mode === "nerd" ? ICONS : ICONS_PLAIN;
}

// Presets

const FOOTER_PRESET_DEFINITIONS: Record<FooterPresetName, FooterPresetDefinition> = {
  // Two rows: an identity/status row (which may truncate long goal/tool/status
  // text) and a dedicated live-metrics row so context + cache rate are never
  // pushed off-screen by a long goal summary.
  default:  { lines: [["logo", "goal", "model", "path", "git", "tools", "statuses"], ["context", "cache"]] },
  compact:  { lines: [["logo", "goal", "model", "path", "git", "context", "cache", "statuses"]] },
  minimal:  { lines: [["logo", "goal", "path", "git", "context", "statuses"]] },
};

// Helpers

function progressBar(percent: number, barWidth: number, theme: Theme): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * barWidth);
  const empty = barWidth - filled;

  let color: ThemeColor;
  if (clamped < 60) color = "success";
  else if (clamped < 85) color = "warning";
  else color = "error";

  const bar = theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty));
  const label = theme.fg(color, `${Math.round(clamped)}%`);
  return `${bar} ${label}`;
}

function fitLine(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(text, width, "");
}

const POWERLINE_COLORS: Record<string, { fg: string; bg: string }> = {
  logo:     { fg: "\x1b[38;2;200;200;200m", bg: "\x1b[48;2;60;100;100m" },
  path:     { fg: "\x1b[38;2;200;200;200m", bg: "\x1b[48;2;60;100;100m" },
  model:    { fg: "\x1b[38;2;200;200;200m", bg: "\x1b[48;2;110;90;110m" },
  thinking: { fg: "\x1b[38;2;200;200;200m", bg: "\x1b[48;2;60;90;85m" },
  git:      { fg: "\x1b[38;2;200;200;200m", bg: "\x1b[48;2;120;100;60m" },
  context:  { fg: "\x1b[38;2;200;200;200m", bg: "\x1b[48;2;60;60;65m" },
  dim:      { fg: "\x1b[38;2;200;200;200m", bg: "\x1b[48;2;55;55;55m" },
  success:  { fg: "\x1b[38;2;200;200;200m", bg: "\x1b[48;2;65;95;75m" },
  warning:  { fg: "\x1b[38;2;200;200;200m", bg: "\x1b[48;2;110;85;45m" },
  accent:   { fg: "\x1b[38;2;200;200;200m", bg: "\x1b[48;2;70;70;100m" },
  default:  { fg: "\x1b[39m", bg: "\x1b[49m" },
};

const RESET = "\x1b[0m";

function segmentColor(name: string): { fg: string; bg: string } {
  return POWERLINE_COLORS[name] ?? POWERLINE_COLORS.default;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function getExtensionStatusText(statuses: ReadonlyMap<string, string>): string | null {
  const parts = [...statuses.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => stripAnsi(v).trim())
    .filter((v) => visibleWidth(v) > 0 && !v.includes("thinking:") && !v.includes("💾"));
  return parts.length > 0 ? parts.join(" · ") : null;
}

const ACTIVE_TOOL_SHIMMER_PALETTE: ShimmerPalette = {
  low: "dim",
  mid: "accent",
  high: "warning",
  bold: true,
};

function normalizeActiveToolStatus(value: string | ActiveToolStatus): ActiveToolStatus {
  return typeof value === "string"
    ? { name: value, startedAt: 0 }
    : value;
}

function activeToolDisplayText(values: Iterable<string | ActiveToolStatus>): string | null {
  const tools = [...values].map(normalizeActiveToolStatus);
  if (tools.length === 0) return null;
  tools.sort((a, b) => b.startedAt - a.startedAt);
  const primary = tools.find((tool) => tool.intent && tool.intent.trim().length > 0) ?? tools[0];
  const label = primary.intent?.trim() || primary.name;
  const suffix = tools.length > 1 ? ` +${tools.length - 1}` : "";
  return `${label}${suffix}`;
}

function renderPowerlineLine(segments: FooterSegment[], width: number, glyphs: FooterGlyphMode): string {
  if (width <= 0 || segments.length === 0) return "";

  const separator = glyphs === "nerd" ? "" : "";
  const parts: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const color = segmentColor(seg.color);
    const nextSeg = segments[i + 1];
    const nextColor = nextSeg ? segmentColor(nextSeg.color) : POWERLINE_COLORS.default;

    const icon = seg.icon ? `${seg.icon} ` : "";
    const text = ` ${icon}${seg.text} `;

    parts.push(`${color.fg}${color.bg}${text}`);

    if (i < segments.length - 1) {
      const separatorFg = glyphs === "nerd" ? `\x1b[38;2;${extractRgb(color.bg)}m` : nextColor.fg;
      parts.push(`${separatorFg}${nextColor.bg}${separator}`);
    } else {
      const separatorFg = glyphs === "nerd" ? `\x1b[38;2;${extractRgb(color.bg)}m` : POWERLINE_COLORS.default.fg;
      parts.push(`${separatorFg}\x1b[49m${separator}${RESET}`);
    }
  }

  return fitLine(parts.join(""), width);
}

function extractRgb(bgAnsi: string): string {
  // Extract R;G;B from \x1b[48;2;R;G;Bm
  const match = bgAnsi.match(/48;2;(\d+);(\d+);(\d+)m/);
  return match ? `${match[1]};${match[2]};${match[3]}` : "0;0;0";
}

// WorkstationFooter

export class WorkstationFooter implements Component {
  private theme: Theme;
  private footerData: ReadonlyFooterDataProvider;
  private footerCtx: FooterContext;
  private cacheStats: CacheStats;
  private activeTools: ActiveTools;
  private tui: Pick<TUI, "requestRender"> | null;
  private preset: FooterPresetName;
  private glyphs: FooterGlyphMode;
  private modelDisplayNameOverride?: string;
  private getGoalSummary: () => string | undefined;
  private unsubscribeTodo: (() => void) | null = null;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    theme: Theme,
    footerData: ReadonlyFooterDataProvider,
    footerCtx: FooterContext,
    cacheStats: CacheStats,
    activeTools: ActiveTools,
    tui: Pick<TUI, "requestRender"> | null = null,
    options: FooterOptions = {},
  ) {
    this.theme = theme;
    this.footerData = footerData;
    this.footerCtx = footerCtx;
    this.cacheStats = cacheStats;
    this.activeTools = activeTools;
    this.preset = options.preset ?? "default";
    this.glyphs = options.glyphs ?? (useNerdIcons ? "nerd" : "plain");
    this.modelDisplayNameOverride = options.modelDisplayName;
    this.getGoalSummary = options.getGoalSummary ?? (() => undefined);
    this.tui = tui;
    this.unsubscribeTodo = subscribeOnChange(() => this.schedulePlanRender());
    this.updateSpinnerTimer();
  }

  invalidate() { this.schedulePlanRender(); }

  dispose() {
    if (this.spinnerTimer) { clearInterval(this.spinnerTimer); this.spinnerTimer = null; }
    this.unsubscribeTodo?.(); this.unsubscribeTodo = null;
  }

  private schedulePlanRender() {
    this.updateSpinnerTimer();
    this.tui?.requestRender();
  }

  private hasAnimatedFooterContent(): boolean {
    return getCurrentTodos().some((t) => t.status === "in_progress") || this.activeTools.running.size > 0;
  }

  private updateSpinnerTimer() {
    const has = this.hasAnimatedFooterContent();
    if (has && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        if (!this.hasAnimatedFooterContent()) { this.updateSpinnerTimer(); return; }
        this.tui?.requestRender();
      }, PLAN_PROGRESS_SPINNER_MS);
    } else if (!has && this.spinnerTimer) {
      clearInterval(this.spinnerTimer); this.spinnerTimer = null;
    }
  }

  private renderSimpleTodos(width: number): string[] {
    const todos = getCurrentTodos();
    if (todos.length === 0) return [];

    const t = this.theme;
    const lines: string[] = [];
    const pw = Math.max(0, width - 4);
    const done = todos.filter((t) => t.status === "completed").length;
    const inProgress = todos.find((t) => t.status === "in_progress");

    // Header with progress
    const header = `Todo ${done}/${todos.length}`;
    lines.push(fitLine(`  ${t.fg("accent", t.bold(header))}`, width));

    // Show in_progress item first (most important), then others (completed + pending)
    const maxItems = 5;
    const shown: SimpleTodoItem[] = [];
    if (inProgress) shown.push(inProgress);
    for (const todo of todos) {
      if (shown.length >= maxItems) break;
      if (todo === inProgress) continue;
      shown.push(todo);
    }

    for (const todo of shown) {
      const marker = getTodoMarker(todo.status);
      const color: Parameters<Theme["fg"]>[0] =
        todo.status === "in_progress" ? "warning" :
        todo.status === "completed" ? "success" : "dim";
      const text = truncateToWidth(todo.content, Math.max(0, pw - 4));
      lines.push(fitLine(`    ${t.fg(color, marker)} ${t.fg("dim", text)}`, width));
    }

    const remaining = todos.filter((t) => !shown.includes(t)).length;
    if (remaining > 0) {
      lines.push(fitLine(`    ${t.fg("dim", `... +${remaining} more`)}`, width));
    }

    return lines;
  }

  render(width: number): string[] {
    this.updateSpinnerTimer();
    return this.renderNormalFooter(width);
  }

  private renderNormalFooter(width: number): string[] {
    const t = this.theme;
    const border = t.fg("dim", "─".repeat(Math.max(0, width)));
    const segments = this.buildSegments();
    const preset = FOOTER_PRESET_DEFINITIONS[this.preset] ?? FOOTER_PRESET_DEFINITIONS.default;
    const renderedLines = preset.lines.map((line) => renderPowerlineLine(this.pickSegments(line, segments), width, this.glyphs));
    return [border, ...renderedLines];
  }

  private pickSegments(ids: FooterSegmentId[], segments: Map<FooterSegmentId, FooterSegment>): FooterSegment[] {
    return ids.map((id) => segments.get(id)).filter((s): s is FooterSegment => !!s);
  }

  private buildSegments(): Map<FooterSegmentId, FooterSegment> {
    const t = this.theme;
    const icons = getIcons(this.glyphs);
    const dirName = basename(this.footerCtx.cwd) || this.footerCtx.cwd;
    const branch = this.footerData.getGitBranch();
    const modelInfo = this.footerCtx.getModelInfo();
    const modelName = this.modelDisplayNameOverride ?? modelInfo?.name ?? this.footerCtx.getModelName() ?? "no model";
    const modelDisplay = modelInfo?.isLatest ? `${modelName} (latest)` : modelName;
    const usage = this.footerCtx.getContextUsage();
    const gitStats = this.footerCtx.getGitStats();

    const pct = usage?.percent ?? 0;
    const tokens = usage?.tokens ?? 0;
    const ctxK = usage ? Math.round(usage.contextWindow / 1000) : 0;
    const tokK = Math.round(tokens / 1000);
    const ctxPart = `${tokK}k/${ctxK}k`;

    // Session-cumulative cache-hit rate (steady, cost-oriented) and the latest
    // turn's rate (live, the cache-first loop's heartbeat). The turn rate leads;
    // the session average trails as faint context — mirroring the original project's
    // "cache N% · avg N%" status tag.
    const sessionTotal = this.cacheStats.totalInput + this.cacheStats.totalCacheRead;
    const sessionRate = sessionTotal > 0 ? Math.round((this.cacheStats.totalCacheRead / sessionTotal) * 100) : 0;
    const lastInput = this.cacheStats.lastInput ?? 0;
    const lastCacheRead = this.cacheStats.lastCacheRead ?? 0;
    const turnTotal = lastInput + lastCacheRead;
    const turnRate = turnTotal > 0 ? Math.round((lastCacheRead / turnTotal) * 100) : null;
    const cacheText = turnRate !== null ? `cache ${turnRate}% · avg ${sessionRate}%` : `cache ${sessionRate}%`;
    // Colour on whichever rate is leading the display.
    const primaryRate = turnRate ?? sessionRate;
    let cacheColor: ThemeColor;
    if (primaryRate >= 50) cacheColor = "success";
    else if (primaryRate >= 20) cacheColor = "warning";
    else cacheColor = "dim";

    const segs = new Map<FooterSegmentId, FooterSegment>();

    segs.set("logo", { id: "logo", text: "", icon: icons.logo, color: "logo", priority: 0 });
    segs.set("path", { id: "path", text: dirName, icon: icons.folder, color: "path", priority: 0 });

    if (branch && branch !== "detached") {
      const stats = gitStats;
      let gitText = branch;
      if (stats) {
        const parts: string[] = [];
        if (stats.ahead > 0) parts.push(`⇡${stats.ahead}`);
        if (stats.behind > 0) parts.push(`⇣${stats.behind}`);
        if (stats.dirty > 0) parts.push(`*${stats.dirty}`);
        if (stats.untracked > 0) parts.push(`?${stats.untracked}`);
        if (parts.length > 0) gitText += ` ${parts.join(" ")}`;
      }
      segs.set("git", { id: "git", text: gitText, icon: icons.branch, color: "git", priority: 1 });
    }

    segs.set("model", { id: "model", text: modelDisplay, icon: icons.model, color: "model", priority: 2 });

    segs.set("context", { id: "context", text: ctxPart, icon: icons.context, color: "context", priority: 0 });
    segs.set("cache", { id: "cache", text: cacheText, icon: icons.cache, color: cacheColor, priority: 5 });

    const goalSummary = this.getGoalSummary();
    if (goalSummary) {
      segs.set("goal", { id: "goal", text: goalSummary, icon: icons.goal, color: "accent", priority: 1 });
    }

    const statuses = this.footerData.getExtensionStatuses?.() ?? new Map<string, string>();
    const statusText = getExtensionStatusText(statuses);
    if (statusText) {
      segs.set("statuses", { id: "statuses", text: statusText, icon: icons.status, color: "warning", priority: 1 });
    }

    const activeToolText = activeToolDisplayText(this.activeTools.running.values());
    if (activeToolText) {
      segs.set("tools", {
        id: "tools",
        text: shimmerText(activeToolText, this.theme, ACTIVE_TOOL_SHIMMER_PALETTE),
        icon: icons.tool,
        color: "accent",
        priority: 4,
      });
    }

    return segs;
  }
}

// Test exports

export function setUseNerdIcons(value: boolean): void { useNerdIcons = value; }
export { ICONS, ICONS_PLAIN };
