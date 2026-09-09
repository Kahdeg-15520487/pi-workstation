/**
 * Simple Todo State — senpi-inspired minimal todo tracking.
 *
 * No IDs, no milestones, no plans, no owners.
 * Just a flat list of {content, status, priority}.
 */

export type SimpleTodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type SimpleTodoPriority = "high" | "medium" | "low";

export interface SimpleTodoItem {
  content: string;
  status: SimpleTodoStatus;
  priority: SimpleTodoPriority;
}

export interface SimpleTodoState {
  todos: SimpleTodoItem[];
}

const TODO_STATE_ENTRY_TYPE = "pi-workstation.todo-state";

// In-memory todo state for the current session
let currentTodos: SimpleTodoItem[] = [];
let changeListeners: Array<() => void> = [];

export function subscribeOnChange(listener: () => void): () => void {
  changeListeners.push(listener);
  return () => { changeListeners = changeListeners.filter((l) => l !== listener); };
}

function notifyChange(): void {
  for (const listener of changeListeners) listener();
}

export function getCurrentTodos(): SimpleTodoItem[] {
  return currentTodos.map((t) => ({ ...t }));
}

export function setCurrentTodos(todos: SimpleTodoItem[]): void {
  currentTodos = todos.map((t) => ({ ...t }));
  notifyChange();
}

function hasAppendCustomEntry(
  sessionManager: unknown,
): sessionManager is { appendCustomEntry: (type: string, data: unknown) => unknown } {
  return (
    typeof sessionManager === "object" &&
    sessionManager !== null &&
    "appendCustomEntry" in sessionManager &&
    typeof sessionManager.appendCustomEntry === "function"
  );
}

export function appendTodoEntry(
  sessionManager: unknown,
  todos: SimpleTodoItem[],
): void {
  if (!hasAppendCustomEntry(sessionManager)) return;
  sessionManager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, { todos });
}

export function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "cancelled";
}

export function getTodoMarker(status: string): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "•";
  if (status === "cancelled") return "×";
  return "○";
}

/** Restore todos from session branch entries on session start */
export function restoreTodosFromBranchEntries(entries: unknown[]): void {
  let restored: SimpleTodoItem[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { type?: unknown; customType?: unknown; data?: unknown };

    if (e.type === "custom" && e.customType === TODO_STATE_ENTRY_TYPE) {
      const data = e.data as SimpleTodoState | undefined;
      if (data && Array.isArray(data.todos)) {
        restored = data.todos.filter(isValidTodoItem).map((t) => ({ ...t }));
      }
    }
  }

  currentTodos = restored;
}

function isValidTodoItem(item: unknown): item is SimpleTodoItem {
  if (!item || typeof item !== "object") return false;
  const t = item as Record<string, unknown>;
  return typeof t.content === "string" && typeof t.status === "string" && typeof t.priority === "string";
}
