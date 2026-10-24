import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterAll, describe, it, expect, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createBashTool: vi.fn(() => ({
    name: "bash",
    label: "bash",
    description: "mock bash",
    parameters: {},
    execute: vi.fn(),
  })),
  isToolCallEventType: (toolName: string, event: any) => event?.toolName === toolName,
  keyHint: (k: string, d?: string) => `${k}${d ? ` ${d}` : ""}`,
  keyText: (t: string) => t,
  rawKeyHint: (k: string, d?: string) => `${k}${d ? ` ${d}` : ""}`,
  convertToLlm: vi.fn((x: unknown) => x),
}));

vi.mock("@earendil-works/pi-tui", () => ({
  Text: class MockText {},
  truncateToWidth: (text: string, width?: number) => typeof width === "number" ? text.slice(0, width) : text,
  visibleWidth: (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").length,
}));

vi.mock("@earendil-works/pi-ai", () => ({
  complete: vi.fn(),
}));

vi.mock("../ui-settings.js", () => ({
  resolveAgenticUiSettings: vi.fn(() => ({ footerPreset: "compact", footerGlyphs: "plain" })),
}));

import extension from "../index.js";
import { resolveAgenticUiSettings } from "../ui-settings.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentic-extension-"));
  tempDirs.push(dir);
  return dir;
}

const originalEnv = {
  PI_AGENTIC_MICROCOMPACTION: process.env.PI_AGENTIC_MICROCOMPACTION,
};

beforeEach(() => {
  delete process.env.PI_AGENTIC_MICROCOMPACTION;
});

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function createMockPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, any[]>();

  const mockPi: any = {
    registerTool: (def: any) => {
      tools.set(def.name, def);
    },
    registerCommand: (name: string, def: any) => {
      commands.set(name, def);
    },
    on: (event: string, handler: any) => {
      if (!events.has(event)) events.set(event, []);
      events.get(event)!.push(handler);
    },
    sendUserMessage: vi.fn(),
  };

  return { mockPi, tools, commands, events };
}

describe("Extension Registration", () => {
  it("should register ask_user_question tool", () => {
    const { mockPi, tools } = createMockPi();
    extension(mockPi);

    const tool = tools.get("ask_user_question");
    expect(tool).toBeDefined();
    expect(tool.promptSnippet).toBeDefined();
    expect(tool.promptGuidelines).toBeDefined();
    expect(tool.promptGuidelines.length).toBeGreaterThan(0);
  });

  it("should register webfetch tool with schema", () => {
    const { mockPi, tools } = createMockPi();
    extension(mockPi);

    const tool = tools.get("webfetch");
    expect(tool).toBeDefined();
    expect(tool.name).toBe("webfetch");
    expect(tool.promptSnippet).toBeDefined();
    expect(tool.promptGuidelines.length).toBeGreaterThan(0);
    expect(tool.renderCall).toBeTypeOf("function");
    expect(tool.renderResult).toBeTypeOf("function");
    const schema = tool.parameters;
    expect(schema.properties.url).toBeDefined();
    expect(schema.properties.raw).toBeDefined();
    expect(schema.properties.maxLength).toBeDefined();
    expect(schema.required).toContain("url");
  });

  it("should register harness tools", () => {
    const { mockPi, tools } = createMockPi();
    extension(mockPi);

    for (const name of ["todoread", "todowrite", "harness_milestone", "harness_plan", "harness_todo"]) {
      expect(tools.get(name)).toBeDefined();
    }
    expect(tools.get("harness_plan")!.promptSnippet).toBeUndefined();
    expect(tools.get("harness_plan")!.promptGuidelines).toBeUndefined();
    expect(tools.get("harness_todo")!.promptSnippet).toBeUndefined();
    expect(tools.get("harness_todo")!.promptGuidelines).toBeUndefined();
    expect(tools.get("todoread")!.promptGuidelines.length).toBeGreaterThan(0);
    expect(tools.get("todowrite")!.promptGuidelines.length).toBeGreaterThan(0);

    const schema = tools.get("harness_milestone")!.parameters;
    expect(schema.required).toContain("runId");
    expect(schema.required).toContain("action");
    expect(schema.properties.action.enum).toEqual([
      "create", "update", "set_status", "load", "render",
    ]);
  });

  it("should NOT register removed tools", () => {
    const { mockPi, tools } = createMockPi();
    extension(mockPi);

    expect(tools.get("subagent")).toBeUndefined();
    expect(tools.get("team")).toBeUndefined();
    expect(tools.get("clarification_state")).toBeUndefined();
  });

  it("should register kept commands and NOT removed ones", () => {
    const { mockPi, commands } = createMockPi();
    extension(mockPi);

    for (const name of ["init", "setup", "welcome", "stash-save", "stash-restore", "stash-clear"]) {
      expect(commands.has(name)).toBe(true);
    }
    for (const name of ["clarify", "goal", "review", "ask", "team", "reset-phase"]) {
      expect(commands.has(name)).toBe(false);
    }
  });

  it("should register event handlers", () => {
    const { mockPi, events } = createMockPi();
    extension(mockPi);

    for (const name of [
      "resources_discover",
      "before_agent_start",
      "session_start",
      "context",
      "session_before_compact",
      "tool_result",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "session_shutdown",
    ]) {
      expect(events.has(name)).toBe(true);
    }
    // Sandbox approval gate and phase-restore hooks are removed.
    expect(events.has("tool_call")).toBe(false);
    expect(events.has("session_compact")).toBe(false);
  });

  it("should prefer todoread and todowrite in active tools", () => {
    const { mockPi } = createMockPi();
    const activeTools = ["todoread", "todowrite", "harness_plan", "harness_todo", "harness_milestone"];
    mockPi.getActiveTools = vi.fn(() => activeTools);
    mockPi.setActiveTools = vi.fn();

    extension(mockPi);

    expect(mockPi.setActiveTools).toHaveBeenCalledWith([
      "todoread",
      "todowrite",
      "harness_milestone",
    ]);
  });
});

