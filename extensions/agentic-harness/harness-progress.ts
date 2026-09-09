import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import {
  selectActiveMilestone,
  selectActivePlan,
  selectMilestoneSummary,
  selectPlanSummary,
  selectTodosForOwner,
  type HarnessState,
  type HarnessTodoOwnerType,
} from "./harness-state.js";
import {
  defaultHarnessStateRoot,
  harnessStateSnapshotPath,
  readHarnessStateSnapshot,
} from "./harness-storage.js";

export const PLAN_PROGRESS_SPINNER_MS = 400;

type ChangeListener = () => void;

export class HarnessProgressProvider {
  private runId: string | undefined;
  private rootDir: string | undefined;
  private cachedState: HarnessState | null = null;
  private changeListeners = new Set<ChangeListener>();
  private currentSpinnerFrame = 0;
  private spinnerFrames = ["◐", "◓", "◑", "◒"];
  private lastSpinnerUpdate = 0;
  private readonly SPINNER_INTERVAL_MS = PLAN_PROGRESS_SPINNER_MS;
  private reloadPromise: Promise<void> | null = null;
  private reloadIdentity: string | null = null;
  private reloadQueued = false;

  constructor(options?: { runId?: string; rootDir?: string }) {
    this.runId = options?.runId;
    this.rootDir = options?.rootDir;
    if (this.runId) {
      this.invalidate();
    }
  }

  hasState(): boolean {
    return this.cachedState !== null;
  }

  hasMilestones(): boolean {
    return (this.cachedState?.milestones.length ?? 0) > 0;
  }

  hasPlan(): boolean {
    return this.cachedState ? selectActivePlan(this.cachedState) !== undefined : false;
  }

  setRunId(runId: string): void {
    const changed = this.runId !== runId;
    this.runId = runId;
    if (changed) {
      this.cachedState = null;
    }
    this.invalidate();
  }

  setRun(runId: string, rootDir?: string): void {
    const changed = this.runId !== runId || this.rootDir !== rootDir;
    this.runId = runId;
    this.rootDir = rootDir;
    if (changed) {
      this.cachedState = null;
    }
    this.invalidate();
  }

  hydrate(state: HarnessState, rootDir?: string): void {
    this.runId = state.runId;
    this.rootDir = rootDir;
    this.cachedState = state;
    this.notifyChanged();
  }

  getRunIdentity(): { runId?: string; rootDir?: string } {
    return { runId: this.runId, rootDir: this.rootDir };
  }

  async reload(): Promise<void> {
    const identity = this.identityKey(this.runId, this.rootDir);
    if (this.reloadPromise && this.reloadIdentity === identity) {
      this.reloadQueued = true;
      await this.reloadPromise;
      if (this.reloadQueued && this.reloadIdentity === null && this.identityKey(this.runId, this.rootDir) === identity) {
        this.reloadQueued = false;
        return this.reload();
      }
      return;
    }
    this.reloadIdentity = identity;
    this.reloadPromise = this.doReload(this.runId, this.rootDir);
    try {
      await this.reloadPromise;
    } finally {
      if (this.reloadIdentity === identity) {
        this.reloadPromise = null;
        this.reloadIdentity = null;
      }
    }
  }

  private identityKey(runId: string | undefined, rootDir: string | undefined): string {
    return `${rootDir ?? ""}\u0000${runId ?? ""}`;
  }

  private async doReload(runId: string | undefined, rootDir: string | undefined): Promise<void> {
    if (!runId) {
      if (this.identityKey(this.runId, this.rootDir) === this.identityKey(runId, rootDir)) {
        this.cachedState = null;
      }
      return;
    }
    const dir = rootDir ?? defaultHarnessStateRoot();
    const path = harnessStateSnapshotPath(dir, runId);
    const snapshot = await readHarnessStateSnapshot(path);
    if (this.identityKey(this.runId, this.rootDir) !== this.identityKey(runId, rootDir)) {
      return;
    }
    this.cachedState = snapshot?.state ?? null;
  }

  invalidate(): void {
    void this.reload().then(() => this.notifyChanged());
  }

