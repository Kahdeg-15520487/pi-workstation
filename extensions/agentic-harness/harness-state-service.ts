import { resolve as resolvePath } from "node:path";
import {
  applyHarnessCommand,
  createHarnessState,
  type HarnessCommand,
  type HarnessState,
} from "./harness-state.js";
import {
  createHarnessReplayEvent,
  HARNESS_STATE_EVENT_CUSTOM_TYPE,
} from "./harness-events.js";
import {
  createHarnessStateSnapshot,
  defaultHarnessStateRoot,
  harnessStateSnapshotPath,
  readHarnessStateSnapshot,
  writeHarnessStateSnapshot,
} from "./harness-storage.js";

function isoNow(): string {
  return new Date().toISOString();
}

const harnessStateMutationLocks = new Map<string, Promise<unknown>>();

export async function withHarnessStateMutationLock<T>(
  runId: string,
  rootDir: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${resolvePath(rootDir ?? defaultHarnessStateRoot())}\0${runId}`;
  const previous = harnessStateMutationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  harnessStateMutationLocks.set(key, queued);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (harnessStateMutationLocks.get(key) === queued) {
      harnessStateMutationLocks.delete(key);
    }
  }
}

export async function loadHarnessState(
  runId: string,
  rootDir?: string,
  now?: string,
): Promise<HarnessState> {
  const dir = rootDir ?? defaultHarnessStateRoot();
  const path = harnessStateSnapshotPath(dir, runId);
  const snapshot = await readHarnessStateSnapshot(path);
  if (snapshot) {
    return snapshot.state;
  }
  return createHarnessState({ runId, title: runId, now: now || isoNow() });
}

export async function persistHarnessState(
  state: HarnessState,
  rootDir?: string,
  now?: string,
): Promise<void> {
  const dir = rootDir ?? defaultHarnessStateRoot();
  const path = harnessStateSnapshotPath(dir, state.runId);
  const snapshot = createHarnessStateSnapshot(state, { now: now || isoNow() });
  await writeHarnessStateSnapshot(path, snapshot);
}

export async function applyAndPersistFromLoadedState(
  runId: string,
  rootDir: string | undefined,
  buildCommand: (state: HarnessState) => HarnessCommand,
  ctx: { sessionManager?: any },
): Promise<{
  state: HarnessState;
  event: import("./harness-state.js").HarnessStateEvent;
}> {
  return withHarnessStateMutationLock(runId, rootDir, async () => {
    const state = await loadHarnessState(runId, rootDir);
    const command = buildCommand(state);
    const replayEvent = createHarnessReplayEvent(state, command, { rootDir });
    const result = applyHarnessCommand(state, command);
    await persistHarnessState(result.state, rootDir);
    ctx.sessionManager?.appendCustomEntry?.(HARNESS_STATE_EVENT_CUSTOM_TYPE, replayEvent);
    return result;
  });
}

export async function applyAndPersist(
  runId: string,
  rootDir: string | undefined,
  command: HarnessCommand,
  ctx: { sessionManager?: any },
): Promise<{
  state: HarnessState;
  event: import("./harness-state.js").HarnessStateEvent;
}> {
  return applyAndPersistFromLoadedState(runId, rootDir, () => command, ctx);
}