describe("before_agent_start Event", () => {
  it("should append Progress Tracking rules to the system prompt", async () => {
    const { mockPi, events } = createMockPi();
    extension(mockPi);

    const handlers = events.get("before_agent_start")!;
    const result = await handlers[0](
      { type: "before_agent_start", prompt: "test", systemPrompt: "base" },
      { cwd: "." } as any
    );

    expect(result?.systemPrompt).toContain("base");
    expect(result?.systemPrompt).toContain("## Progress Tracking");
    expect(result?.systemPrompt).toContain("todoread before status changes");
    // No goal/verifier/delegation language remains.
    expect(result?.systemPrompt).not.toContain("reviewer-verifier");
    expect(result?.systemPrompt).not.toContain("Available Subagents");
    expect(result?.systemPrompt).not.toContain("Active Workflow:");
  });
});

describe("context microcompaction", () => {
  it("should leave context unchanged by default", async () => {
    const { mockPi, events } = createMockPi();
    extension(mockPi);

    const handler = events.get("context")?.at(-1);
    const result = await handler(
      {
        type: "context",
        messages: [
          {
            role: "toolResult",
            toolName: "bash",
            content: [{ type: "text", text: "a".repeat(5000) }],
            isError: false,
            timestamp: Date.now() - 2 * 60 * 60 * 1000,
          },
        ],
      },
      {},
    );

    expect(result).toBeUndefined();
  });

  it("should microcompact context only when explicitly enabled", async () => {
    process.env.PI_AGENTIC_MICROCOMPACTION = "1";
    const { mockPi, events } = createMockPi();
    extension(mockPi);

    const handler = events.get("context")?.at(-1);
    const result = await handler(
      {
        type: "context",
        messages: [
          {
            role: "toolResult",
            toolName: "bash",
            content: [{ type: "text", text: "a".repeat(5000) }],
            isError: false,
            timestamp: Date.now() - 2 * 60 * 60 * 1000,
          },
        ],
      },
      {},
    );

    expect(result?.messages[0].content[0].text).toBe("[Compacted] bash result");
  });
});

