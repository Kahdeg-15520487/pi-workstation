import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HARNESS_STATE_SCHEMA_VERSION, type HarnessState } from "./harness-state.js";

export const HARNESS_STATE_FILE = "state.json";
export const PI_HARNESS_STATE_ROOT_ENV = "PI_HARNESS_STATE_ROOT";

export interface HarnessStateSnapshot {
  schemaVersion: typeof HARNESS_STATE_SCHEMA_VERSION;
  state: HarnessState;
  snapshotSeq: number;
  writtenAt: string;
}

function isoNow(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function defaultHarnessStateRoot(cwd = process.cwd()): string {
  const override = process.env[PI_HARNESS_STATE_ROOT_ENV];
  return override !== undefined ? override : join(cwd, ".pi", "agent", "harness-state");
}

export function harnessStateSnapshotPath(rootDir: string, runId: string): string {
  return join(rootDir, runId, HARNESS_STATE_FILE);
}

export function createHarnessStateSnapshot(
  state: HarnessState,
  options: { now?: string } = {},
): HarnessStateSnapshot {
  return {
    schemaVersion: HARNESS_STATE_SCHEMA_VERSION,
    state,
    snapshotSeq: state.eventSeq,
    writtenAt: options.now || isoNow(),
  };
}

export async function readHarnessStateSnapshot(path: string): Promise<HarnessStateSnapshot | null> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid harness state snapshot JSON at ${path}: ${message}`);
  }

  if (!isRecord(parsed) || parsed.schemaVersion !== HARNESS_STATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported harness state snapshot schema at ${path}: ${String(isRecord(parsed) ? parsed.schemaVersion : undefined)}`);
  }

  const state = parsed.state;
  if (!isRecord(state) || state.schemaVersion !== HARNESS_STATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported harness state snapshot schema at ${path}: ${String(isRecord(state) ? state.schemaVersion : undefined)}`);
  }

  if (typeof parsed.snapshotSeq !== "number" || typeof parsed.writtenAt !== "string") {
    throw new Error(`Invalid harness state snapshot at ${path}`);
  }

  return parsed as unknown as HarnessStateSnapshot;
}

export async function writeHarnessStateSnapshot(path: string, snapshot: HarnessStateSnapshot): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.${HARNESS_STATE_FILE}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
