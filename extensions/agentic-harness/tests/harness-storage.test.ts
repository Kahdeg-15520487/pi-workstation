import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyHarnessCommand, createHarnessState } from "../harness-state.js";
import {
  createHarnessStateSnapshot,
  defaultHarnessStateRoot,
  harnessStateSnapshotPath,
  HARNESS_STATE_FILE,
  PI_HARNESS_STATE_ROOT_ENV,
  readHarnessStateSnapshot,
  writeHarnessStateSnapshot,
} from "../harness-storage.js";

const START = "2026-05-06T00:00:00.000Z";
const NEXT = "2026-05-06T00:01:00.000Z";
const SNAPSHOT_TIME = "2026-05-06T00:02:00.000Z";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env[PI_HARNESS_STATE_ROOT_ENV];
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-storage-"));
  tempDirs.push(dir);
  return dir;
}

function stateWithMilestone() {
  return applyHarnessCommand(createHarnessState({ runId: "run-1", title: "Run 1", now: START }), {
    type: "upsert_milestone",
    milestone: { id: "M1", name: "Milestone 1" },
  }, { now: NEXT }).state;
}

describe("harness-storage", () => {
  it("uses env override and fallback path for the default root", () => {
    process.env[PI_HARNESS_STATE_ROOT_ENV] = "/tmp/harness-state-root";
    expect(defaultHarnessStateRoot("/workspace/project")).toBe("/tmp/harness-state-root");

    delete process.env[PI_HARNESS_STATE_ROOT_ENV];
    expect(defaultHarnessStateRoot("/workspace/project")).toBe(join("/workspace/project", ".pi", "agent", "harness-state"));
  });

  it("builds the snapshot path as root/runId/state.json", () => {
    expect(harnessStateSnapshotPath("/state-root", "run-1")).toBe(join("/state-root", "run-1", HARNESS_STATE_FILE));
  });

  it("returns null for a missing snapshot", async () => {
    const root = await makeTempDir();
    await expect(readHarnessStateSnapshot(join(root, "missing", HARNESS_STATE_FILE))).resolves.toBeNull();
  });

  it("writes then reads state and snapshotSeq", async () => {
    const root = await makeTempDir();
    const path = harnessStateSnapshotPath(root, "run-1");
    const state = stateWithMilestone();
    const snapshot = createHarnessStateSnapshot(state, { now: SNAPSHOT_TIME });

    await writeHarnessStateSnapshot(path, snapshot);
    const restored = await readHarnessStateSnapshot(path);

    expect(restored?.state).toEqual(state);
    expect(restored?.snapshotSeq).toBe(state.eventSeq);
    expect(restored?.writtenAt).toBe(SNAPSHOT_TIME);
  });

  it("throws an error containing the path for corrupt JSON", async () => {
    const root = await makeTempDir();
    const path = harnessStateSnapshotPath(root, "run-1");
    await writeHarnessStateSnapshot(path, createHarnessStateSnapshot(stateWithMilestone()));
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path, "{not json", "utf8"));

    await expect(readHarnessStateSnapshot(path)).rejects.toThrow(path);
  });

  it("throws an error mentioning schema for an unsupported schema", async () => {
    const root = await makeTempDir();
    const path = harnessStateSnapshotPath(root, "run-1");
    await writeHarnessStateSnapshot(path, {
      ...createHarnessStateSnapshot(stateWithMilestone()),
      schemaVersion: 999 as 1,
    });

    await expect(readHarnessStateSnapshot(path)).rejects.toThrow(/schema/i);
  });

  it("creates parent directories when writing", async () => {
    const root = await makeTempDir();
    const path = harnessStateSnapshotPath(join(root, "nested", "state-root"), "run-1");
    const snapshot = createHarnessStateSnapshot(stateWithMilestone());

    await writeHarnessStateSnapshot(path, snapshot);

    await expect(readHarnessStateSnapshot(path)).resolves.toMatchObject({ snapshotSeq: snapshot.snapshotSeq });
  });
});