describe("ask_user_question Tool", () => {
  it("should return user answer for free-text input", async () => {
    const { mockPi, tools } = createMockPi();
    extension(mockPi);

    const tool = tools.get("ask_user_question");
    const mockCtx: any = {
      ui: {
        input: vi.fn().mockResolvedValue("user typed this"),
        select: vi.fn(),
      },
    };

    const result = await tool.execute(
      "call-1",
      { question: "What do you want?" },
      undefined,
      undefined,
      mockCtx
    );

    expect(result.content[0].text).toContain("Q: What do you want?");
    expect(result.content[0].text).toContain("A: user typed this");
    expect(mockCtx.ui.input).toHaveBeenCalledWith(
      "What do you want?",
      undefined,
      { signal: undefined }
    );
  });

  it("should use select UI when choices are provided and auto-append custom input", async () => {
    const { mockPi, tools } = createMockPi();
    extension(mockPi);

    const tool = tools.get("ask_user_question");
    const mockCtx: any = {
      ui: {
        input: vi.fn(),
        select: vi.fn().mockResolvedValue("Option A"),
      },
    };

    const result = await tool.execute(
      "call-2",
      { question: "Pick one", choices: ["Option A", "Option B"] },
      undefined,
      undefined,
      mockCtx
    );

    expect(result.content[0].text).toContain("A: Option A");
    expect(mockCtx.ui.select.mock.calls[0][1]).toContain("Enter custom response");
  });

  it("should batch multiple questions", async () => {
    const { mockPi, tools } = createMockPi();
    extension(mockPi);

    const tool = tools.get("ask_user_question");
    const mockCtx: any = {
      ui: {
        input: vi.fn().mockResolvedValueOnce("blue").mockResolvedValueOnce("yes"),
        select: vi.fn(),
      },
    };

    const result = await tool.execute(
      "call-3",
      {
        questions: [
          { question: "Favorite color?" },
          { question: "Ready?" },
        ],
      },
      undefined,
      undefined,
      mockCtx
    );

    const text = result.content[0].text;
    expect(text).toContain("Favorite color?");
    expect(text).toContain("blue");
    expect(text).toContain("Ready?");
    expect(text).toContain("yes");
  });
});

describe("session_start Event", () => {
  it("installs the footer with resolved UI settings and does not install a header", async () => {
    (resolveAgenticUiSettings as any).mockClear();
    const { mockPi, events } = createMockPi();
    extension(mockPi);

    const sessionStart = events.get("session_start")?.[0];
    expect(sessionStart).toBeTypeOf("function");

    const setFooter = vi.fn();
    const setHeader = vi.fn();
    const ctx: any = {
      cwd: "/tmp/project",
      hasUI: true,
      model: { name: "test-model" },
      modelRegistry: { getAvailable: () => [] },
      getContextUsage: () => ({ tokens: 1, contextWindow: 10, percent: 10 }),
      ui: {
        setHeader,
        setFooter,
        setWidget: vi.fn(),
        setStatus: vi.fn(),
        setWorkingVisible: vi.fn(),
        notify: vi.fn(),
      },
      sessionManager: { getEntries: () => [], getBranch: () => [] },
    };

    await sessionStart({ reason: "startup" }, ctx);

    expect(resolveAgenticUiSettings).toHaveBeenCalledWith({ cwd: "/tmp/project" });
    expect(setFooter).toHaveBeenCalledTimes(1);
    expect(setHeader).not.toHaveBeenCalled();

    const factory = setFooter.mock.calls[0][0];
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as any;
    const footer = factory({ requestRender: vi.fn() }, theme, {
      getGitBranch: () => "main",
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 1,
      onBranchChange: () => () => {},
    });

    expect(footer.render(100).length).toBe(2);
    footer.dispose?.();
  });
});

describe("source-level contracts", () => {
  it("index.ts must not reference removed runtime modules", async () => {
    const { readFile } = await import("fs/promises");
    const src = await readFile(new URL("../index.ts", import.meta.url), "utf-8");
    for (const token of [
      "./goal-state.js",
      "./clarification-state.js",
      "./subagent.js",
      "./team.js",
      "./sandbox/",
      "./render.js",
      "clarification_state",
      'registerCommand("clarify"',
      'registerCommand("goal"',
      'registerCommand("review"',
      'registerCommand("team"',
    ]) {
      expect(src).not.toContain(token);
    }
  });

  it("skills dir no longer bundles goal/clarification skills", async () => {
    const { readdir, stat } = await import("node:fs/promises");
    const skillsDir = new URL("../skills/", import.meta.url);
    const entries = await readdir(skillsDir);
    const dirs: string[] = [];
    for (const entry of entries) {
      const s = await stat(new URL(entry, skillsDir));
      if (s.isDirectory()) dirs.push(entry);
    }
    expect(dirs).not.toContain("agentic-goal");
    expect(dirs).not.toContain("agentic-clarification");
    expect(dirs).toContain("agentic-brainstorming");
    expect(dirs).toContain("agentic-karpathy");
    expect(dirs).toContain("agentic-rob-pike");
    expect(dirs).toContain("agentic-simplify");
    expect(dirs).toContain("agentic-systematic-debugging");
  });
});