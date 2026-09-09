import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerHarnessTools } from "../harness-tools.js";
import { HARNESS_STATE_EVENT_CUSTOM_TYPE } from "../harness-events.js";
import { readHarnessStateSnapshot } from "../harness-storage.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-tools-"));
  tempDirs.push(dir);
  return dir;
}

function createMockPi() {
  const tools = new Map<string, any>();
  const mockPi: any = {
    registerTool: (def: any) => {
      tools.set(def.name, def);
    },
  };
  return { mockPi, tools };
}

function createMockCtx(options?: { customEntries?: Array<{ type: string; data: unknown }> }) {
  const entries = options?.customEntries ?? [];
  return {
    sessionManager: {
      appendCustomEntry: (type: string, data: unknown) => {
        entries.push({ type, data });
      },
    },
  };
}

describe("harness-tools registration", () => {
  it("registers todoread, todowrite, harness_milestone, harness_plan, and harness_todo", () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);

    expect(tools.has("todoread")).toBe(true);
    expect(tools.has("todowrite")).toBe(true);
    expect(tools.has("harness_milestone")).toBe(true);
    expect(tools.has("harness_plan")).toBe(true);
    expect(tools.has("harness_todo")).toBe(true);
  });

  it("keeps legacy tools registered without prompt training", () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);

    const planTool = tools.get("harness_plan")!;
    expect(planTool.description).toBe(
      "Compatibility tool for structured harness plan state. Prefer todoread/todowrite for normal agent-facing progress updates.",
    );
    expect(planTool.promptSnippet).toBeUndefined();
    expect(planTool.promptGuidelines).toBeUndefined();

    const todoTool = tools.get("harness_todo")!;
    expect(todoTool.description).toBe(
      "Compatibility tool for structured harness todo state. Prefer todoread/todowrite for normal agent-facing progress updates.",
    );
    expect(todoTool.promptSnippet).toBeUndefined();
    expect(todoTool.promptGuidelines).toBeUndefined();
  });

  it("keeps todoread and todowrite prompt guidance populated", () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);

    expect(tools.get("todoread")!.promptGuidelines.length).toBeGreaterThan(0);
    expect(tools.get("todowrite")!.promptGuidelines.length).toBeGreaterThan(0);
  });

  it("exposes expected parameters on harness_milestone", () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);

    const schema = tools.get("harness_milestone")!.parameters;
    expect(schema.properties.runId).toBeDefined();
    expect(schema.properties.action).toBeDefined();
    expect(schema.properties.action.enum).toEqual([
      "create", "update", "set_status", "load", "render",
    ]);
    expect(schema.properties.status?.enum).toContain("completed");
  });

  it("exposes expected parameters on harness_plan", () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);

    const schema = tools.get("harness_plan")!.parameters;
    expect(schema.properties.runId).toBeDefined();
    expect(schema.properties.action.enum).toEqual([
      "attach", "define_tasks", "set_task_status", "load", "render",
    ]);
    expect(schema.properties.tasks).toBeDefined();
  });

  it("exposes expected parameters on harness_todo", () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);

    const schema = tools.get("harness_todo")!.parameters;
    expect(schema.properties.runId).toBeDefined();
    expect(schema.properties.action.enum).toEqual([
      "set", "update_status", "clear", "load", "render",
    ]);
    expect(schema.properties.ownerType?.enum).toContain("plan_task");
  });

  it("exposes expected parameters on todowrite and todoread", () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);

    const readSchema = tools.get("todoread")!.parameters;
    expect(readSchema.properties).toEqual({});

    const writeSchema = tools.get("todowrite")!.parameters;
    expect(writeSchema.properties.todos).toBeDefined();
    expect(writeSchema.properties.todos.items.properties.content).toBeDefined();
    expect(writeSchema.properties.todos.items.properties.status).toBeDefined();
    expect(writeSchema.properties.todos.items.properties.priority).toBeDefined();
    // No id, no runId — senpi-style simple todos
    expect(writeSchema.properties.runId).toBeUndefined();
    expect(writeSchema.properties.todos.items.properties.id).toBeUndefined();
  });
});

