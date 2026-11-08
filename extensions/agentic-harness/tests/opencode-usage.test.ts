import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => join(tmpdir(), "pi-agent-test"),
}));

vi.mock("@earendil-works/pi-tui", () => ({
	Box: class MockBox {},
	Text: class MockText {},
}));

import {
	buildKeyPanel,
	collectKeyPanel,
	failoverNow,
	isExhausted,
	isExhaustionError,
	isRecovered,
	maskKey,
	parseKeyArgs,
	parseQuota,
	parseUsageArgs,
	readAuthSlots,
	readRotationState,
	reconcileState,
	RECOVERY_PERCENT,
	setAutoFailover,
	swapKeys,
	tryRecover,
	type OpenCodePaths,
	type RotationState,
} from "../opencode-usage.js";

const tempDirs: string[] = [];
const originalEnv = process.env.OPENCODE_API_KEY;

afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	if (originalEnv === undefined) delete process.env.OPENCODE_API_KEY;
	else process.env.OPENCODE_API_KEY = originalEnv;
});

async function makePaths(): Promise<OpenCodePaths> {
	const dir = await mkdtemp(join(tmpdir(), "opencode-usage-"));
	tempDirs.push(dir);
	return { authPath: join(dir, "auth.json"), statePath: join(dir, "rotation.json") };
}

async function writeAuth(paths: OpenCodePaths, key?: string, key2?: string): Promise<void> {
	await writeFile(
		paths.authPath,
		JSON.stringify(
			{
				"opencode-go": {
					type: "api_key",
					...(key === undefined ? {} : { key }),
					...(key2 === undefined ? {} : { key2 }),
				},
				"other-provider": { type: "api_key", key: "keep-me" },
			},
			null,
			2,
		),
		"utf-8",
	);
}

