import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { ICONS, ICONS_PLAIN, WorkstationFooter, setUseNerdIcons } from "../footer.js";
import type { FooterGlyphMode } from "../ui-settings.js";

setUseNerdIcons(false);

const stubTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  getFgAnsi: (_color: string) => "",
} as any;

const ansiTheme = {
  fg: (color: string, text: string) => `${ansiTheme.getFgAnsi(color)}${text}\x1b[39m`,
  bold: (text: string) => text,
  getFgAnsi: (color: string) => {
    const codes: Record<string, number> = {
      accent: 33, success: 34, warning: 35, error: 196, dim: 238, text: 15,
    };
    return `\x1b[38;5;${codes[color] ?? 15}m`;
  },
} as any;

function footerData(statuses: ReadonlyMap<string, string> = new Map()): ReadonlyFooterDataProvider {
  return {
    getGitBranch: () => "main",
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => 1,
    onBranchChange: () => () => {},
  };
}

function createFooter(
  statuses: ReadonlyMap<string, string> = new Map(),
  preset: "default" | "compact" | "minimal" = "default",
  gitStats = { ahead: 0, behind: 0, dirty: 0, untracked: 0 },
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined = "high",
  modelInfo = { name: "test-model", isLatest: false },
  glyphs?: FooterGlyphMode,
  goalSummary?: string,
): WorkstationFooter {
  return new WorkstationFooter(
    stubTheme,
    footerData(statuses),
    {
      cwd: "/tmp/powerline-project",
      getModelName: () => modelInfo.name,
      getContextUsage: () => ({ tokens: 42_000, contextWindow: 200_000, percent: 21 }),
      getGitStats: () => gitStats,
      getThinkingLevel: () => thinkingLevel,
      getModelInfo: () => modelInfo,
    },
    { totalInput: 100, totalCacheRead: 50 },
    { running: new Map([["tool-1", "read"]]) },
    null,
    { preset, glyphs, getGoalSummary: () => goalSummary },
  );
}

