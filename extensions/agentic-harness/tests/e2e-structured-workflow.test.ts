import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyHarnessCommand,
  createHarnessState,
  selectMilestoneSummary,
  selectPlanSummary,
  selectTodosForOwner,
} from "../harness-state.js";
import {
  createHarnessReplayEvent,
  replayHarnessEvents,
  HARNESS_STATE_EVENT_CUSTOM_TYPE,
} from "../harness-events.js";
import {
  createHarnessStateSnapshot,
  harnessStateSnapshotPath,
  readHarnessStateSnapshot,
  writeHarnessStateSnapshot,
} from "../harness-storage.js";
import {
  renderHarnessStateMarkdown,
  renderHarnessPlanMarkdown,
  renderHarnessTodoMarkdown,
} from "../harness-render.js";
import { HarnessProgressProvider } from "../harness-progress.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "e2e-structured-"));
  tempDirs.push(dir);
  return dir;
}

function stubTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
}

describe("end-to-end structured workflow", () => {
  it("full lifecycle: create → persist → replay → restore → render → update", async () => {
    const rootDir = await makeTempDir();
    const runId = "e2e-run";

    // 1. Create initial state
    let state = createHarnessState({ runId, title: "E2E Test Run", now: "2026-05-06T00:00:00.000Z" });

    // 2. Add milestones
    state = applyHarnessCommand(state, {
      type: "upsert_milestone",
      milestone: { id: "M1", name: "Setup", status: "completed", dependencies: [] },
    }, { now: "2026-05-06T00:01:00.000Z" }).state;
    state = applyHarnessCommand(state, {
      type: "upsert_milestone",
      milestone: { id: "M2", name: "Build", status: "executing", dependencies: ["M1"] },
    }, { now: "2026-05-06T00:02:00.000Z" }).state;

    // 3. Attach plan and define tasks
    state = applyHarnessCommand(state, {
      type: "attach_plan",
      plan: { id: "plan-1", milestoneId: "M2", title: "Build Plan", goal: "Build the feature" },
    }, { now: "2026-05-06T00:03:00.000Z" }).state;
    state = applyHarnessCommand(state, {
      type: "define_plan_tasks",
      planId: "plan-1",
      tasks: [
        { id: 1, name: "Write code", files: ["src/feature.ts"], testCommands: ["npm test"], acceptanceCriteria: ["passes"] },
        { id: 2, name: "Write tests", files: ["tests/feature.test.ts"], dependencies: [1] },
      ],
    }, { now: "2026-05-06T00:04:00.000Z" }).state;

    // 4. Set todos
    state = applyHarnessCommand(state, {
      type: "set_todos",
      ownerType: "milestone",
      ownerId: "M2",
      todos: [
        { id: "todo-1", text: "Review PR", status: "completed" },
        { id: "todo-2", text: "Merge" },
      ],
    }, { now: "2026-05-06T00:05:00.000Z" }).state;

    // 5. Persist snapshot
    const snapshot = createHarnessStateSnapshot(state);
    await writeHarnessStateSnapshot(harnessStateSnapshotPath(rootDir, runId), snapshot);

    // 6. Create replay events (simulating tool calls after snapshot)
    const event1 = createHarnessReplayEvent(state, {
      type: "set_plan_task_status",
      planId: "plan-1",
      taskId: 1,
      status: "completed",
      completedAt: "2026-05-06T00:06:00.000Z",
    });
    const event2 = createHarnessReplayEvent(
      applyHarnessCommand(state, event1.command, { now: event1.at }).state,
      {
        type: "set_milestone_status",
        id: "M2",
        status: "validating",
      },
    );

    // 7. Restore from snapshot + events
    const restoredSnapshot = await readHarnessStateSnapshot(harnessStateSnapshotPath(rootDir, runId));
    expect(restoredSnapshot).not.toBeNull();
    const restored = replayHarnessEvents(restoredSnapshot!.state, [event1, event2]);

    // 8. Verify milestone statuses
    const milestoneSummary = selectMilestoneSummary(restored);
    expect(milestoneSummary.total).toBe(2);
    expect(milestoneSummary.items[0].status).toBe("completed"); // M1
    expect(milestoneSummary.items[1].status).toBe("validating"); // M2 (updated by event2)

    // 9. Verify plan task statuses
    const planSummary = selectPlanSummary(restored, "plan-1");
    expect(planSummary.total).toBe(2);
    expect(planSummary.completed).toBe(1); // Task 1 completed by event1
    expect(planSummary.pending).toBe(1); // Task 2 still pending

    // 10. Verify todos
    const todos = selectTodosForOwner(restored, "milestone", "M2");
    expect(todos).toHaveLength(2);
    expect(todos[0].status).toBe("completed");
    expect(todos[1].status).toBe("pending");

    // 11. Render and verify output
    const milestoneRender = renderHarnessStateMarkdown(restored);
    expect(milestoneRender).toContain("M1");
    expect(milestoneRender).toContain("M2");
    expect(milestoneRender).toContain("completed");
    expect(milestoneRender).toContain("validating");

    const planRender = renderHarnessPlanMarkdown(restored, "plan-1");
    expect(planRender).toContain("Build Plan");
    expect(planRender).toContain("Write code");
    expect(planRender).toContain("Write tests");

    const todoRender = renderHarnessTodoMarkdown(restored, "milestone", "M2");
    expect(todoRender).toContain("[x] Review PR");
    expect(todoRender).toContain("[ ] Merge");
  });

  it("HarnessProgressProvider loads from snapshot and renders correctly", async () => {
    const rootDir = await makeTempDir();
    const runId = "provider-run";

    let state = createHarnessState({ runId, title: "Provider Test" });
    state = applyHarnessCommand(state, {
      type: "upsert_milestone",
      milestone: { id: "M1", name: "Milestone 1", status: "executing" },
    }).state;
    state = applyHarnessCommand(state, {
      type: "attach_plan",
      plan: { id: "plan-1", milestoneId: "M1", title: "Plan 1", goal: "Do the thing" },
    }).state;
    state = applyHarnessCommand(state, {
      type: "define_plan_tasks",
      planId: "plan-1",
      tasks: [
        { id: 1, name: "Task A", status: "completed" },
        { id: 2, name: "Task B", status: "running" },
      ],
    }).state;

    await writeHarnessStateSnapshot(
      harnessStateSnapshotPath(rootDir, runId),
      createHarnessStateSnapshot(state),
    );

    const provider = new HarnessProgressProvider({ runId, rootDir });
    await new Promise((r) => setTimeout(r, 50));

    expect(provider.hasState()).toBe(true);
    expect(provider.hasRunningTasks()).toBe(true);
    expect(provider.getProgress()).toMatchObject({ completed: 1, total: 2, running: 1 });

    const milestoneLines = provider.renderMilestones(stubTheme(), 80);
    expect(milestoneLines.join("\n")).toContain("M1");

    const planLines = provider.renderPlan(stubTheme(), 80);
    expect(planLines.join("\n")).toContain("Task A");
    expect(planLines.join("\n")).toContain("Task B");
  });

  it("structured state updates via applyAndPersist pattern", async () => {
    const rootDir = await makeTempDir();
    const runId = "update-run";

    let state = createHarnessState({ runId, title: "Update Test" });
    state = applyHarnessCommand(state, {
      type: "upsert_milestone",
      milestone: { id: "M1", name: "M1", status: "pending" },
    }).state;

    await writeHarnessStateSnapshot(
      harnessStateSnapshotPath(rootDir, runId),
      createHarnessStateSnapshot(state),
    );

    // Simulate what harness_milestone set_status does internally
    const snapshot = await readHarnessStateSnapshot(harnessStateSnapshotPath(rootDir, runId));
    const loaded = snapshot!.state;
    const result = applyHarnessCommand(loaded, {
      type: "set_milestone_status",
      id: "M1",
      status: "completed",
    });
    await writeHarnessStateSnapshot(
      harnessStateSnapshotPath(rootDir, runId),
      createHarnessStateSnapshot(result.state),
    );

    // Verify
    const finalSnapshot = await readHarnessStateSnapshot(harnessStateSnapshotPath(rootDir, runId));
    expect(finalSnapshot!.state.milestones[0].status).toBe("completed");
  });
});
