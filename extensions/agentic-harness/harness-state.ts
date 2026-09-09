import path from "node:path";

export const HARNESS_STATE_SCHEMA_VERSION = 1;

export type HarnessRunStatus = "pending" | "running" | "completed" | "failed";
export type HarnessMilestoneStatus = "pending" | "planning" | "executing" | "validating" | "completed" | "failed" | "skipped";
export type HarnessPlanTaskStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export type HarnessTodoStatus = "pending" | "completed";
export type HarnessTodoOwnerType = "milestone" | "plan" | "plan_task";

export interface HarnessMilestone {
  id: string;
  name: string;
  status: HarnessMilestoneStatus;
  dependencies: string[];
  attempts: number;
  planFile?: string;
  reviewFile?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HarnessPlanTask {
  id: number;
  name: string;
  status: HarnessPlanTaskStatus;
  dependencies: number[];
  files: string[];
  testCommands: string[];
  acceptanceCriteria: string[];
  startedAt?: string;
  completedAt?: string;
}

export interface HarnessPlan {
  id: string;
  milestoneId: string;
  title: string;
  planFile?: string;
  goal: string;
  tasks: HarnessPlanTask[];
  createdAt: string;
  updatedAt: string;
}

export interface HarnessTodo {
  id: string;
  ownerType: HarnessTodoOwnerType;
  ownerId: string;
  text: string;
  status: HarnessTodoStatus;
  createdAt: string;
  updatedAt: string;
}

export interface HarnessState {
  schemaVersion: typeof HARNESS_STATE_SCHEMA_VERSION;
  runId: string;
  title: string;
  status: HarnessRunStatus;
  milestones: HarnessMilestone[];
  plans: HarnessPlan[];
  todos: HarnessTodo[];
  eventSeq: number;
  createdAt: string;
  updatedAt: string;
}

export type HarnessCommand =
  | {
      type: "upsert_milestone";
      milestone: {
        id: string;
        name: string;
        dependencies?: string[];
        status?: HarnessMilestoneStatus;
        attempts?: number;
        planFile?: string;
        reviewFile?: string;
      };
    }
  | { type: "set_milestone_status"; id: string; status: HarnessMilestoneStatus }
  | {
      type: "attach_plan";
      plan: {
        id: string;
        milestoneId: string;
        title: string;
        planFile?: string;
        goal: string;
      };
    }
  | {
      type: "define_plan_tasks";
      planId: string;
      tasks: Array<{
        id: number;
        name: string;
        dependencies?: number[];
        files?: string[];
        testCommands?: string[];
        acceptanceCriteria?: string[];
        status?: HarnessPlanTaskStatus;
        startedAt?: string;
        completedAt?: string;
      }>;
    }
  | {
      type: "set_plan_task_status";
      planId: string;
      taskId: number;
      status: HarnessPlanTaskStatus;
      startedAt?: string;
      completedAt?: string;
    }
  | {
      type: "set_todos";
      ownerType: HarnessTodoOwnerType;
      ownerId: string;
      todos: Array<{
        id: string;
        text: string;
        status?: HarnessTodoStatus;
      }>;
    }
  | { type: "set_todo_status"; todoId: string; status: HarnessTodoStatus }
  | { type: "clear_todos"; ownerType: HarnessTodoOwnerType; ownerId: string };

export interface HarnessStateEvent {
  seq: number;
  type: HarnessCommand["type"];
  at: string;
  command: HarnessCommand;
}

export interface HarnessReducerResult {
  state: HarnessState;
  event: HarnessStateEvent;
}

export interface HarnessMilestoneSummary {
  total: number;
  completed: number;
  failed: number;
  executing: number;
  pending: number;
  items: HarnessMilestone[];
}

export interface HarnessPlanSummary {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
  plan: HarnessPlan | undefined;
  items: HarnessPlanTask[];
}

function isoNow(): string {
  return new Date().toISOString();
}

function eventFor(state: HarnessState, command: HarnessCommand, at: string): HarnessStateEvent {
  return {
    seq: state.eventSeq + 1,
    type: command.type,
    at,
    command,
  };
}

export function createHarnessState(input: { runId: string; title: string; now?: string }): HarnessState {
  const now = input.now || isoNow();
  return {
    schemaVersion: HARNESS_STATE_SCHEMA_VERSION,
    runId: input.runId,
    title: input.title,
    status: "pending",
    milestones: [],
    plans: [],
    todos: [],
    eventSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function applyHarnessCommand(
  state: HarnessState,
  command: HarnessCommand,
  options: { now?: string } = {},
): HarnessReducerResult {
  const now = options.now || isoNow();
  const event = eventFor(state, command, now);
  const nextBase: HarnessState = {
    ...state,
    milestones: state.milestones.map((milestone) => ({ ...milestone, dependencies: [...milestone.dependencies] })),
    plans: state.plans.map((plan) => ({
      ...plan,
      tasks: plan.tasks.map((task) => ({
        ...task,
        dependencies: [...task.dependencies],
        files: [...task.files],
        testCommands: [...task.testCommands],
        acceptanceCriteria: [...task.acceptanceCriteria],
      })),
    })),
    todos: state.todos.map((todo) => ({ ...todo })),
    eventSeq: event.seq,
    updatedAt: now,
  };

  switch (command.type) {
    case "upsert_milestone": {
      const existing = nextBase.milestones.find((milestone) => milestone.id === command.milestone.id);
      const nextMilestone: HarnessMilestone = {
        id: command.milestone.id,
        name: command.milestone.name,
        status: command.milestone.status ?? existing?.status ?? "pending",
        dependencies: [...(command.milestone.dependencies ?? existing?.dependencies ?? [])],
        attempts: command.milestone.attempts ?? existing?.attempts ?? 0,
        planFile: command.milestone.planFile ?? existing?.planFile,
        reviewFile: command.milestone.reviewFile ?? existing?.reviewFile,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      return {
        state: {
          ...nextBase,
          milestones: existing
            ? nextBase.milestones.map((milestone) => milestone.id === command.milestone.id ? nextMilestone : milestone)
            : [...nextBase.milestones, nextMilestone],
        },
        event,
      };
    }

    case "set_milestone_status": {
      if (!nextBase.milestones.some((milestone) => milestone.id === command.id)) {
        throw new Error(`Milestone ${command.id} not found`);
      }
      return {
        state: {
          ...nextBase,
          milestones: nextBase.milestones.map((milestone) => milestone.id === command.id
            ? { ...milestone, status: command.status, updatedAt: now }
            : milestone),
        },
        event,
      };
    }

    case "attach_plan": {
      const existing = nextBase.plans.find((plan) => plan.id === command.plan.id);
      const nextPlan: HarnessPlan = {
        id: command.plan.id,
        milestoneId: command.plan.milestoneId,
        title: command.plan.title,
        planFile: command.plan.planFile ?? existing?.planFile,
        goal: command.plan.goal,
        tasks: existing?.tasks ?? [],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      return {
        state: {
          ...nextBase,
          plans: existing
            ? nextBase.plans.map((plan) => plan.id === command.plan.id ? nextPlan : plan)
            : [...nextBase.plans, nextPlan],
        },
        event,
      };
    }

    case "define_plan_tasks": {
      const plan = nextBase.plans.find((candidate) => candidate.id === command.planId);
      if (!plan) {
        throw new Error(`Plan ${command.planId} not found`);
      }
      const nextTasks = command.tasks.map((task): HarnessPlanTask => {
        const existing = plan.tasks.find((candidate) => candidate.id === task.id);
        return {
          id: task.id,
          name: task.name,
          status: task.status ?? existing?.status ?? "pending",
          dependencies: [...(task.dependencies ?? [])],
          files: [...(task.files ?? [])],
          testCommands: [...(task.testCommands ?? [])],
          acceptanceCriteria: [...(task.acceptanceCriteria ?? [])],
          startedAt: task.startedAt ?? existing?.startedAt,
          completedAt: task.completedAt ?? existing?.completedAt,
        };
      });
      return {
        state: {
          ...nextBase,
          plans: nextBase.plans.map((candidate) => candidate.id === command.planId
            ? { ...candidate, tasks: nextTasks, updatedAt: now }
            : candidate),
        },
        event,
      };
    }

    case "set_plan_task_status": {
      const plan = nextBase.plans.find((candidate) => candidate.id === command.planId);
      if (!plan) {
        throw new Error(`Plan ${command.planId} not found`);
      }
      if (!plan.tasks.some((task) => task.id === command.taskId)) {
        throw new Error(`Task ${command.taskId} not found in plan ${command.planId}`);
      }
      return {
        state: {
          ...nextBase,
          plans: nextBase.plans.map((candidate) => candidate.id === command.planId
            ? {
                ...candidate,
                tasks: candidate.tasks.map((task) => task.id === command.taskId
                  ? {
                      ...task,
                      status: command.status,
                      startedAt: command.startedAt ?? task.startedAt,
                      completedAt: command.completedAt ?? task.completedAt,
                    }
                  : task),
                updatedAt: now,
              }
            : candidate),
        },
        event,
      };
    }

    case "set_todos": {
      const ownerTodos = command.todos.map((todo): HarnessTodo => ({
        id: todo.id,
        ownerType: command.ownerType,
        ownerId: command.ownerId,
        text: todo.text,
        status: todo.status ?? "pending",
        createdAt: now,
        updatedAt: now,
      }));
      return {
        state: {
          ...nextBase,
          todos: [
            ...nextBase.todos.filter((todo) => todo.ownerType !== command.ownerType || todo.ownerId !== command.ownerId),
            ...ownerTodos,
          ],
        },
        event,
      };
    }

    case "set_todo_status": {
      if (!nextBase.todos.some((todo) => todo.id === command.todoId)) {
        throw new Error(`Todo ${command.todoId} not found`);
      }
      return {
        state: {
          ...nextBase,
          todos: nextBase.todos.map((todo) => todo.id === command.todoId
            ? { ...todo, status: command.status, updatedAt: now }
            : todo),
        },
        event,
      };
    }

    case "clear_todos":
      return {
        state: {
          ...nextBase,
          todos: nextBase.todos.filter((todo) => todo.ownerType !== command.ownerType || todo.ownerId !== command.ownerId),
        },
        event,
      };
  }
}

function milestoneOrderValue(id: string): number | undefined {
  const match = /^M(\d+)$/.exec(id);
  return match ? Number(match[1]) : undefined;
}

function compareMilestonesByOrder(left: HarnessMilestone, right: HarnessMilestone): number {
  const leftOrder = milestoneOrderValue(left.id);
  const rightOrder = milestoneOrderValue(right.id);
  if (leftOrder !== undefined && rightOrder !== undefined && leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.id.localeCompare(right.id);
}

function sortedMilestones(state: HarnessState): HarnessMilestone[] {
  return [...state.milestones].sort(compareMilestonesByOrder);
}

function normalizePlanFileForMatch(planFile: string): string {
  const normalized = path.posix.normalize(planFile.replace(/\\/g, "/"));
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function planFilesMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizePlanFileForMatch(left);
  const normalizedRight = normalizePlanFileForMatch(right);
  return normalizedLeft === normalizedRight
    || normalizedLeft.endsWith(`/${normalizedRight}`)
    || normalizedRight.endsWith(`/${normalizedLeft}`);
}

function comparePlansByUpdatedAtDescending(left: HarnessPlan, right: HarnessPlan): number {
  const updated = right.updatedAt.localeCompare(left.updatedAt);
  return updated !== 0 ? updated : right.id.localeCompare(left.id);
}

function latestPlan(plans: HarnessPlan[]): HarnessPlan | undefined {
  return [...plans].sort(comparePlansByUpdatedAtDescending)[0];
}

export function selectPlanForMilestone(
  state: HarnessState,
  milestone: HarnessMilestone,
): HarnessPlan | undefined {
  const milestonePlans = state.plans.filter((plan) => plan.milestoneId === milestone.id);
  if (milestonePlans.length === 0) return undefined;

  if (milestone.planFile) {
    const matchingPlan = milestonePlans.find(
      (plan) => plan.planFile && planFilesMatch(plan.planFile, milestone.planFile!),
    );
    if (matchingPlan) return matchingPlan;
  }

  return latestPlan(milestonePlans);
}

export function selectMilestoneSummary(state: HarnessState): HarnessMilestoneSummary {
  const items = sortedMilestones(state);
  return {
    total: items.length,
    completed: items.filter((milestone) => milestone.status === "completed").length,
    failed: items.filter((milestone) => milestone.status === "failed").length,
    executing: items.filter((milestone) => milestone.status === "executing").length,
    pending: items.filter((milestone) => milestone.status === "pending").length,
    items,
  };
}

export function selectActiveMilestone(state: HarnessState): HarnessMilestone | undefined {
  return sortedMilestones(state).find((milestone) =>
    milestone.status === "planning" || milestone.status === "executing" || milestone.status === "validating"
  );
}

export function selectActivePlan(state: HarnessState): HarnessPlan | undefined {
  const activeMilestones = sortedMilestones(state)
    .filter((milestone) =>
      milestone.status === "planning" || milestone.status === "executing" || milestone.status === "validating"
    );
  for (const milestone of activeMilestones) {
    const plan = selectPlanForMilestone(state, milestone);
    if (plan) {
      return plan;
    }
  }

  const runningPlans = state.plans.filter((plan) => plan.tasks.some((task) => task.status === "running"));
  return latestPlan(runningPlans) ?? latestPlan(state.plans);
}

export function selectPlanSummary(state: HarnessState, planId?: string): HarnessPlanSummary {
  const plan = planId ? state.plans.find((candidate) => candidate.id === planId) : selectActivePlan(state);
  const items = plan?.tasks ?? [];
  return {
    total: items.length,
    completed: items.filter((task) => task.status === "completed").length,
    failed: items.filter((task) => task.status === "failed").length,
    running: items.filter((task) => task.status === "running").length,
    pending: items.filter((task) => task.status === "pending").length,
    plan,
    items,
  };
}

export function selectTodosForOwner(
  state: HarnessState,
  ownerType: HarnessTodoOwnerType,
  ownerId: string,
): HarnessTodo[] {
  return state.todos.filter((todo) => todo.ownerType === ownerType && todo.ownerId === ownerId);
}