describe("todowrite and todoread execute", () => {
  it("todoread returns empty list initially", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const ctx = createMockCtx();

    const result = await tools.get("todoread")!.execute(
      "tc-1",
      {},
      undefined,
      undefined,
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(result.details.todos).toEqual([]);
  });

  it("todowrite stores and todoread returns the same todos", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const ctx = createMockCtx();

    const todos = [
      { content: "src/utils.ts: Add validateEmail() - returns boolean", status: "in_progress", priority: "high" },
      { content: "src/index.ts: Call validateEmail() before insert - rejects invalid", status: "pending", priority: "medium" },
    ];

    const writeResult = await tools.get("todowrite")!.execute(
      "tc-1",
      { todos },
      undefined,
      undefined,
      ctx,
    );

    expect(writeResult.isError).toBeFalsy();
    expect(writeResult.details.todos).toHaveLength(2);
    expect(writeResult.details.todos[0].content).toBe("src/utils.ts: Add validateEmail() - returns boolean");

    const readResult = await tools.get("todoread")!.execute(
      "tc-2",
      {},
      undefined,
      undefined,
      ctx,
    );

    expect(readResult.isError).toBeFalsy();
    expect(readResult.details.todos).toHaveLength(2);
    expect(readResult.details.todos[1].status).toBe("pending");
  });

  it("todowrite marks completed immediately", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const ctx = createMockCtx();

    await tools.get("todowrite")!.execute(
      "tc-1",
      { todos: [{ content: "Task 1", status: "in_progress", priority: "high" }] },
      undefined,
      undefined,
      ctx,
    );

    const result = await tools.get("todowrite")!.execute(
      "tc-2",
      { todos: [{ content: "Task 1", status: "completed", priority: "high" }] },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details.todos[0].status).toBe("completed");
  });
});

