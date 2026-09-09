import { describe, expect, it } from "vitest";
import {
  applyHarnessCommand,
  createHarnessState,
  HARNESS_STATE_SCHEMA_VERSION,
  selectActiveMilestone,
  selectActivePlan,
  selectMilestoneSummary,
  selectPlanSummary,
  selectTodosForOwner,
} from "../harness-state.js";

const START = "2026-05-06T00:00:00.000Z";
const NEXT = "2026-05-06T00:01:00.000Z";

function stateWithMilestone() {
  return applyHarnessCommand(createHarnessState({ runId: "run-1", title: "Run 1", now: START }), {
    type: "upsert_milestone",
    milestone: { id: "M1", name: "Milestone 1", dependencies: [] },
  }, { now: NEXT }).state;
}

function stateWithPlanAndTasks() {
  let state = stateWithMilestone();
  state = applyHarnessCommand(state, {
    type: "attach_plan",
    plan: {
      id: "plan-1",
      milestoneId: "M1",
      title: "Plan 1",
      goal: "Build the thing",
      planFile: "docs/plan.md",
    },
  }, { now: "2026-05-06T00:02:00.000Z" }).state;
  state = applyHarnessCommand(state, {
    type: "define_plan_tasks",
    planId: "plan-1",
    tasks: [
      {
        id: 1,
        name: "Task 1",
        dependencies: [],
        files: ["file-a.ts"],
        testCommands: ["npm test"],
        acceptanceCriteria: ["passes"],
      },
      {
        id: 2,
        name: "Task 2",
        dependencies: [1],
        files: ["file-b.ts"],
        testCommands: [],
        acceptanceCriteria: ["done"],
      },
    ],
  }, { now: "2026-05-06T00:03:00.000Z" }).state;
  return state;
}