function expectAllLinesFit(lines: string[], width: number): void {
  for (const line of lines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
}

describe("WorkstationFooter Powerline styling", () => {
  it("defaults to plain footer glyphs without Nerd Font or literal separators", () => {
    const rendered = createFooter().render(100).join("\n");

    expect(rendered).not.toContain("");
    expect(rendered).not.toContain("|");
    expect(rendered).not.toContain(ICONS.folder);
    expect(rendered).not.toContain(ICONS.branch);
    expect(rendered).not.toContain(ICONS.model);
    expect(rendered).not.toContain(ICONS.thinking);
    expect(rendered).toContain(ICONS_PLAIN.folder);
  });

  it("renders concrete Nerd Font icons and the Powerline segment separator when opted in", () => {
    expect(Object.values(ICONS).every((icon) => icon.length > 0)).toBe(true);

    const rendered = createFooter(new Map(), "default", { ahead: 0, behind: 0, dirty: 0, untracked: 0 }, "high", { name: "test-model", isLatest: false }, "nerd").render(100).join("\n");

    expect(rendered).toContain("");
    expect(rendered).toContain(ICONS.folder);
    expect(rendered).toContain(ICONS.branch);
    expect(rendered).toContain(ICONS.model);
    expect(rendered).toContain(ICONS.logo);
  });

  it("renders solid background blocks with 48;2 ANSI sequences", () => {
    const footer = new WorkstationFooter(
      ansiTheme,
      footerData(),
      {
        cwd: "/tmp/powerline-project",
        getModelName: () => "test-model",
        getContextUsage: () => ({ tokens: 42_000, contextWindow: 200_000, percent: 21 }),
        getGitStats: () => ({ ahead: 0, behind: 0, dirty: 0, untracked: 0 }),
        getThinkingLevel: () => "high",
        getModelInfo: () => ({ name: "test-model", isLatest: false }),
      },
      { totalInput: 100, totalCacheRead: 50 },
      { running: new Map() },
      null,
    );

    const rendered = footer.render(100).join("\n");

    // Assert the mechanism (solid truecolour background blocks), not specific
    // RGB constants. The palette is a design choice and has already been
    // recoloured once, which is exactly what made hard-coded literals go stale.
    const backgrounds = new Set(rendered.match(/\x1b\[48;2;\d+;\d+;\d+m/g) ?? []);
    expect(backgrounds.size).toBeGreaterThanOrEqual(3);
    expect(rendered).not.toContain("|");
    expect(rendered).not.toContain("");
  });

  it("does not insert visible separator columns in plain glyph mode", () => {
    const footer = new WorkstationFooter(
      ansiTheme,
      footerData(),
      {
        cwd: "/tmp/powerline-project",
        getModelName: () => "test-model",
        getContextUsage: () => ({ tokens: 42_000, contextWindow: 200_000, percent: 21 }),
        getGitStats: () => ({ ahead: 0, behind: 0, dirty: 0, untracked: 0 }),
        getThinkingLevel: () => "high",
        getModelInfo: () => ({ name: "test-model", isLatest: false }),
      },
      { totalInput: 100, totalCacheRead: 50 },
      { running: new Map() },
      null,
      { glyphs: "plain" },
    );

    const rendered = footer.render(100).join("\n");

    expect(rendered).not.toContain("|");
    expect(rendered).not.toContain("\x1b[38;2;0;175;175m\x1b[48;2;215;135;175m|");
  });

  it("shows the real active model name by default (no cosmetic override configured)", () => {
    const footer = new WorkstationFooter(
      ansiTheme,
      footerData(),
      {
        cwd: "/tmp/powerline-project",
        getModelName: () => "test-model",
        getContextUsage: () => ({ tokens: 42_000, contextWindow: 200_000, percent: 21 }),
        getGitStats: () => ({ ahead: 0, behind: 0, dirty: 0, untracked: 0 }),
        getThinkingLevel: () => "high",
        getModelInfo: () => ({ name: "glm-4.7", isLatest: false }),
      },
      { totalInput: 100, totalCacheRead: 50 },
      { running: new Map() },
      null,
      { glyphs: "plain" },
    );

    const rendered = footer.render(100).join("\n");

    expect(rendered).toContain("glm-4.7");
  });

  it("shows the modelDisplayName cosmetic override instead of the real model name when configured", () => {
    const footer = new WorkstationFooter(
      ansiTheme,
      footerData(),
      {
        cwd: "/tmp/powerline-project",
        getModelName: () => "test-model",
        getContextUsage: () => ({ tokens: 42_000, contextWindow: 200_000, percent: 21 }),
        getGitStats: () => ({ ahead: 0, behind: 0, dirty: 0, untracked: 0 }),
        getThinkingLevel: () => "high",
        getModelInfo: () => ({ name: "glm-4.7", isLatest: false }),
      },
      { totalInput: 100, totalCacheRead: 50 },
      { running: new Map() },
      null,
      { glyphs: "plain", modelDisplayName: "My Custom Model" },
    );

    const rendered = footer.render(100).join("\n");

    expect(rendered).toContain("My Custom Model");
    expect(rendered).not.toContain("glm-4.7");
  });
});

describe("WorkstationFooter status bridge", () => {
  it("renders the base footer without extension statuses", () => {
    const footer = createFooter();
    const lines = footer.render(150);

    // border + identity row + live-metrics row (context/cache)
    expect(lines.length).toBe(3);
    const rendered = lines.join("\n");
    const plain = rendered.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("powerline-project");
    expect(plain).toContain("main");
    expect(plain).toContain("test-model");
    expect(plain).not.toContain("thinking:");
    expect(plain).toContain("42k/200k");
    expect(plain).toContain("cache 33%");
    expect(plain).toContain("read");
    expectAllLinesFit(lines, 150);
  });

  it("renders a per-turn cache rate alongside the session average", () => {
    const footer = new WorkstationFooter(
      stubTheme,
      footerData(),
      {
        cwd: "/tmp/powerline-project",
        getModelName: () => "test-model",
        getContextUsage: () => ({ tokens: 42_000, contextWindow: 200_000, percent: 21 }),
        getGitStats: () => ({ ahead: 0, behind: 0, dirty: 0, untracked: 0 }),
        getThinkingLevel: () => "high",
        getModelInfo: () => ({ name: "test-model", isLatest: false }),
      },
      // turn: 90/(10+90) = 90%; session: 50/(100+50) = 33%
      { totalInput: 100, totalCacheRead: 50, lastInput: 10, lastCacheRead: 90 },
      { running: new Map() },
      null,
    );

    const plain = footer.render(150).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("cache 90% · avg 33%");
  });

  it("falls back to the session cache rate when no turn telemetry exists yet", () => {
    // createFooter's stats have no last* fields → session-only display.
    const plain = createFooter().render(150).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("cache 33%");
    expect(plain).not.toContain("avg");
  });

  it("renders one extension status from footerData.getExtensionStatuses", () => {
    const footer = createFooter(new Map([["harness", "Team running"]]));
    const lines = footer.render(150);

    expect(lines.join("\n")).toContain("Team running");
    expectAllLinesFit(lines, 150);
  });

  it("omits the goal segment when no active goal summary exists", () => {
    const rendered = createFooter().render(150).join("\n");

    expect(rendered).not.toContain("verify:");
    expect(rendered).not.toContain("subgoals:");
  });

  it("renders active goal summary within the footer width", () => {
    const footer = createFooter(
      new Map(),
      "default",
      { ahead: 0, behind: 0, dirty: 0, untracked: 0 },
      "high",
      { name: "test-model", isLatest: false },
      "plain",
      "goal-1 | verify:pending | subgoals:1/3 | Ship an intentionally long active goal title",
    );
    const lines = footer.render(80);
    const rendered = lines.join("\n");

    expect(rendered).toContain("goal-1");
    expect(rendered).toContain("verify:pending");
    expectAllLinesFit(lines, 80);
  });

  it("renders verifier fail blocker indicator in the goal segment", () => {
    const rendered = createFooter(
      new Map(),
      "default",
      { ahead: 0, behind: 0, dirty: 0, untracked: 0 },
      "high",
      { name: "test-model", isLatest: false },
      "plain",
      "goal-1 | verify:fail | subgoals:0/2 | Fix blockers",
    ).render(150).join("\n");

    expect(rendered).toContain("verify:fail");
  });

  it("renders multiple extension statuses in stable key order", () => {
    const footer = createFooter(new Map([
      ["zeta", "Zed status"],
      ["alpha", "Alpha status"],
    ]));
    const rendered = footer.render(180).join("\n");

    expect(rendered).toContain("Alpha status");
    expect(rendered).toContain("Zed status");
    expect(rendered.indexOf("Alpha status")).toBeLessThan(rendered.indexOf("Zed status"));
  });

  it("ignores empty and whitespace-only extension statuses", () => {
    const footer = createFooter(new Map([
      ["empty", ""],
      ["spaces", "   "],
      ["ready", "Ready"],
    ]));
    const rendered = footer.render(150).join("\n");

    expect(rendered).toContain("Ready");
    expect(rendered).not.toContain("empty");
    expect(rendered).not.toContain("spaces");
  });

  it("truncates long extension statuses without exceeding width", () => {
    const footer = createFooter(new Map([
      ["harness", "Deploying a very long background operation that should be truncated safely"],
    ]));
    const width = 44;
    const lines = footer.render(width);

    expectAllLinesFit(lines, width);
  });

  it("keeps every normal footer line within narrow render widths", () => {
    const footer = createFooter(new Map([
      ["harness", "Narrow status"],
      ["memory", "Memory warm"],
    ]));

    for (const width of [24, 32, 40, 60]) {
      expectAllLinesFit(footer.render(width), width);
    }
  });

  it("renders distinct default, compact, and minimal preset layouts", () => {
    const statuses = new Map([["harness", "Ready"]]);
    const defaultLines = createFooter(statuses, "default").render(150);
    const compactLines = createFooter(statuses, "compact").render(150);
    const minimalLines = createFooter(statuses, "minimal").render(150);

    expect(defaultLines.length).toBe(3);
    expect(compactLines.length).toBe(2);
    expect(minimalLines.length).toBe(2);
    expect(defaultLines.join("\n")).toContain("42k/200k");
    expect(defaultLines.join("\n")).toContain("cache 33%");
    expect(compactLines.join("\n")).toContain("42k/200k");
    expect(compactLines.join("\n")).toContain("cache 33%");
    expect(minimalLines.join("\n")).toContain("42k/200k");
    expect(minimalLines.join("\n")).not.toContain("test-model");
    expect(minimalLines.join("\n")).not.toContain("cache");
    expect(defaultLines.join("\n")).toContain("Ready");
    expect(compactLines.join("\n")).toContain("Ready");
    expect(minimalLines.join("\n")).toContain("Ready");
  });

  it("keeps every preset width-safe at narrow and normal widths", () => {
    const statuses = new Map([["harness", "Preset status that may need truncation"]]);

    for (const preset of ["default", "compact", "minimal"] as const) {
      for (const width of [28, 44, 100]) {
        expectAllLinesFit(createFooter(statuses, preset).render(width), width);
      }
    }
  });

  it("renders git stats when available", () => {
    const footer = createFooter(new Map(), "default", { ahead: 3, behind: 0, dirty: 5, untracked: 2 });
    const rendered = footer.render(100).join("\n");

    expect(rendered).toContain("⇡3");
    expect(rendered).toContain("*5");
    expect(rendered).toContain("?2");
  });

  it("renders model with (latest) tag when isLatest is true", () => {
    const footer = createFooter(new Map(), "default", { ahead: 0, behind: 0, dirty: 0, untracked: 0 }, "high", { name: "Opus 4.5", isLatest: true });
    const rendered = footer.render(100).join("\n");

    expect(rendered).toContain("Opus 4.5 (latest)");
  });

  it("never renders a thinking segment, at any level", () => {
    for (const level of ["off", "high", "xhigh"] as const) {
      const rendered = createFooter(new Map(), "default", { ahead: 0, behind: 0, dirty: 0, untracked: 0 }, level)
        .render(150)
        .join("\n");
      expect(rendered).not.toContain("thinking:");
    }
  });

  it("renders active tool intent text in the tools segment", () => {
    const footer = new WorkstationFooter(
      ansiTheme,
      footerData(),
      {
        cwd: "/tmp/powerline-project",
        getModelName: () => "test-model",
        getContextUsage: () => ({ tokens: 42_000, contextWindow: 200_000, percent: 21 }),
        getGitStats: () => ({ ahead: 0, behind: 0, dirty: 0, untracked: 0 }),
        getThinkingLevel: () => "high",
        getModelInfo: () => ({ name: "test-model", isLatest: false }),
      },
      { totalInput: 100, totalCacheRead: 50 },
      { running: new Map([["tool-1", { name: "read", intent: "Reading project files", startedAt: 10 }]]) },
      null,
    );

    const rendered = footer.render(160).join("\n");
    const plain = rendered.replace(/\x1b\[[0-9;]*m/g, "");

    expect(plain).toContain("Reading project files");
    expect(plain).not.toContain("1 read");
  });

  it("keeps footer width-safe with shimmered active tool intent", () => {
    const footer = new WorkstationFooter(
      ansiTheme,
      footerData(),
      {
        cwd: "/tmp/powerline-project",
        getModelName: () => "test-model",
        getContextUsage: () => ({ tokens: 42_000, contextWindow: 200_000, percent: 21 }),
        getGitStats: () => ({ ahead: 0, behind: 0, dirty: 0, untracked: 0 }),
        getThinkingLevel: () => "high",
        getModelInfo: () => ({ name: "test-model", isLatest: false }),
      },
      { totalInput: 100, totalCacheRead: 50 },
      { running: new Map([["tool-1", { name: "bash", intent: "Running a very long command that must be truncated safely", startedAt: 10 }]]) },
      null,
    );

    for (const width of [28, 44, 80]) {
      expectAllLinesFit(footer.render(width), width);
    }
  });
});

describe("provider segment", () => {
  function providerFooter(options: {
    provider?: string;
    limit?: { text: string; remainingPercent?: number };
    visibility?: Record<string, boolean>;
    preset?: "default" | "compact" | "minimal";
  }): WorkstationFooter {
    return new WorkstationFooter(
      stubTheme,
      footerData(),
      {
        cwd: "/tmp/powerline-project",
        getModelName: () => "test-model",
        getContextUsage: () => ({ tokens: 42_000, contextWindow: 200_000, percent: 21 }),
        getGitStats: () => ({ ahead: 0, behind: 0, dirty: 0, untracked: 0 }),
        getThinkingLevel: () => "high",
        getModelInfo: () => ({ name: "test-model", isLatest: false }),
        getProviderName: () => options.provider,
      },
      { totalInput: 100, totalCacheRead: 50 },
      { running: new Map() },
      null,
      {
        preset: options.preset ?? "default",
        segmentVisibility: options.visibility,
        getUsageLimit: () => options.limit,
      },
    );
  }

  it("renders the provider with its window list", () => {
    const rendered = providerFooter({
      provider: "opencode-go",
      limit: { text: "47%", remainingPercent: 47 },
    }).render(200).join("\n");

    expect(rendered).toContain("opencode · 47%");
  });

  it("shortens github-copilot", () => {
    const rendered = providerFooter({
      provider: "github-copilot",
      limit: { text: "63%", remainingPercent: 63 },
    }).render(200).join("\n");

    expect(rendered).toContain("copilot · 63%");
  });

  it("shows an em dash before the first snapshot arrives", () => {
    const rendered = providerFooter({ provider: "opencode-go" }).render(200).join("\n");
    expect(rendered).toContain("opencode · —");
  });

  it("omits the segment entirely when the provider is unknown", () => {
    const rendered = providerFooter({ limit: { text: "47%", remainingPercent: 47 } }).render(200).join("\n");
    expect(rendered).not.toContain("opencode");
  });

  it("can be switched off through segmentVisibility", () => {
    const visible = providerFooter({
      provider: "opencode-go",
      limit: { text: "47%", remainingPercent: 47 },
    });
    const hidden = providerFooter({
      provider: "opencode-go",
      limit: { text: "47%", remainingPercent: 47 },
      visibility: { provider: false },
    });

    expect(visible.render(200).join("\n")).toContain("opencode · 47%");
    expect(hidden.render(200).join("\n")).not.toContain("opencode");
  });

  it("colours the block by how much quota is left", () => {
    // The colour must be attached to THIS segment: the cache segment also uses
    // the warning background, so a bare background lookup would be ambiguous.
    const colorFor = (remainingPercent: number) => {
      const rendered = providerFooter({
        provider: "opencode-go",
        limit: { text: `${remainingPercent}%`, remainingPercent },
      }).render(200).join("\n");
      if (/\x1b\[48;2;120;55;55m[^\x1b]*opencode/.test(rendered)) return "error";
      if (/\x1b\[48;2;110;85;45m[^\x1b]*opencode/.test(rendered)) return "warning";
      if (/\x1b\[48;2;65;95;75m[^\x1b]*opencode/.test(rendered)) return "success";
      return "provider";
    };

    expect(colorFor(5)).toBe("error");
    expect(colorFor(30)).toBe("warning");
    expect(colorFor(80)).toBe("success");
  });

  it("uses the neutral colour while the limit is unknown", () => {
    const rendered = providerFooter({ provider: "opencode-go" }).render(200).join("\n");
    expect(rendered).toMatch(/\x1b\[48;2;75;85;95m[^\x1b]*opencode/);
  });

  it("rides along in the compact preset", () => {
    const rendered = providerFooter({
      provider: "opencode-go",
      limit: { text: "47%", remainingPercent: 47 },
      preset: "compact",
    }).render(250).join("\n");

    expect(rendered).toContain("opencode · 47%");
  });

  it("stays out of the minimal preset", () => {
    const rendered = providerFooter({
      provider: "opencode-go",
      limit: { text: "47%", remainingPercent: 47 },
      preset: "minimal",
    }).render(250).join("\n");

    expect(rendered).not.toContain("opencode");
  });
});