async function writeState(paths: OpenCodePaths, state: RotationState): Promise<void> {
	await writeFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function quotaBody(rolling: number, status = "ok") {
	return {
		usage: {
			rolling: { status, percent: rolling, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
			weekly: { status: "ok", percent: 10 },
			monthly: { status: "ok", percent: 20 },
		},
	};
}

describe("maskKey", () => {
	it("masks long keys", () => {
		expect(maskKey("oc_sk_2b7da3ca0639_tY2VRKHlawCObEFPNmZac9DW8OTehrRz")).toBe("oc_…TehrRz");
	});

	it("leaves short keys alone", () => {
		expect(maskKey("short")).toBe("short");
	});
});

describe("argument parsing", () => {
	it("parses usage ranges and full", () => {
		expect(parseUsageArgs("")).toEqual({ range: "7d", full: false });
		expect(parseUsageArgs("24h")).toEqual({ range: "24h", full: false });
		expect(parseUsageArgs("all FULL")).toEqual({ range: "all", full: true });
		expect(parseUsageArgs("nope").error).toContain("Unknown argument");
	});

	it("parses key commands", () => {
		expect(parseKeyArgs("")).toEqual({ action: "status" });
		expect(parseKeyArgs("rotate")).toEqual({ action: "rotate" });
		expect(parseKeyArgs("auto off")).toEqual({ action: "auto", enabled: false });
		expect(parseKeyArgs("auto on")).toEqual({ action: "auto", enabled: true });
		expect(parseKeyArgs("use key").action).toBe("error");
	});
});

describe("quota parsing", () => {
	it("orders windows and keeps reset times", () => {
		const windows = parseQuota(quotaBody(9));
		expect(windows.map((window) => window.key)).toEqual(["rolling", "weekly", "monthly"]);
		expect(windows[0]!.percent).toBe(9);
		expect(windows[0]!.resetsAt).toBeTruthy();
	});

	it("rejects unexpected shapes", () => {
		expect(() => parseQuota({})).toThrow(/Unexpected response/);
	});
});

describe("recovery decisions", () => {
	it("treats any non-ok window as exhausted", () => {
		expect(isExhausted(parseQuota(quotaBody(100)))).toBe(false);
		expect(isExhausted(parseQuota(quotaBody(100, "exhausted")))).toBe(true);
	});

	it("requires every window below 100 and rolling below the recovery cap", () => {
		expect(isRecovered(parseQuota(quotaBody(RECOVERY_PERCENT - 1)))).toBe(true);
		expect(isRecovered(parseQuota(quotaBody(RECOVERY_PERCENT)))).toBe(false);
		expect(isRecovered(parseQuota({ usage: { rolling: { status: "ok", percent: 1 }, weekly: { status: "ok", percent: 100 } } }))).toBe(false);
		expect(isRecovered([])).toBe(false);
	});

	it("recognises quota errors", () => {
		expect(isExhaustionError("429 Too Many Requests")).toBe(true);
		expect(isExhaustionError("monthly usage limit reached")).toBe(true);
		expect(isExhaustionError("context length exceeded")).toBe(false);
		expect(isExhaustionError(undefined)).toBe(false);
	});
});

describe("key rotation", () => {
	it("starts with the key field active and failover off", async () => {
		const paths = await makePaths();
		await writeAuth(paths, "A", "B");
		const { state, slots } = await readRotationState(paths);
		expect(slots).toEqual({ key: "A", key2: "B" });
		expect(state.failover).toBe(false);
		expect(state.autoFailover).toBe(true);
		await stat(paths.statePath);
	});

	it("swaps both keys, preserves other providers, and writes 0600", async () => {
		const paths = await makePaths();
		await writeAuth(paths, "A", "B");

		const state = await swapKeys(paths, { failover: true });
		expect(state.failover).toBe(true);

		const raw = JSON.parse(await readFile(paths.authPath, "utf-8"));
		expect(raw["opencode-go"]).toMatchObject({ type: "api_key", key: "B", key2: "A" });
		expect(raw["other-provider"]).toEqual({ type: "api_key", key: "keep-me" });

		if (process.platform !== "win32") {
			expect((await stat(paths.authPath)).mode & 0o777).toBe(0o600);
		}
	});

	it("refuses to rotate with a single key or identical keys", async () => {
		const single = await makePaths();
		await writeAuth(single, "A");
		await expect(swapKeys(single, { failover: true })).rejects.toThrow(/both key and key2/);

		const identical = await makePaths();
		await writeAuth(identical, "A", "A");
		await expect(swapKeys(identical, { failover: true })).rejects.toThrow(/identical/);
	});

	it("resets failover when auth.json is edited by hand", async () => {
		const paths = await makePaths();
		await writeAuth(paths, "A", "B");
		await swapKeys(paths, { failover: true });
		expect((await readRotationState(paths)).state.failover).toBe(true);

		// Simulate /login rewriting the active key.
		await writeAuth(paths, "C", "A");
		const { state, slots } = await readRotationState(paths);
		expect(slots).toEqual({ key: "C", key2: "A" });
		expect(state.failover).toBe(false);
	});

	it("reconciles state without both subscriptions", async () => {
		const paths = await makePaths();
		await writeAuth(paths, "A", "B");
		await swapKeys(paths, { failover: true });
		await writeAuth(paths, "A");
		const { state } = await readRotationState(paths);
		expect(state.failover).toBe(false);
	});

	it("persists the auto-failover toggle", async () => {
		const paths = await makePaths();
		await writeAuth(paths, "A", "B");
		await setAutoFailover(paths, false);
		expect((await readRotationState(paths)).state.autoFailover).toBe(false);
	});
});

describe("reconcileState", () => {
	it("treats a fingerprint mismatch as a fresh state", () => {
		const stored: RotationState = {
			version: 2,
			failover: true,
			autoFailover: false,
			fingerprints: { key: "old", key2: "older" },
		};
		const { state, changed } = reconcileState(stored, { key: "A", key2: "B" });
		expect(changed).toBe(true);
		expect(state.failover).toBe(false);
		expect(state.autoFailover).toBe(false);
	});
});

describe("auto failover", () => {
	it("swaps to the standby key on exhaustion", async () => {
		const paths = await makePaths();
		await writeAuth(paths, "A", "B");

		expect(await failoverNow(paths)).toBe(true);
		expect(await readAuthSlots(paths.authPath)).toEqual({ key: "B", key2: "A" });
		expect((await readRotationState(paths)).state.failover).toBe(true);
	});

	it("does nothing when auto-failover is off", async () => {
		const paths = await makePaths();
		await writeAuth(paths, "A", "B");
		await setAutoFailover(paths, false);

		expect(await failoverNow(paths)).toBe(false);
		expect(await readAuthSlots(paths.authPath)).toEqual({ key: "A", key2: "B" });
	});

	it("switches back after the preferred key recovers", async () => {
		const paths = await makePaths();
		await writeAuth(paths, "A", "B");
		await swapKeys(paths, { failover: true });

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(quotaBody(5)), { status: 200 })),
		);

		const result = await tryRecover(paths, { force: true });
		expect(result.recovered).toBe(true);
		expect(await readAuthSlots(paths.authPath)).toEqual({ key: "A", key2: "B" });
		expect((await readRotationState(paths)).state.failover).toBe(false);
	});

	it("stays failed over while the preferred key is still exhausted", async () => {
		const paths = await makePaths();
		await writeAuth(paths, "A", "B");
		await swapKeys(paths, { failover: true });

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(quotaBody(100, "exhausted")), { status: 200 })),
		);

		const result = await tryRecover(paths, { force: true });
		expect(result.recovered).toBe(false);
		expect(await readAuthSlots(paths.authPath)).toEqual({ key: "B", key2: "A" });
	});

	it("does not recover automatically when auto-failover is off", async () => {
		const paths = await makePaths();
		await writeAuth(paths, "A", "B");
		await swapKeys(paths, { failover: true });
		await setAutoFailover(paths, false);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(quotaBody(5)), { status: 200 })),
		);

		expect((await tryRecover(paths, { force: true })).recovered).toBe(false);
		expect(await readAuthSlots(paths.authPath)).toEqual({ key: "B", key2: "A" });
	});
});

describe("key panel", () => {
	it("marks the active and preferred subscriptions", async () => {
		const paths = await makePaths();
		await writeAuth(paths, "A", "B");

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(quotaBody(12)), { status: 200 })),
		);

		const snapshot = await collectKeyPanel(paths);
		expect(snapshot.envOnly).toBe(false);
		expect(snapshot.keys.map((info) => [info.slot, info.active, info.preferred])).toEqual([
			["key", true, true],
			["key2", false, false],
		]);
		expect(snapshot.keys[0]!.windows[0]!.percent).toBe(12);

		const lines = buildKeyPanel(snapshot).map((line) => line.map((span) => span.text).join(""));
		expect(lines[0]).toContain("auto-failover on");
		expect(lines.join("\n")).toContain("active");
	});

	it("reports env-only setups", async () => {
		process.env.OPENCODE_API_KEY = "oc_sk_env";
		const paths = await makePaths();
		await writeFile(paths.authPath, "{}", "utf-8");

		const snapshot = await collectKeyPanel(paths);
		expect(snapshot.envOnly).toBe(true);
		expect(snapshot.keys).toEqual([]);
		expect(buildKeyPanel(snapshot).map((line) => line.map((span) => span.text).join("")).join("\n")).toContain(
			"key2",
		);
	});
});