  subscribeOnChange(listener: ChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private notifyChanged(): void {
    for (const listener of [...this.changeListeners]) listener();
  }

  hasRunningTasks(): boolean {
    const state = this.cachedState;
    if (!state) return false;
    const plan = selectActivePlan(state);
    if (!plan) return false;
    return plan.tasks.some((t) => t.status === "running");
  }

  getProgress(): {
    completed: number;
    total: number;
    failed: number;
    running: number;
    pending: number;
  } {
    const state = this.cachedState;
    if (!state) {
      return { completed: 0, total: 0, failed: 0, running: 0, pending: 0 };
    }
    const plan = selectActivePlan(state);
    if (!plan) {
      return { completed: 0, total: 0, failed: 0, running: 0, pending: 0 };
    }
    const summary = selectPlanSummary(state, plan.id);
    return {
      completed: summary.completed,
      total: summary.total,
      failed: summary.failed,
      running: summary.running,
      pending: summary.pending,
    };
  }

  private getSpinner(): string {
    const now = Date.now();
    if (now - this.lastSpinnerUpdate > this.SPINNER_INTERVAL_MS) {
      this.currentSpinnerFrame =
        (this.currentSpinnerFrame + 1) % this.spinnerFrames.length;
      this.lastSpinnerUpdate = now;
    }
    return this.spinnerFrames[this.currentSpinnerFrame];
  }

  renderMilestones(theme: Theme, maxWidth: number): string[] {
    const state = this.cachedState;
    if (!state) return [];

    const width = Math.max(0, maxWidth);
    if (width === 0) return [];

    const t = theme;
    const lines: string[] = [];
    const clampLine = (line: string) => truncateToWidth(line, width);

    const summary = selectMilestoneSummary(state);
    const pct = summary.total > 0 ? Math.round((summary.completed / summary.total) * 100) : 0;
    const barWidth = Math.min(8, Math.max(1, Math.floor(width / 12)));
    const filled = Math.round((pct / 100) * barWidth);
    const bar =
      t.fg("success", "█".repeat(filled)) +
      t.fg("dim", "░".repeat(barWidth - filled));

    const parts: string[] = [`${bar} ${summary.completed}/${summary.total}`];
    if (summary.failed > 0) parts.push(t.fg("error", `${summary.failed}✗`));
    const running = summary.executing;
    if (running > 0) parts.push(t.fg("warning", `${running}▶`));
    const skipped = summary.items.filter((m) => m.status === "skipped").length;
    if (skipped > 0) parts.push(t.fg("dim", `${skipped}⏭`));
    lines.push(clampLine(`  ${parts.join(t.fg("dim", " "))}`));

    const milestoneParts: string[] = [];
    for (const m of summary.items) {
      let icon: string;
      let color: Parameters<Theme["fg"]>[0];

      switch (m.status) {
        case "completed":
          icon = "✓";
          color = "success";
          break;
        case "failed":
          icon = "✗";
          color = "error";
          break;
        case "skipped":
          icon = "⏭";
          color = "dim";
          break;
        case "executing":
          icon = "▶";
          color = "warning";
          break;
        case "planning":
          icon = "◆";
          color = "accent";
          break;
        case "validating":
          icon = "◎";
          color = "accent";
          break;
        default:
          icon = "○";
          color = "dim";
      }

      milestoneParts.push(`${t.fg(color, icon)}${t.fg(color, m.id)}`);
    }

    lines.push(clampLine(`  ${milestoneParts.join("  ")}`));

    const active = selectActiveMilestone(state);
    if (active) {
      const todos = selectTodosForOwner(state, "milestone" as HarnessTodoOwnerType, active.id);
      if (todos.length > 0) {
        const done = todos.filter((t) => t.status === "completed").length;
        const total = todos.length;
        const taskBarWidth = Math.min(8, Math.max(1, Math.floor(width / 12)));
        const taskFilled = Math.round((done / total) * taskBarWidth);
        const taskBar =
          t.fg("success", "\u2588".repeat(taskFilled)) +
          t.fg("dim", "\u2591".repeat(taskBarWidth - taskFilled));
        lines.push(clampLine(`  ${t.fg("dim", "\u2514\u2500")} ${taskBar} ${t.fg("dim", `${done}/${total}`)} ${t.fg("accent", active.id)}`));

        const maxTasks = Math.min(5, todos.length);
        for (let i = 0; i < maxTasks; i++) {
          const task = todos[i];
          const icon = task.status === "completed" ? t.fg("success", "\u2713") : t.fg("dim", "\u25CB");
          const taskName = truncateToWidth(task.text, Math.max(0, width - 6));
          lines.push(clampLine(`    ${icon} ${t.fg("toolOutput", taskName)}`));
        }
        if (todos.length > maxTasks) {
          lines.push(clampLine(`    ${t.fg("dim", `... +${todos.length - maxTasks} more`)}`));
        }
      }
    }

    return lines;
  }

  renderPlan(theme: Theme, maxWidth: number): string[] {
    const state = this.cachedState;
    if (!state) return [];

    const width = Math.max(0, maxWidth);
    if (width === 0) return [];

    const t = theme;
    const lines: string[] = [];
    const clampLine = (line: string) => truncateToWidth(line, width);

    const plan = selectActivePlan(state);
    if (!plan) return [];

    const goal = plan.goal || plan.title || "";
    const headerText = truncateToWidth(goal ? `▸ ${goal}` : "▸ Plan", width);
    lines.push(clampLine(t.fg("accent", t.bold(headerText))));

    const summary = selectPlanSummary(state, plan.id);
    const { completed, total, failed, running } = summary;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    const barWidth = Math.min(12, Math.max(1, Math.floor(width / 8)));
    const filled = Math.round((pct / 100) * barWidth);
    const bar =
      t.fg("success", "█".repeat(filled)) +
      t.fg("dim", "░".repeat(barWidth - filled));

    const parts: string[] = [];
    parts.push(`${bar} ${t.fg("dim", `${completed}/${total}`)}`);
    if (failed > 0) parts.push(t.fg("error", `${failed} failed`));
    if (running > 0) parts.push(t.fg("warning", `${running} running`));
    lines.push(clampLine("  " + parts.join(t.fg("dim", " │ "))));

    for (const task of plan.tasks) {
      let icon: string;
      let color: Parameters<Theme["fg"]>[0];

      switch (task.status) {
        case "completed":
          icon = "✓";
          color = "success";
          break;
        case "failed":
          icon = "✗";
          color = "error";
          break;
        case "running":
          icon = this.getSpinner();
          color = "warning";
          break;
        default:
          icon = "○";
          color = "dim";
      }

      const textColor: Parameters<Theme["fg"]>[0] = color === "dim" ? "dim" : "toolOutput";
      const name = truncateToWidth(task.name, Math.max(0, width - 4));
      const taskLine = `${t.fg(color, icon)} ${t.fg(textColor, name)}`;
      lines.push(clampLine(`  ${taskLine}`));
    }

    return lines;
  }
}
