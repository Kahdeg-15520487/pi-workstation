import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessProgressProvider } from "../harness-progress.js";
import {
  applyHarnessCommand,
  createHarnessState,
} from "../harness-state.js";
import {
  createHarnessStateSnapshot,
  harnessStateSnapshotPath,
  writeHarnessStateSnapshot,
} from "../harness-storage.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-progress-"));
  tempDirs.push(dir);
  return dir;
}

function stubTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
}

async function seedState(rootDir: string, runId: string) {
  let state = createHarnessState({ runId, title: "Test Run", now: "2026-05-06T00:00:00.000Z" });
  state = applyHarnessCommand(state, {
    type: "upsert_milestone",
    milestone: { id: "M1", name: "Milestone 1", dependencies: [], status: "executing" },
  }, { now: "2026-05-06T00:01:00.000Z" }).state;
  state = applyHarnessCommand(state, {
    type: "attach_plan",
    plan: { id: "plan-1", milestoneId: "M1", title: "Plan 1", goal: "Build the thing" },
  }, { now: "2026-05-06T00:02:00.000Z" }).state;
  state = applyHarnessCommand(state, {
    type: "define_plan_tasks",
    planId: "plan-1",
    tasks: [
      { id: 1, name: "Task 1", status: "completed" },
      { id: 2, name: "Task 2", status: "running" },
      { id: 3, name: "Task 3", status: "pending" },
    ],
  }, { now: "2026-05-06T00:03:00.000Z" }).state;
  state = applyHarnessCommand(state, {
    type: "set_todos",
    ownerType: "milestone",
    ownerId: "M1",
    todos: [
      { id: "todo-1", text: "First", status: "completed" },
      { id: "todo-2", text: "Second" },
    ],
  }, { now: "2026-05-06T00:04:00.000Z" }).state;

  const snapshot = createHarnessStateSnapshot(state);
  const path = harnessStateSnapshotPath(rootDir, runId);
  await writeHarnessStateSnapshot(path, snapshot);
}

describe("HarnessProgressProvider", () => {
  it("has no state initially", () => {
    const provider = new HarnessProgressProvider();
    expect(provider.hasState()).toBe(false);
  });

  it("loads state after setRunId", async () => {
    const rootDir = await makeTempDir();
    await seedState(rootDir, "run-1");
    const provider = new HarnessProgressProvider({ rootDir });

    provider.setRunId("run-1");
    // setRunId triggers invalidate which is async
    await new Promise((r) => setTimeout(r, 50));

    expect(provider.hasState()).toBe(true);
  });

  it("renders milestones with progress", async () => {
    const rootDir = await makeTempDir();
    await seedState(rootDir, "run-1");
    const provider = new HarnessProgressProvider({ runId: "run-1", rootDir });
    await new Promise((r) => setTimeout(r, 50));

    const lines = provider.renderMilestones(stubTheme(), 80);
    expect(lines.length).toBeGreaterThan(0);
    const text = lines.join("\n");
    expect(text).toContain("M1");
    expect(text).toContain("0/1");
  });

  it("renders plan with tasks", async () => {
    const rootDir = await makeTempDir();
    await seedState(rootDir, "run-1");
    const provider = new HarnessProgressProvider({ runId: "run-1", rootDir });
    await new Promise((r) => setTimeout(r, 50));

    const lines = provider.renderPlan(stubTheme(), 80);
    expect(lines.length).toBeGreaterThan(0);
    const text = lines.join("\n");
    expect(text).toContain("Build the thing");
    expect(text).toContain("Task 1");
    expect(text).toContain("Task 2");
  });

  it("detects running tasks", async () => {
    const rootDir = await makeTempDir();
    await seedState(rootDir, "run-1");
    const provider = new HarnessProgressProvider({ runId: "run-1", rootDir });
    await new Promise((r) => setTimeout(r, 50));

    expect(provider.hasRunningTasks()).toBe(true);
  });

  it("returns correct progress counts", async () => {
    const rootDir = await makeTempDir();
    await seedState(rootDir, "run-1");
    const provider = new HarnessProgressProvider({ runId: "run-1", rootDir });
    await new Promise((r) => setTimeout(r, 50));

    expect(provider.getProgress()).toMatchObject({
      completed: 1,
      total: 3,
      running: 1,
      pending: 1,
      failed: 0,
    });
  });

  it("switches run roots when setRun changes rootDir", async () => {
    const firstRoot = await makeTempDir();
    const secondRoot = await makeTempDir();
    await seedState(firstRoot, "run-1");
    await seedState(secondRoot, "run-2");
    const provider = new HarnessProgressProvider({ runId: "run-1", rootDir: firstRoot });
    await new Promise((r) => setTimeout(r, 50));

    provider.setRun("run-2", secondRoot);
    await new Promise((r) => setTimeout(r, 50));

    const lines = provider.renderPlan(stubTheme(), 80).join("\n");
    expect(provider.getRunIdentity()).toEqual({ runId: "run-2", rootDir: secondRoot });
    expect(lines).toContain("Build the thing");
  });

  it("hydrates state without waiting for snapshot reload", async () => {
    const rootDir = await makeTempDir();
    let state = createHarnessState({ runId: "hydrated-run", title: "Hydrated" });
    state = applyHarnessCommand(state, {
      type: "upsert_milestone",
      milestone: { id: "M1", name: "Milestone", status: "executing" },
    }).state;
    state = applyHarnessCommand(state, {
      type: "attach_plan",
      plan: { id: "plan-1", milestoneId: "M1", title: "Hydrated Plan", goal: "Hydrate now" },
    }).state;
    state = applyHarnessCommand(state, {
      type: "define_plan_tasks",
      planId: "plan-1",
      tasks: [{ id: 1, name: "Hydrated Task", status: "running" }],
    }).state;
    const provider = new HarnessProgressProvider({ rootDir });

    provider.hydrate(state, rootDir);

    expect(provider.hasState()).toBe(true);
    expect(provider.renderPlan(stubTheme(), 80).join("\n")).toContain("Hydrated Task");
  });

  it("notifies change listeners on invalidate", async () => {
    const rootDir = await makeTempDir();
    await seedState(rootDir, "run-1");
    const provider = new HarnessProgressProvider({ rootDir });

    let called = false;
    const unsub = provider.subscribeOnChange(() => {
      called = true;
    });

    provider.setRunId("run-1");
    await new Promise((r) => setTimeout(r, 50));

    expect(called).toBe(true);
    unsub();
  });

  it("returns empty arrays when no state", () => {
    const provider = new HarnessProgressProvider();
    expect(provider.renderMilestones(stubTheme(), 80)).toEqual([]);
    expect(provider.renderPlan(stubTheme(), 80)).toEqual([]);
    expect(provider.hasRunningTasks()).toBe(false);
  });
});