describe("harness_milestone execute", () => {
  it("creates a milestone and persists state", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const customEntries: Array<{ type: string; data: unknown }> = [];
    const tool = tools.get("harness_milestone")!;

    const result = await tool.execute(
      "tc-1",
      { runId: "run-1", action: "create", id: "M1", name: "Milestone 1", rootDir },
      undefined,
      undefined,
      createMockCtx({ customEntries }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Milestone created: M1");
    expect(result.details.total).toBe(1);

    // Verify snapshot was written
    const snapshot = await readHarnessStateSnapshot(join(rootDir, "run-1", "state.json"));
    expect(snapshot?.state.milestones[0]?.id).toBe("M1");
    expect(snapshot?.state.milestones[0]?.status).toBe("pending");

    // Verify replay event was emitted
    expect(customEntries.length).toBe(1);
    expect(customEntries[0].type).toBe(HARNESS_STATE_EVENT_CUSTOM_TYPE);
    expect((customEntries[0].data as any).command.type).toBe("upsert_milestone");
    expect((customEntries[0].data as any).rootDir).toBe(rootDir);
  });

  it("creates a milestone with explicit status and dependencies", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_milestone")!;

    const result = await tool.execute(
      "tc-1",
      {
        runId: "run-1",
        action: "create",
        id: "M2",
        name: "Milestone 2",
        status: "executing",
        dependencies: ["M1"],
        attempts: 2,
        planFile: "docs/plan.md",
        reviewFile: "docs/review.md",
        rootDir,
      },
      undefined,
      undefined,
      createMockCtx(),
    );

    expect(result.details.items[0]).toMatchObject({
      id: "M2",
      status: "executing",
      dependencies: ["M1"],
      attempts: 2,
      planFile: "docs/plan.md",
      reviewFile: "docs/review.md",
    });
  });

  it("auto-generates id from name when id is omitted", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_milestone")!;

    const result = await tool.execute(
      "tc-1",
      { runId: "run-1", action: "create", name: "My Milestone", rootDir },
      undefined,
      undefined,
      createMockCtx(),
    );

    expect(result.details.items[0]?.id).toBe("my-milestone");
  });

  it("serializes concurrent mutations for the same run", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_milestone")!;
    const ctx = createMockCtx();

    await Promise.all(Array.from({ length: 8 }, (_, index) => tool.execute(
      `tc-${index + 1}`,
      {
        runId: "run-1",
        action: "create",
        id: `M${index + 1}`,
        name: `Milestone ${index + 1}`,
        status: "completed",
        rootDir,
      },
      undefined,
      undefined,
      ctx,
    )));

    const snapshot = await readHarnessStateSnapshot(join(rootDir, "run-1", "state.json"));
    expect(snapshot?.state.milestones).toHaveLength(8);
    expect(snapshot?.state.milestones.map((milestone) => milestone.id).sort()).toEqual([
      "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8",
    ]);
  });

  it("updates a milestone merging fields", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_milestone")!;
    const ctx = createMockCtx();

    // Create first
    await tool.execute(
      "tc-1",
      { runId: "run-1", action: "create", id: "M1", name: "Milestone 1", rootDir },
      undefined,
      undefined,
      ctx,
    );

    // Update
    const result = await tool.execute(
      "tc-2",
      { runId: "run-1", action: "update", id: "M1", status: "executing", attempts: 1, rootDir },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details.items[0]?.status).toBe("executing");
    expect(result.details.items[0]?.attempts).toBe(1);
    expect(result.details.items[0]?.name).toBe("Milestone 1"); // preserved
  });

  it("returns error when updating non-existent milestone", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_milestone")!;

    const result = await tool.execute(
      "tc-1",
      { runId: "run-1", action: "update", id: "M99", name: "X", rootDir },
      undefined,
      undefined,
      createMockCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("M99 not found");
  });

  it("sets milestone status", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_milestone")!;
    const ctx = createMockCtx();

    await tool.execute(
      "tc-1",
      { runId: "run-1", action: "create", id: "M1", name: "M1", rootDir },
      undefined,
      undefined,
      ctx,
    );

    const result = await tool.execute(
      "tc-2",
      { runId: "run-1", action: "set_status", id: "M1", status: "completed", rootDir },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details.items[0]?.status).toBe("completed");
  });

  it("returns error for missing required fields", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_milestone")!;

    const createResult = await tool.execute(
      "tc-1",
      { runId: "run-1", action: "create", rootDir },
      undefined,
      undefined,
      createMockCtx(),
    );
    expect(createResult.isError).toBe(true);
    expect(createResult.content[0].text).toContain("name is required");

    const statusResult = await tool.execute(
      "tc-2",
      { runId: "run-1", action: "set_status", id: "M1", rootDir },
      undefined,
      undefined,
      createMockCtx(),
    );
    expect(statusResult.isError).toBe(true);
    expect(statusResult.content[0].text).toContain("status is required");
  });

  it("load returns milestone summary JSON", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_milestone")!;

    await tool.execute(
      "tc-1",
      { runId: "run-1", action: "create", id: "M1", name: "M1", status: "completed", rootDir },
      undefined,
      undefined,
      createMockCtx(),
    );

    const result = await tool.execute(
      "tc-2",
      { runId: "run-1", action: "load", rootDir },
      undefined,
      undefined,
      createMockCtx(),
    );

    expect(result.details.completed).toBe(1);
    expect(result.content[0].text).toContain("M1");
  });

  it("render returns markdown", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_milestone")!;

    await tool.execute(
      "tc-1",
      { runId: "run-1", action: "create", id: "M1", name: "Milestone One", rootDir },
      undefined,
      undefined,
      createMockCtx(),
    );

    const result = await tool.execute(
      "tc-2",
      { runId: "run-1", action: "render", rootDir },
      undefined,
      undefined,
      createMockCtx(),
    );

    expect(result.content[0].text).toContain("# run-1");
    expect(result.content[0].text).toContain("Milestone One");
  });
});

