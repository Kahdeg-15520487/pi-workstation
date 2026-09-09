import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyAndPersistFromLoadedState, withHarnessStateMutationLock } from "../harness-state-service.js";
import {
  createHarnessStateSnapshot,
  harnessStateSnapshotPath,
  readHarnessStateSnapshot,
  writeHarnessStateSnapshot,
} from "../harness-storage.js";
import { createHarnessState } from "../harness-state.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dual-lock-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * H1 Regression Test: Dual lock registry race condition
 *
 * Background (BEFORE fix):
 *   - `harness-state-service.ts` used `harnessStateMutationLocks` (Map A)
 *   - `index.ts` `persistStructuredSubagentTaskStatuses` used `structuredTaskStatusLocks` (Map B)
 *   - Both protected the same state.json file, but they were independent locks.
 *   - A todowrite call (Map A) and a subagent lifecycle update (Map B) could
 *     read-modify-write the same file concurrently, causing a lost update.
 *
 * Fix:
 *   - `persistStructuredSubagentTaskStatuses` now uses `withHarnessStateMutationLock`
 *     (the shared lock from harness-state-service.ts), so all state mutations
 *     on the same run are serialized through one lock Map.
 *   - Lock keys are canonicalized via `path.resolve()` to prevent path aliasing.
 *
 * These tests verify the fix: both the service path (todowrite) and the raw
 * path (simulating subagent lifecycle) use the SAME shared lock. Both changes
 * must be preserved because the shared lock serializes them.
 */
describe("H1: dual lock registry race condition (regression)", () => {
  it("preserves both changes when service path and subagent path run concurrently", async () => {
    const rootDir = await makeTempDir();
    const runId = "race-test";
    const ctx = { sessionManager: { appendCustomEntry: () => {} } };

    // Setup: initial state with M1=pending and M2=pending
    const initialState = createHarnessState({ runId, title: runId });
    initialState.milestones.push(
      {
        id: "M1",
        name: "Milestone 1",
        status: "pending",
        dependencies: [],
        attempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "M2",
        name: "Milestone 2",
        status: "pending",
        dependencies: [],
        attempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    );
    const snapshotPath = harnessStateSnapshotPath(rootDir, runId);
    await writeHarnessStateSnapshot(snapshotPath, createHarnessStateSnapshot(initialState));

    // --- Service path (todowrite / applyAndPersistFromLoadedState) ---
    // Uses withHarnessStateMutationLock in harness-state-service.ts
    // Changes M1: pending → executing
    const servicePath = async () => {
      await applyAndPersistFromLoadedState(runId, rootDir, () => ({
        type: "set_milestone_status" as const,
        id: "M1",
        status: "executing" as const,
      }), ctx);
    };

    // --- Subagent lifecycle path (simulates persistStructuredSubagentTaskStatuses) ---
    // AFTER fix: uses withHarnessStateMutationLock — the SAME shared lock as the service path.
    // This is the exact same read-modify-write pattern, now wrapped in the shared lock.
    // Changes M2: pending → completed
    const subagentPath = async () => {
      await withHarnessStateMutationLock(runId, rootDir, async () => {
        const snapshot = await readHarnessStateSnapshot(snapshotPath);
        if (!snapshot) throw new Error("snapshot should exist");

        const modifiedState = { ...snapshot.state };
        modifiedState.milestones = modifiedState.milestones.map((m) =>
          m.id === "M2" ? { ...m, status: "completed" as const, updatedAt: new Date().toISOString() } : m,
        );
        await writeHarnessStateSnapshot(
          snapshotPath,
          createHarnessStateSnapshot(modifiedState),
        );
      });
    };

    // Run both paths concurrently — same as todowrite + subagent lifecycle
    // happening at the same time on the same run.
    await Promise.all([servicePath(), subagentPath()]);

    // Verify: BOTH changes must be preserved
    const finalSnapshot = await readHarnessStateSnapshot(snapshotPath);
    expect(finalSnapshot).toBeTruthy();

    const m1 = finalSnapshot!.state.milestones.find((m) => m.id === "M1");
    const m2 = finalSnapshot!.state.milestones.find((m) => m.id === "M2");

    // With the shared lock, both changes are serialized and preserved.
    expect(m1?.status, "M1 should be 'executing' (service path change lost!)").toBe("executing");
    expect(m2?.status, "M2 should be 'completed' (subagent path change lost!)").toBe("completed");
  });

  it("preserves both changes across 10 concurrent iterations", async () => {
    const rootDir = await makeTempDir();
    const runId = "race-multi";
    const ctx = { sessionManager: { appendCustomEntry: () => {} } };

    const snapshotPath = harnessStateSnapshotPath(rootDir, runId);
    let lostUpdateCount = 0;

    for (let iteration = 0; iteration < 10; iteration++) {
      // Reset state before each iteration
      const resetState = createHarnessState({ runId, title: runId });
      for (let i = 1; i <= 5; i++) {
        resetState.milestones.push({
          id: `M${i}`,
          name: `Milestone ${i}`,
          status: "pending",
          dependencies: [],
          attempts: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
      await writeHarnessStateSnapshot(snapshotPath, createHarnessStateSnapshot(resetState));

      // Service path: M1 → executing, M3 → validating
      const servicePath = async () => {
        await applyAndPersistFromLoadedState(runId, rootDir, () => ({
          type: "set_milestone_status" as const,
          id: "M1",
          status: "executing" as const,
        }), ctx);
        await applyAndPersistFromLoadedState(runId, rootDir, () => ({
          type: "set_milestone_status" as const,
          id: "M3",
          status: "validating" as const,
        }), ctx);
      };

      // Subagent lifecycle path: M2 → completed, M4 → failed
      // AFTER fix: uses withHarnessStateMutationLock (same shared lock)
      const subagentPath = async () => {
        await withHarnessStateMutationLock(runId, rootDir, async () => {
          const snapshot = await readHarnessStateSnapshot(snapshotPath);
          if (!snapshot) return;
          let modifiedState = { ...snapshot.state };
          modifiedState.milestones = modifiedState.milestones.map((m) => {
            if (m.id === "M2") return { ...m, status: "completed" as const };
            if (m.id === "M4") return { ...m, status: "failed" as const };
            return m;
          });
          await writeHarnessStateSnapshot(snapshotPath, createHarnessStateSnapshot(modifiedState));
        });
      };

      await Promise.all([servicePath(), subagentPath()]);

      const finalSnapshot = await readHarnessStateSnapshot(snapshotPath);
      const milestones = finalSnapshot!.state.milestones;

      const m1 = milestones.find((m) => m.id === "M1")!;
      const m2 = milestones.find((m) => m.id === "M2")!;
      const m3 = milestones.find((m) => m.id === "M3")!;
      const m4 = milestones.find((m) => m.id === "M4")!;

      const serviceChangesLost = m1.status !== "executing" || m3.status !== "validating";
      const subagentChangesLost = m2.status !== "completed" || m4.status !== "failed";

      if (serviceChangesLost || subagentChangesLost) {
        lostUpdateCount++;
      }
    }

    // With a shared lock, lost updates should NEVER happen.
    expect(lostUpdateCount, `${lostUpdateCount}/10 iterations had lost updates (expected 0 with shared lock)`).toBe(0);
  });
});
