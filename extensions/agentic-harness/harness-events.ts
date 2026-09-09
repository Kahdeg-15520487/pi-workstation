import { applyHarnessCommand, type HarnessCommand, type HarnessState } from "./harness-state.js";
import type { HarnessStateSnapshot } from "./harness-storage.js";

export const HARNESS_STATE_EVENT_CUSTOM_TYPE = "harness-state-event";

export interface HarnessReplayEvent {
  schemaVersion: 1;
  runId: string;
  rootDir?: string;
  seq: number;
  at: string;
  command: HarnessCommand;
}

function isoNow(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}

function isTodoOwnerType(value: unknown): boolean {
  return value === "milestone" || value === "plan" || value === "plan_task";
}

function isCommand(value: unknown): value is HarnessCommand {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "upsert_milestone": {
      const milestone = value.milestone;
      return isRecord(milestone) && typeof milestone.id === "string" && typeof milestone.name === "string";
    }
    case "set_milestone_status":
      return typeof value.id === "string" && typeof value.status === "string";
    case "attach_plan": {
      const plan = value.plan;
      return isRecord(plan)
        && typeof plan.id === "string"
        && typeof plan.milestoneId === "string"
        && typeof plan.title === "string"
        && typeof plan.goal === "string";
    }
    case "define_plan_tasks":
      return typeof value.planId === "string" && Array.isArray(value.tasks) && value.tasks.every((task) => {
        if (!isRecord(task) || typeof task.id !== "number" || typeof task.name !== "string") {
          return false;
        }
        return (task.dependencies === undefined || isNumberArray(task.dependencies))
          && (task.files === undefined || isStringArray(task.files))
          && (task.testCommands === undefined || isStringArray(task.testCommands))
          && (task.acceptanceCriteria === undefined || isStringArray(task.acceptanceCriteria));
      });
    case "set_plan_task_status":
      return typeof value.planId === "string" && typeof value.taskId === "number" && typeof value.status === "string";
    case "set_todos":
      return isTodoOwnerType(value.ownerType)
        && typeof value.ownerId === "string"
        && Array.isArray(value.todos)
        && value.todos.every((todo) => isRecord(todo) && typeof todo.id === "string" && typeof todo.text === "string");
    case "set_todo_status":
      return typeof value.todoId === "string" && typeof value.status === "string";
    case "clear_todos":
      return isTodoOwnerType(value.ownerType) && typeof value.ownerId === "string";
    default:
      return false;
  }
}

export function createHarnessReplayEvent(
  state: HarnessState,
  command: HarnessCommand,
  options: { now?: string; rootDir?: string } = {},
): HarnessReplayEvent {
  return {
    schemaVersion: 1,
    runId: state.runId,
    rootDir: options.rootDir,
    seq: state.eventSeq + 1,
    at: options.now || isoNow(),
    command,
  };
}

export function isHarnessReplayEvent(value: unknown): value is HarnessReplayEvent {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.runId === "string"
    && (value.rootDir === undefined || typeof value.rootDir === "string")
    && typeof value.seq === "number"
    && typeof value.at === "string"
    && isCommand(value.command);
}

export function sortHarnessReplayEvents(events: HarnessReplayEvent[]): HarnessReplayEvent[] {
  return [...events].sort((left, right) => left.seq - right.seq || left.at.localeCompare(right.at));
}

export function replayHarnessEvents(baseState: HarnessState, events: HarnessReplayEvent[]): HarnessState {
  return sortHarnessReplayEvents(events).reduce((state, event) => {
    if (event.runId !== baseState.runId || event.seq <= state.eventSeq) {
      return state;
    }
    return applyHarnessCommand(state, event.command, { now: event.at }).state;
  }, baseState);
}

export function restoreHarnessStateFromSnapshotAndEvents(
  snapshot: HarnessStateSnapshot | null,
  fallbackState: HarnessState,
  events: HarnessReplayEvent[],
): HarnessState {
  return replayHarnessEvents(snapshot?.state ?? fallbackState, events);
}

export function extractHarnessReplayEventsFromSessionEntries(entries: unknown[]): HarnessReplayEvent[] {
  return entries.flatMap((entry) => {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== HARNESS_STATE_EVENT_CUSTOM_TYPE) {
      return [];
    }
    return isHarnessReplayEvent(entry.data) ? [entry.data] : [];
  });
}