describe("harness_plan execute", () => {
  it("attaches a plan and defines tasks", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_plan")!;
    const ctx = createMockCtx();

    // Need a milestone first
    const milestoneTool = tools.get("harness_milestone")!;
    await milestoneTool.execute(
      "tc-0",
      { runId: "run-1", action: "create", id: "M1", name: "M1", rootDir },
      undefined,
      undefined,
      ctx,
    );

    const attachResult = await tool.execute(
      "tc-1",
      {
        runId: "run-1",
        action: "attach",
        planId: "plan-1",
        milestoneId: "M1",
        title: "Plan 1",
        goal: "Ship it",
        rootDir,
      },
      undefined,
      undefined,
      ctx,
    );

    expect(attachResult.isError).toBeFalsy();
    expect(attachResult.content[0].text).toContain("Plan attached: plan-1");
    expect(attachResult.details.plan?.id).toBe("plan-1");

    const tasksResult = await tool.execute(
      "tc-2",
      {
        runId: "run-1",
        action: "define_tasks",
        planId: "plan-1",
        tasks: [
          { id: 1, name: "Task 1", files: ["file.ts"], testCommands: ["npm test"], acceptanceCriteria: ["passes"] },
          { id: 2, name: "Task 2", dependencies: [1] },
        ],
        rootDir,
      },
      undefined,
      undefined,
      ctx,
    );

    expect(tasksResult.details.total).toBe(2);
    expect(tasksResult.details.items[0]?.files).toEqual(["file.ts"]);
  });

  it("sets task status", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_plan")!;
    const ctx = createMockCtx();

    const milestoneTool = tools.get("harness_milestone")!;
    await milestoneTool.execute(
      "tc-0",
      { runId: "run-1", action: "create", id: "M1", name: "M1", rootDir },
      undefined,
      undefined,
      ctx,
    );

    await tool.execute(
      "tc-1",
      { runId: "run-1", action: "attach", planId: "plan-1", milestoneId: "M1", title: "P", goal: "G", rootDir },
      undefined,
      undefined,
      ctx,
    );

    await tool.execute(
      "tc-2",
      { runId: "run-1", action: "define_tasks", planId: "plan-1", tasks: [{ id: 1, name: "T1" }], rootDir },
      undefined,
      undefined,
      ctx,
    );

    const result = await tool.execute(
      "tc-3",
      { runId: "run-1", action: "set_task_status", planId: "plan-1", taskId: 1, status: "completed", rootDir },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details.completed).toBe(1);
    expect(result.content[0].text).toContain("completed");
  });

  it("returns error for missing planId", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_plan")!;

    const result = await tool.execute(
      "tc-1",
      { runId: "run-1", action: "attach", milestoneId: "M1", title: "P", goal: "G", rootDir },
      undefined,
      undefined,
      createMockCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("id or planId is required");
  });

  it("returns error for set_task_status on missing plan", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_plan")!;

    const result = await tool.execute(
      "tc-1",
      { runId: "run-1", action: "set_task_status", planId: "missing", taskId: 1, status: "completed", rootDir },
      undefined,
      undefined,
      createMockCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("missing");
  });

  it("render returns plan markdown", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_plan")!;
    const ctx = createMockCtx();

    const milestoneTool = tools.get("harness_milestone")!;
    await milestoneTool.execute(
      "tc-0",
      { runId: "run-1", action: "create", id: "M1", name: "M1", rootDir },
      undefined,
      undefined,
      ctx,
    );

    await tool.execute(
      "tc-1",
      { runId: "run-1", action: "attach", planId: "plan-1", milestoneId: "M1", title: "Plan 1", goal: "G", rootDir },
      undefined,
      undefined,
      ctx,
    );

    await tool.execute(
      "tc-2",
      { runId: "run-1", action: "define_tasks", planId: "plan-1", tasks: [{ id: 1, name: "Task One" }], rootDir },
      undefined,
      undefined,
      ctx,
    );

    const result = await tool.execute(
      "tc-3",
      { runId: "run-1", action: "render", planId: "plan-1", rootDir },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toContain("# Plan 1");
    expect(result.content[0].text).toContain("Task One");
  });
});