describe("harness-state", () => {
  it("initializes a harness state", () => {
    const state = createHarnessState({ runId: "run-1", title: "Run 1", now: START });

    expect(state).toMatchObject({
      schemaVersion: HARNESS_STATE_SCHEMA_VERSION,
      runId: "run-1",
      title: "Run 1",
      milestones: [],
      plans: [],
      todos: [],
      eventSeq: 0,
      createdAt: START,
      updatedAt: START,
    });
  });

  it("adds a milestone and increments eventSeq", () => {
    const state = createHarnessState({ runId: "run-1", title: "Run 1", now: START });
    const result = applyHarnessCommand(state, {
      type: "upsert_milestone",
      milestone: { id: "M1", name: "Milestone 1", dependencies: ["M0"] },
    }, { now: NEXT });

    expect(result.state.eventSeq).toBe(1);
    expect(result.event).toMatchObject({ seq: 1, type: "upsert_milestone", at: NEXT });
    expect(result.state.milestones).toEqual([
      {
        id: "M1",
        name: "Milestone 1",
        status: "pending",
        dependencies: ["M0"],
        attempts: 0,
        planFile: undefined,
        reviewFile: undefined,
        createdAt: NEXT,
        updatedAt: NEXT,
      },
    ]);
  });

  it("updates a repeated milestone upsert without duplicating it", () => {
    let state = stateWithMilestone();
    state = applyHarnessCommand(state, {
      type: "set_milestone_status",
      id: "M1",
      status: "executing",
    }, { now: "2026-05-06T00:02:00.000Z" }).state;

    const result = applyHarnessCommand(state, {
      type: "upsert_milestone",
      milestone: { id: "M1", name: "Milestone One", dependencies: ["M0"] },
    }, { now: "2026-05-06T00:03:00.000Z" });

    expect(result.state.milestones).toHaveLength(1);
    expect(result.state.milestones[0]).toMatchObject({
      id: "M1",
      name: "Milestone One",
      dependencies: ["M0"],
      status: "executing",
      attempts: 0,
    });
  });

  it("sets milestone status and throws for a missing milestone", () => {
    const state = stateWithMilestone();
    const result = applyHarnessCommand(state, {
      type: "set_milestone_status",
      id: "M1",
      status: "completed",
    }, { now: "2026-05-06T00:02:00.000Z" });

    expect(result.state.milestones[0].status).toBe("completed");
    expect(() => applyHarnessCommand(state, {
      type: "set_milestone_status",
      id: "M2",
      status: "completed",
    }, { now: "2026-05-06T00:02:00.000Z" })).toThrow(/M2/);
  });

  it("attaches a plan and defines plan tasks", () => {
    const state = stateWithPlanAndTasks();

    expect(state.plans).toHaveLength(1);
    expect(state.plans[0]).toMatchObject({
      id: "plan-1",
      milestoneId: "M1",
      title: "Plan 1",
      goal: "Build the thing",
      planFile: "docs/plan.md",
    });
    expect(state.plans[0].tasks).toEqual([
      {
        id: 1,
        name: "Task 1",
        status: "pending",
        dependencies: [],
        files: ["file-a.ts"],
        testCommands: ["npm test"],
        acceptanceCriteria: ["passes"],
        startedAt: undefined,
        completedAt: undefined,
      },
      {
        id: 2,
        name: "Task 2",
        status: "pending",
        dependencies: [1],
        files: ["file-b.ts"],
        testCommands: [],
        acceptanceCriteria: ["done"],
        startedAt: undefined,
        completedAt: undefined,
      },
    ]);
  });

  it("preserves matching task status when tasks are redefined", () => {
    let state = stateWithPlanAndTasks();
    state = applyHarnessCommand(state, {
      type: "set_plan_task_status",
      planId: "plan-1",
      taskId: 1,
      status: "completed",
    }, { now: "2026-05-06T00:04:00.000Z" }).state;

    const result = applyHarnessCommand(state, {
      type: "define_plan_tasks",
      planId: "plan-1",
      tasks: [
        { id: 1, name: "Task One", files: ["file-a.ts"] },
        { id: 3, name: "Task 3", files: ["file-c.ts"] },
      ],
    }, { now: "2026-05-06T00:05:00.000Z" });

    expect(result.state.plans[0].tasks.map((task) => ({ id: task.id, status: task.status, name: task.name }))).toEqual([
      { id: 1, status: "completed", name: "Task One" },
      { id: 3, status: "pending", name: "Task 3" },
    ]);
  });

  it("sets plan task status and throws for a missing plan or task", () => {
    const state = stateWithPlanAndTasks();
    const result = applyHarnessCommand(state, {
      type: "set_plan_task_status",
      planId: "plan-1",
      taskId: 2,
      status: "running",
      startedAt: "2026-05-06T00:04:00.000Z",
    }, { now: "2026-05-06T00:04:00.000Z" });

    expect(result.state.plans[0].tasks[1]).toMatchObject({
      id: 2,
      status: "running",
      startedAt: "2026-05-06T00:04:00.000Z",
    });
    expect(() => applyHarnessCommand(state, {
      type: "set_plan_task_status",
      planId: "plan-missing",
      taskId: 1,
      status: "running",
    }, { now: "2026-05-06T00:04:00.000Z" })).toThrow(/plan-missing/);
    expect(() => applyHarnessCommand(state, {
      type: "set_plan_task_status",
      planId: "plan-1",
      taskId: 99,
      status: "running",
    }, { now: "2026-05-06T00:04:00.000Z" })).toThrow(/99/);
  });

  it("sets, updates, and clears todos by owner", () => {
    let state = createHarnessState({ runId: "run-1", title: "Run 1", now: START });
    state = applyHarnessCommand(state, {
      type: "set_todos",
      ownerType: "milestone",
      ownerId: "M1",
      todos: [
        { id: "todo-1", text: "First" },
        { id: "todo-2", text: "Second", status: "completed" },
      ],
    }, { now: NEXT }).state;
    state = applyHarnessCommand(state, {
      type: "set_todos",
      ownerType: "plan",
      ownerId: "plan-1",
      todos: [{ id: "todo-3", text: "Third" }],
    }, { now: "2026-05-06T00:02:00.000Z" }).state;
    state = applyHarnessCommand(state, {
      type: "set_todo_status",
      todoId: "todo-1",
      status: "completed",
    }, { now: "2026-05-06T00:03:00.000Z" }).state;

    expect(state.todos.find((todo) => todo.id === "todo-1")?.status).toBe("completed");
    expect(() => applyHarnessCommand(state, {
      type: "set_todo_status",
      todoId: "todo-missing",
      status: "completed",
    }, { now: "2026-05-06T00:03:00.000Z" })).toThrow(/todo-missing/);

    const result = applyHarnessCommand(state, {
      type: "clear_todos",
      ownerType: "milestone",
      ownerId: "M1",
    }, { now: "2026-05-06T00:04:00.000Z" });

    expect(result.state.todos.map((todo) => todo.id)).toEqual(["todo-3"]);
  });

  it("does not mutate the original state object", () => {
    const state = stateWithPlanAndTasks();
    const original = structuredClone(state);

    const result = applyHarnessCommand(state, {
      type: "set_plan_task_status",
      planId: "plan-1",
      taskId: 1,
      status: "completed",
    }, { now: "2026-05-06T00:04:00.000Z" });

    expect(state).toEqual(original);
    expect(result.state).not.toBe(state);
    expect(result.state.plans).not.toBe(state.plans);
    expect(result.state.plans[0].tasks).not.toBe(state.plans[0].tasks);
  });

  it("sorts milestone summary items by natural milestone id order", () => {
    let state = createHarnessState({ runId: "run-1", title: "Run 1", now: START });
    for (const id of ["M10", "M1", "M2"]) {
      state = applyHarnessCommand(state, {
        type: "upsert_milestone",
        milestone: { id, name: id, dependencies: [] },
      }, { now: NEXT }).state;
    }

    expect(selectMilestoneSummary(state).items.map((milestone) => milestone.id)).toEqual(["M1", "M2", "M10"]);
  });

  it("counts milestone summary statuses", () => {
    let state = createHarnessState({ runId: "run-1", title: "Run 1", now: START });
    for (const [id, status] of [
      ["M1", "completed"],
      ["M2", "failed"],
      ["M3", "executing"],
      ["M4", "pending"],
    ] as const) {
      state = applyHarnessCommand(state, {
        type: "upsert_milestone",
        milestone: { id, name: id, dependencies: [], status },
      }, { now: NEXT }).state;
    }

    expect(selectMilestoneSummary(state)).toMatchObject({
      total: 4,
      completed: 1,
      failed: 1,
      executing: 1,
      pending: 1,
    });
  });

  it("selects the first active milestone by milestone order", () => {
    let state = createHarnessState({ runId: "run-1", title: "Run 1", now: START });
    state = applyHarnessCommand(state, {
      type: "upsert_milestone",
      milestone: { id: "M10", name: "M10", dependencies: [], status: "executing" },
    }, { now: NEXT }).state;
    state = applyHarnessCommand(state, {
      type: "upsert_milestone",
      milestone: { id: "M2", name: "M2", dependencies: [], status: "planning" },
    }, { now: NEXT }).state;

    expect(selectActiveMilestone(state)?.id).toBe("M2");
  });

  it("selects the milestone plan matching planFile when replans exist", () => {
    let state = createHarnessState({ runId: "run-1", title: "Run 1", now: START });
    state = applyHarnessCommand(state, {
      type: "upsert_milestone",
      milestone: {
        id: "M1",
        name: "M1",
        status: "executing",
        planFile: "docs/plans/m1-v2.md",
      },
    }, { now: NEXT }).state;
    state = applyHarnessCommand(state, {
      type: "attach_plan",
      plan: { id: "m1-v1", milestoneId: "M1", title: "Old Plan", goal: "Old", planFile: "docs/plans/m1-v1.md" },
    }, { now: "2026-05-06T00:02:00.000Z" }).state;
    state = applyHarnessCommand(state, {
      type: "attach_plan",
      plan: { id: "m1-v2", milestoneId: "M1", title: "New Plan", goal: "New", planFile: "docs/plans/m1-v2.md" },
    }, { now: "2026-05-06T00:03:00.000Z" }).state;

    expect(selectActivePlan(state)?.id).toBe("m1-v2");
  });

  it("matches milestone planFile across relative and absolute path spellings", () => {
    let state = createHarnessState({ runId: "run-1", title: "Run 1", now: START });
    state = applyHarnessCommand(state, {
      type: "upsert_milestone",
      milestone: {
        id: "M1",
        name: "M1",
        status: "executing",
        planFile: "./docs/plans/m1-v2.md",
      },
    }, { now: NEXT }).state;
    state = applyHarnessCommand(state, {
      type: "attach_plan",
      plan: { id: "m1-v1", milestoneId: "M1", title: "Old Plan", goal: "Old", planFile: "docs/plans/m1-v1.md" },
    }, { now: "2026-05-06T00:02:00.000Z" }).state;
    state = applyHarnessCommand(state, {
      type: "attach_plan",
      plan: { id: "m1-v2", milestoneId: "M1", title: "New Plan", goal: "New", planFile: "/workspace/docs/plans/m1-v2.md" },
    }, { now: "2026-05-06T00:03:00.000Z" }).state;

    expect(selectActivePlan(state)?.id).toBe("m1-v2");
  });

  it("selects active plan by active milestone and falls back to running tasks", () => {
    let state = createHarnessState({ runId: "run-1", title: "Run 1", now: START });
    for (const [id, status] of [
      ["M1", "pending"],
      ["M2", "executing"],
    ] as const) {
      state = applyHarnessCommand(state, {
        type: "upsert_milestone",
        milestone: { id, name: id, dependencies: [], status },
      }, { now: NEXT }).state;
    }
    state = applyHarnessCommand(state, {
      type: "attach_plan",
      plan: { id: "plan-1", milestoneId: "M1", title: "Plan 1", goal: "First" },
    }, { now: NEXT }).state;
    state = applyHarnessCommand(state, {
      type: "attach_plan",
      plan: { id: "plan-2", milestoneId: "M2", title: "Plan 2", goal: "Second" },
    }, { now: NEXT }).state;

    expect(selectActivePlan(state)?.id).toBe("plan-2");

    state = applyHarnessCommand(state, {
      type: "set_milestone_status",
      id: "M2",
      status: "pending",
    }, { now: NEXT }).state;
    state = applyHarnessCommand(state, {
      type: "define_plan_tasks",
      planId: "plan-2",
      tasks: [{ id: 1, name: "Task 1", status: "running" }],
    }, { now: NEXT }).state;

    expect(selectActivePlan(state)?.id).toBe("plan-2");
  });

  it("counts selected plan task statuses", () => {
    let state = stateWithPlanAndTasks();
    state = applyHarnessCommand(state, {
      type: "define_plan_tasks",
      planId: "plan-1",
      tasks: [
        { id: 1, name: "Task 1", status: "completed" },
        { id: 2, name: "Task 2", status: "failed" },
        { id: 3, name: "Task 3", status: "running" },
        { id: 4, name: "Task 4" },
      ],
    }, { now: NEXT }).state;

    expect(selectPlanSummary(state, "plan-1")).toMatchObject({
      total: 4,
      completed: 1,
      failed: 1,
      running: 1,
      pending: 1,
      plan: { id: "plan-1" },
    });
  });

  it("filters todos by owner", () => {
    let state = createHarnessState({ runId: "run-1", title: "Run 1", now: START });
    state = applyHarnessCommand(state, {
      type: "set_todos",
      ownerType: "milestone",
      ownerId: "M1",
      todos: [{ id: "todo-1", text: "First" }],
    }, { now: NEXT }).state;
    state = applyHarnessCommand(state, {
      type: "set_todos",
      ownerType: "plan",
      ownerId: "plan-1",
      todos: [{ id: "todo-2", text: "Second" }],
    }, { now: NEXT }).state;

    expect(selectTodosForOwner(state, "milestone", "M1").map((todo) => todo.id)).toEqual(["todo-1"]);
  });
});
