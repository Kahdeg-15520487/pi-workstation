import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyHarnessCommand, createHarnessState, type HarnessState } from "../harness-state.js";
import {
  renderHarnessPlanMarkdown,
  renderHarnessStateMarkdown,
  renderHarnessTodoMarkdown,
} from "../harness-render.js";

const START = "2026-05-06T00:00:00.000Z";
const NEXT = "2026-05-06T00:01:00.000Z";

function buildRenderableState(): HarnessState {
  let state = createHarnessState({ runId: "run-1", title: "Renderer Run", now: START });
  state = applyHarnessCommand(state, {
    type: "upsert_milestone",
    milestone: {
      id: "M1",
      name: "Milestone 1",
      dependencies: [],
      status: "executing",
      planFile: "docs/m1-plan.md",
    },
  }, { now: NEXT }).state;
  state = applyHarnessCommand(state, {
    type: "upsert_milestone",
    milestone: {
      id: "M2",
      name: "Milestone 2",
      dependencies: ["M1"],
      status: "completed",
      attempts: 1,
      reviewFile: "docs/m2-review.md",
    },
  }, { now: "2026-05-06T00:02:00.000Z" }).state;
  state = applyHarnessCommand(state, {
    type: "attach_plan",
    plan: {
      id: "plan-1",
      milestoneId: "M1",
      title: "Renderer Plan",
      goal: "Render structured state",
      planFile: "docs/m1-plan.md",
    },
  }, { now: "2026-05-06T00:03:00.000Z" }).state;
  state = applyHarnessCommand(state, {
    type: "define_plan_tasks",
    planId: "plan-1",
    tasks: [
      {
        id: 1,
        name: "Implement renderer",
        status: "running",
        dependencies: [],
        files: ["extensions/agentic-harness/harness-render.ts"],
        testCommands: ["npm exec -- vitest run tests/harness-render.test.ts"],
        acceptanceCriteria: ["deterministic output", "single trailing newline"],
      },
    ],
  }, { now: "2026-05-06T00:04:00.000Z" }).state;
  state = applyHarnessCommand(state, {
    type: "set_todos",
    ownerType: "plan",
    ownerId: "plan-1",
    todos: [
      { id: "todo-1", text: "Write renderer" },
      { id: "todo-2", text: "Verify output", status: "completed" },
    ],
  }, { now: "2026-05-06T00:05:00.000Z" }).state;
  return state;
}

function expectSingleTrailingNewline(markdown: string): void {
  expect(markdown.endsWith("\n")).toBe(true);
  expect(markdown.endsWith("\n\n")).toBe(false);
}

describe("harness-render", () => {
  it("renders state markdown with milestone table rows and status values", () => {
    const markdown = renderHarnessStateMarkdown(buildRenderableState());

    expect(markdown).toContain("# Renderer Run");
    expect(markdown).toContain("- Run ID: `run-1`");
    expect(markdown).toContain("- Schema Version: 1");
    expect(markdown).toContain("| M1 | Milestone 1 | executing | — | 0 | docs/m1-plan.md | 0/1 · plan-1 · 1 running | — |");
    expect(markdown).toContain("| M2 | Milestone 2 | completed | M1 | 1 | — | — | docs/m2-review.md |");
    expect(markdown).toContain("- Milestones Executing: 1");
    expectSingleTrailingNewline(markdown);
  });

  it("renders plan markdown with task sections, files, test commands, acceptance criteria, and status", () => {
    const markdown = renderHarnessPlanMarkdown(buildRenderableState(), "plan-1");

    expect(markdown).toContain("# Renderer Plan");
    expect(markdown).toContain("- Milestone ID: `M1`");
    expect(markdown).toContain("- Goal: Render structured state");
    expect(markdown).toContain("### Task 1: Implement renderer");
    expect(markdown).toContain("- Status: `running`");
    expect(markdown).toContain("#### Files\n- `extensions/agentic-harness/harness-render.ts`");
    expect(markdown).toContain("#### Test Commands\n- `npm exec -- vitest run tests/harness-render.test.ts`");
    expect(markdown).toContain("#### Acceptance Criteria\n- deterministic output\n- single trailing newline");
    expectSingleTrailingNewline(markdown);
  });

  it("throws for an unknown plan id", () => {
    expect(() => renderHarnessPlanMarkdown(buildRenderableState(), "missing-plan")).toThrow(/missing-plan/);
  });

  it("renders todo checkboxes for pending and completed statuses", () => {
    const markdown = renderHarnessTodoMarkdown(buildRenderableState(), "plan", "plan-1");

    expect(markdown).toContain("- [ ] Write renderer");
    expect(markdown).toContain("- [x] Verify output");
    expectSingleTrailingNewline(markdown);
  });

  it("does not import or call markdown parsers", () => {
    const source = readFileSync(new URL("../harness-render.ts", import.meta.url), "utf8");

    for (const token of ["turndown", "marked", "markdown-it", "MarkdownParser", "parseMarkdown"]) {
      expect(source).not.toContain(token);
    }
  });
});
