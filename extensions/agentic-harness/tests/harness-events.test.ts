import { describe, expect, it } from "vitest";
import { applyHarnessCommand, createHarnessState, type HarnessCommand } from "../harness-state.js";
import {
  createHarnessReplayEvent,
  extractHarnessReplayEventsFromSessionEntries,
  HARNESS_STATE_EVENT_CUSTOM_TYPE,
  replayHarnessEvents,
  restoreHarnessStateFromSnapshotAndEvents,
  sortHarnessReplayEvents,
  type HarnessReplayEvent,
} from "../harness-events.js";
import { createHarnessStateSnapshot } from "../harness-storage.js";

const START = "2026-05-06T00:00:00.000Z";
const T1 = "2026-05-06T00:01:00.000Z";
const T2 = "2026-05-06T00:02:00.000Z";
const T3 = "2026-05-06T00:03:00.000Z";
const T4 = "2026-05-06T00:04:00.000Z";

function baseState() {
  return createHarnessState({ runId: "run-1", title: "Run 1", now: START });
}

function replayEvent(seq: number, at: string, command: HarnessCommand, runId = "run-1"): HarnessReplayEvent {
  return {
    schemaVersion: 1,
    runId,
    seq,
    at,
    command,
  };
}

describe("harness-events", () => {
  it("uses the next sequence number when creating replay events", () => {
    const state = applyHarnessCommand(baseState(), {
      type: "upsert_milestone",
      milestone: { id: "M1", name: "Milestone 1" },
    }, { now: T1 }).state;

    const event = createHarnessReplayEvent(state, {
      type: "set_milestone_status",
      id: "M1",
      status: "planning",
    }, { now: T2 });

    expect(event.seq).toBe(state.eventSeq + 1);
    expect(event.at).toBe(T2);
    expect(event.runId).toBe("run-1");
  });

  it("sorts replay events by sequence then timestamp", () => {
    const command: HarnessCommand = {
      type: "upsert_milestone",
      milestone: { id: "M1", name: "Milestone 1" },
    };
    const events = [
      replayEvent(2, T3, command),
      replayEvent(1, T2, command),
      replayEvent(1, T1, command),
    ];

    expect(sortHarnessReplayEvents(events).map((event) => `${event.seq}:${event.at}`)).toEqual([
      `1:${T1}`,
      `1:${T2}`,
      `2:${T3}`,
    ]);
  });

  it("replays milestone, plan, and todo commands onto the base state", () => {
    const state = replayHarnessEvents(baseState(), [
      replayEvent(4, T4, {
        type: "set_todos",
        ownerType: "plan",
        ownerId: "plan-1",
        todos: [{ id: "todo-1", text: "Write tests" }],
      }),
      replayEvent(1, T1, {
        type: "upsert_milestone",
        milestone: { id: "M1", name: "Milestone 1" },
      }),
      replayEvent(3, T3, {
        type: "define_plan_tasks",
        planId: "plan-1",
        tasks: [{ id: 1, name: "Task 1", files: ["file.ts"] }],
      }),
      replayEvent(2, T2, {
        type: "attach_plan",
        plan: { id: "plan-1", milestoneId: "M1", title: "Plan 1", goal: "Ship it" },
      }),
    ]);

    expect(state.eventSeq).toBe(4);
    expect(state.milestones).toMatchObject([{ id: "M1", name: "Milestone 1" }]);
    expect(state.plans).toMatchObject([{ id: "plan-1", tasks: [{ id: 1, name: "Task 1" }] }]);
    expect(state.todos).toMatchObject([{ id: "todo-1", ownerId: "plan-1", text: "Write tests" }]);
    expect(state.updatedAt).toBe(T4);
  });

  it("ignores replay events for other run IDs", () => {
    const state = replayHarnessEvents(baseState(), [
      replayEvent(1, T1, {
        type: "upsert_milestone",
        milestone: { id: "M1", name: "Milestone 1" },
      }, "other-run"),
    ]);

    expect(state.milestones).toEqual([]);
    expect(state.eventSeq).toBe(0);
  });

  it("ignores stale events at or before the base state sequence", () => {
    const stateWithMilestone = applyHarnessCommand(baseState(), {
      type: "upsert_milestone",
      milestone: { id: "M1", name: "Milestone 1" },
    }, { now: T1 }).state;

    const state = replayHarnessEvents(stateWithMilestone, [
      replayEvent(1, T2, {
        type: "upsert_milestone",
        milestone: { id: "M2", name: "Milestone 2" },
      }),
      replayEvent(2, T3, {
        type: "set_milestone_status",
        id: "M1",
        status: "planning",
      }),
    ]);

    expect(state.milestones.map((milestone) => milestone.id)).toEqual(["M1"]);
    expect(state.milestones[0]?.status).toBe("planning");
    expect(state.eventSeq).toBe(2);
  });

  it("restores from fallback state when snapshot is missing", () => {
    const state = restoreHarnessStateFromSnapshotAndEvents(null, baseState(), [
      replayEvent(1, T1, {
        type: "upsert_milestone",
        milestone: { id: "M1", name: "Milestone 1" },
      }),
    ]);

    expect(state.title).toBe("Run 1");
    expect(state.milestones).toMatchObject([{ id: "M1", name: "Milestone 1" }]);
    expect(state.eventSeq).toBe(1);
  });

  it("restores from snapshot state when snapshot is present", () => {
    const snapshotState = applyHarnessCommand(baseState(), {
      type: "upsert_milestone",
      milestone: { id: "M1", name: "Milestone 1" },
    }, { now: T1 }).state;
    const fallback = createHarnessState({ runId: "fallback-run", title: "Fallback", now: START });

    const state = restoreHarnessStateFromSnapshotAndEvents(createHarnessStateSnapshot(snapshotState, { now: T2 }), fallback, [
      replayEvent(2, T3, {
        type: "set_milestone_status",
        id: "M1",
        status: "planning",
      }),
    ]);

    expect(state.runId).toBe("run-1");
    expect(state.title).toBe("Run 1");
    expect(state.milestones[0]?.status).toBe("planning");
  });

  it("restores only events newer than snapshot sequence", () => {
    const snapshotState = applyHarnessCommand(baseState(), {
      type: "upsert_milestone",
      milestone: { id: "M1", name: "Milestone 1" },
    }, { now: T1 }).state;

    const state = restoreHarnessStateFromSnapshotAndEvents(createHarnessStateSnapshot(snapshotState, { now: T2 }), baseState(), [
      replayEvent(1, T2, {
        type: "upsert_milestone",
        milestone: { id: "M2", name: "Milestone 2" },
      }),
      replayEvent(2, T3, {
        type: "set_milestone_status",
        id: "M1",
        status: "planning",
      }),
    ]);

    expect(state.milestones.map((milestone) => milestone.id)).toEqual(["M1"]);
    expect(state.milestones[0]?.status).toBe("planning");
    expect(state.eventSeq).toBe(2);
  });

  it("restores without applying stale pre-snapshot events", () => {
    const withMilestone = applyHarnessCommand(baseState(), {
      type: "upsert_milestone",
      milestone: { id: "M1", name: "Milestone 1" },
    }, { now: T1 }).state;
    const snapshotState = applyHarnessCommand(withMilestone, {
      type: "set_milestone_status",
      id: "M1",
      status: "planning",
    }, { now: T2 }).state;

    const state = restoreHarnessStateFromSnapshotAndEvents(createHarnessStateSnapshot(snapshotState, { now: T3 }), baseState(), [
      replayEvent(1, T3, {
        type: "upsert_milestone",
        milestone: { id: "M2", name: "Milestone 2" },
      }),
      replayEvent(2, T4, {
        type: "set_milestone_status",
        id: "M1",
        status: "completed",
      }),
    ]);

    expect(state.milestones.map((milestone) => milestone.id)).toEqual(["M1"]);
    expect(state.milestones[0]?.status).toBe("planning");
    expect(state.eventSeq).toBe(2);
  });

  it("does not import markdown or assistant prose parsers", async () => {
    const { readFile } = await import("fs/promises");
    const src = await readFile(new URL("../harness-events.ts", import.meta.url), "utf-8");

    expect(src).not.toContain("parseStateMd");
    expect(src).not.toContain("parsePlan");
    expect(src).not.toContain("parseTodoMd");
    expect(src).not.toContain("extractMessageText");
  });

  it("extracts valid custom replay events and ignores unrelated or malformed entries", () => {
    const valid = replayEvent(1, T1, {
      type: "upsert_milestone",
      milestone: { id: "M1", name: "Milestone 1" },
    });
    const entries = [
      { type: "custom", customType: HARNESS_STATE_EVENT_CUSTOM_TYPE, data: valid },
      { type: "custom", customType: "other", data: valid },
      { type: "message", data: valid },
      { type: "custom", customType: HARNESS_STATE_EVENT_CUSTOM_TYPE, data: { ...valid, seq: "1" } },
      null,
    ];

    expect(extractHarnessReplayEventsFromSessionEntries(entries)).toEqual([valid]);
  });
});