describe("harness_todo execute", () => {
  it("sets todos for an owner", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_todo")!;
    const ctx = createMockCtx();

    const result = await tool.execute(
      "tc-1",
      {
        runId: "run-1",
        action: "set",
        ownerType: "milestone",
        ownerId: "M1",
        todos: [
          { id: "todo-1", text: "First" },
          { id: "todo-2", text: "Second", status: "completed" },
        ],
        rootDir,
      },
      undefined,
      undefined,
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(result.details).toHaveLength(2);
    expect(result.details[0].status).toBe("pending");
    expect(result.details[1].status).toBe("completed");
  });

  it("updates todo status", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_todo")!;
    const ctx = createMockCtx();

    await tool.execute(
      "tc-1",
      {
        runId: "run-1",
        action: "set",
        ownerType: "plan",
        ownerId: "plan-1",
        todos: [{ id: "todo-1", text: "Do it" }],
        rootDir,
      },
      undefined,
      undefined,
      ctx,
    );

    const result = await tool.execute(
      "tc-2",
      { runId: "run-1", action: "update_status", todoId: "todo-1", status: "completed", rootDir },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details.status).toBe("completed");
  });

  it("clears todos for an owner", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_todo")!;
    const ctx = createMockCtx();

    await tool.execute(
      "tc-1",
      {
        runId: "run-1",
        action: "set",
        ownerType: "milestone",
        ownerId: "M1",
        todos: [{ id: "todo-1", text: "Do it" }],
        rootDir,
      },
      undefined,
      undefined,
      ctx,
    );

    const result = await tool.execute(
      "tc-2",
      { runId: "run-1", action: "clear", ownerType: "milestone", ownerId: "M1", rootDir },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details).toEqual([]);

    // Verify snapshot
    const snapshot = await readHarnessStateSnapshot(join(rootDir, "run-1", "state.json"));
    expect(snapshot?.state.todos).toHaveLength(0);
  });

  it("returns error for missing todoId on update_status", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_todo")!;

    const result = await tool.execute(
      "tc-1",
      { runId: "run-1", action: "update_status", status: "completed", rootDir },
      undefined,
      undefined,
      createMockCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("todoId is required");
  });

  it("returns error for missing owner on set", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_todo")!;

    const result = await tool.execute(
      "tc-1",
      { runId: "run-1", action: "set", todos: [{ id: "t1", text: "X" }], rootDir },
      undefined,
      undefined,
      createMockCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ownerType is required");
  });

  it("render returns todo markdown", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_todo")!;
    const ctx = createMockCtx();

    await tool.execute(
      "tc-1",
      {
        runId: "run-1",
        action: "set",
        ownerType: "milestone",
        ownerId: "M1",
        todos: [
          { id: "todo-1", text: "First", status: "completed" },
          { id: "todo-2", text: "Second" },
        ],
        rootDir,
      },
      undefined,
      undefined,
      ctx,
    );

    const result = await tool.execute(
      "tc-2",
      { runId: "run-1", action: "render", ownerType: "milestone", ownerId: "M1", rootDir },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toContain("# Todos for milestone M1");
    expect(result.content[0].text).toContain("[x] First");
    expect(result.content[0].text).toContain("[ ] Second");
  });
});

describe("harness-tools persistence integration", () => {
  it("auto-creates state when snapshot is missing on first write", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const tool = tools.get("harness_milestone")!;

    const result = await tool.execute(
      "tc-1",
      { runId: "new-run", action: "create", id: "M1", name: "First", rootDir },
      undefined,
      undefined,
      createMockCtx(),
    );

    expect(result.isError).toBeFalsy();
    const snapshot = await readHarnessStateSnapshot(join(rootDir, "new-run", "state.json"));
    expect(snapshot?.state.title).toBe("new-run");
    expect(snapshot?.state.runId).toBe("new-run");
  });

  it("emits replay events for every write action", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const customEntries: Array<{ type: string; data: unknown }> = [];
    const ctx = createMockCtx({ customEntries });

    const milestoneTool = tools.get("harness_milestone")!;
    const planTool = tools.get("harness_plan")!;
    const todoTool = tools.get("harness_todo")!;

    await milestoneTool.execute(
      "tc-1",
      { runId: "run-1", action: "create", id: "M1", name: "M1", rootDir },
      undefined,
      undefined,
      ctx,
    );

    await planTool.execute(
      "tc-2",
      { runId: "run-1", action: "attach", planId: "p1", milestoneId: "M1", title: "P", goal: "G", rootDir },
      undefined,
      undefined,
      ctx,
    );

    await todoTool.execute(
      "tc-3",
      { runId: "run-1", action: "set", ownerType: "milestone", ownerId: "M1", todos: [{ id: "t1", text: "X" }], rootDir },
      undefined,
      undefined,
      ctx,
    );

    expect(customEntries.length).toBe(3);
    expect(customEntries.every((e) => e.type === HARNESS_STATE_EVENT_CUSTOM_TYPE)).toBe(true);
    expect((customEntries[0].data as any).seq).toBe(1);
    expect((customEntries[1].data as any).seq).toBe(2);
    expect((customEntries[2].data as any).seq).toBe(3);
  });

  it("load actions do not emit replay events or mutate snapshot", async () => {
    const { mockPi, tools } = createMockPi();
    registerHarnessTools(mockPi as any);
    const rootDir = await makeTempDir();
    const customEntries: Array<{ type: string; data: unknown }> = [];
    const ctx = createMockCtx({ customEntries });
    const tool = tools.get("harness_milestone")!;

    await tool.execute(
      "tc-1",
      { runId: "run-1", action: "create", id: "M1", name: "M1", rootDir },
      undefined,
      undefined,
      ctx,
    );

    customEntries.length = 0; // reset

    await tool.execute(
      "tc-2",
      { runId: "run-1", action: "load", rootDir },
      undefined,
      undefined,
      ctx,
    );

    expect(customEntries.length).toBe(0);
  });
});
