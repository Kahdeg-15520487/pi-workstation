/**
 * OpenCode Go usage and key rotation
 *
 * Two commands:
 *
 *   /opencode-usage [24h|7d|30d|all] [full]
 *     Quota windows plus per-model spend for the active OpenCode Go key.
 *
 *   /opencode-key [rotate|use key|use key2|auto on|auto off]
 *     Inspect both auth.json subscriptions and rotate the active one.
 *
 * Two different APIs back the usage panel:
 *
 *  1. Quota (percent only), scoped to the API key:
 *       GET https://opencode.ai/inference/go/v1/usage
 *     Returns rolling (~5h) / weekly / monthly as a percentage of the included
 *     allowance, plus reset times.
 *
 *  2. Per-model spend, in real dollars:
 *       GET https://opencode.ai/console/api/usage/models?range=…
 *       GET https://opencode.ai/console/api/usage/summary?range=…
 *     Returns requests, input/output/cache tokens and cost per model. Cost is
 *     in microcents (100,000,000 = $1). These require Console credentials — a
 *     service-account key (oc_sk_…) or a user token. Inference-only keys get
 *     403, so the spend block is skipped with a note when one is used.
 *
 * Key rotation
 *
 * pi-ai reads only the credential's `key` field; `key2` is inert storage. The
 * rotation therefore swaps the two values so the wanted subscription sits in
 * `key`. auth.json is replaced atomically under a lock directory compatible
 * with proper-lockfile, and AuthStorage notices the file revision change on
 * the next request — no restart or /reload is needed.
 *
 * With auto-failover (default on) an exhausted/failed active key rotates to
 * the standby key. When the preferred key is healthy again (all quota windows
 * OK and the rolling window below `RECOVERY_PERCENT`), a throttled probe
 * switches back. When not failed over, the preferred subscription is whatever
 * sits in `key`; after a failover it is preserved in `key2` until recovery.
 *
 * Usage:
 *   /opencode-usage             quota + top models by cost over the last 7 days
 *   /opencode-usage 24h|7d|30d|all
 *   /opencode-usage 7d full     list every model instead of the top 5
 *   /opencode-key               show both subscriptions and their quota
 *   /opencode-key rotate        switch to the other subscription
 *   /opencode-key auto off      disable automatic failover/recovery
 *
 * Reload with /reload after editing this file.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const PROVIDER_ID = "opencode-go";
const QUOTA_URL = "https://opencode.ai/inference/go/v1/usage";
const SPEND_MODELS_URL = "https://opencode.ai/console/api/usage/models";
const SPEND_SUMMARY_URL = "https://opencode.ai/console/api/usage/summary";
const USAGE_CUSTOM_TYPE = "opencode-usage";
const KEYS_CUSTOM_TYPE = "opencode-keys";
const STATE_FILE_NAME = "opencode-key-rotation.json";
const FETCH_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 8_000;

const RANGES = ["24h", "7d", "30d", "all"] as const;
const DEFAULT_RANGE = "7d";
const TOP_MODELS = 5;
const MAX_PAGES = 10;
const PAGE_SIZE = 100;
const MODEL_NAME_WIDTH = 28;
/** 100,000,000 microcents per US dollar. */
const MICROCENTS_PER_DOLLAR = 100_000_000;

/** Rolling quota is considered recovered below this percent. */
export const RECOVERY_PERCENT = 90;
/** Do not fail over twice within this window (429 + message_end both fire). */
const FAILOVER_COOLDOWN_MS = 60_000;
/** Recovery probes are network calls; run them at most this often. */
const PROBE_INTERVAL_MS = 10 * 60_000;
const AUTH_LOCK_TIMEOUT_MS = 3_000;
const AUTH_LOCK_STALE_MS = 30_000;

const SLOTS = ["key", "key2"] as const;
export type Slot = (typeof SLOTS)[number];

type Range = (typeof RANGES)[number];

type Severity = "ok" | "warn" | "critical";

export interface QuotaWindow {
	key: string;
	label: string;
	percent: number;
	status: string;
	/** ISO timestamp from the API, when present. */
	resetsAt?: string;
}

export interface ModelSpend {
	model: string;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	costDollars: number;
}

export interface SpendSnapshot {
	range: Range;
	full: boolean;
	totals: { requests: number; outputTokens: number; costDollars: number };
	models: ModelSpend[];
	/** Models available in the range, including any not listed here. */
	total: number;
	omitted: number;
}

export interface UsageSnapshot {
	keyHint: string;
	keySource: string;
	fetchedAt: number;
	range: Range;
	full: boolean;
	windows: QuotaWindow[];
	quotaError?: string;
	spend?: SpendSnapshot;
	spendError?: string;
}

export interface KeyInfo {
	slot: Slot;
	masked: string;
	active: boolean;
	preferred: boolean;
	windows: QuotaWindow[];
	error?: string;
}

export interface KeyPanelSnapshot {
	fetchedAt: number;
	autoFailover: boolean;
	failover: boolean;
	envOnly: boolean;
	keys: KeyInfo[];
}

interface ResolvedKey {
	key: string;
	source: string;
	slot?: Slot;
}

export interface AuthSlots {
	key?: string;
	key2?: string;
}

export interface RotationState {
	version: 2;
	/**
	 * True while `key` holds the standby subscription and `key2` holds the
	 * preferred one. When false, `key` holds the preferred subscription.
	 */
	failover: boolean;
	autoFailover: boolean;
	failoverAt?: number;
	lastProbeAt?: number;
	/** Hashes of the values we last wrote, to detect manual /login edits. */
	fingerprints: Partial<Record<Slot, string>>;
}

export interface OpenCodePaths {
	authPath: string;
	statePath: string;
}

/**
 * Span/line model so the themed TUI panel and the plain-text fallback (print
 * and JSON modes, session exports) stay in sync.
 */
type SpanStyle = "accent" | "dim" | "text" | "ok" | "warn" | "critical";
interface Span {
	text: string;
	style?: SpanStyle;
}
type Line = Span[];

const WINDOW_ORDER = ["rolling", "weekly", "monthly"];
const WINDOW_LABELS: Record<string, string> = {
	rolling: "rolling",
	weekly: "weekly",
	monthly: "monthly",
};

/** HTTP failure carrying the status so callers can explain 401/403. */
export class HttpError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

// --- Paths ----------------------------------------------------------------

export function defaultOpenCodePaths(): OpenCodePaths {
	const agentDir = getAgentDir();
	return {
		authPath: join(agentDir, "auth.json"),
		statePath: join(agentDir, STATE_FILE_NAME),
	};
}

// --- Auth.json access -----------------------------------------------------

function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
	let text: string;
	try {
		text = await readFile(path, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(text));
	} catch {
		throw new Error(`${path} is not valid JSON`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${path} must contain a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

function credentialRecord(raw: Record<string, unknown>): Record<string, unknown> {
	const credential = raw[PROVIDER_ID];
	return typeof credential === "object" && credential !== null && !Array.isArray(credential)
		? (credential as Record<string, unknown>)
		: {};
}

function slotValue(credential: Record<string, unknown>, slot: Slot): string | undefined {
	const value = credential[slot];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function slotsOf(credential: Record<string, unknown>): AuthSlots {
	const slots: AuthSlots = {};
	const primary = slotValue(credential, "key");
	const secondary = slotValue(credential, "key2");
	if (primary) slots.key = primary;
	if (secondary) slots.key2 = secondary;
	return slots;
}

export async function readAuthSlots(authPath: string): Promise<AuthSlots> {
	return slotsOf(credentialRecord(await readJsonObject(authPath)));
}

export function maskKey(key: string): string {
	return key.length > 12 ? `${key.slice(0, 3)}…${key.slice(-6)}` : key;
}

function fingerprint(key: string | undefined): string | undefined {
	return key ? createHash("sha256").update(key).digest("hex").slice(0, 16) : undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize auth.json writes. proper-lockfile (used by pi) locks by creating
 * `<file>.lock` as a directory, so mkdir is interoperable with it.
 */
async function withAuthLock<T>(authPath: string, fn: () => Promise<T>): Promise<T> {
	await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });
	const lockPath = `${authPath}.lock`;
	const deadline = Date.now() + AUTH_LOCK_TIMEOUT_MS;
	let delay = 15;

	for (;;) {
		try {
			await mkdir(lockPath);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== "EEXIST" && code !== "EPERM") throw error;

			try {
				const info = await stat(lockPath);
				if (Date.now() - info.mtimeMs > AUTH_LOCK_STALE_MS) {
					await rm(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				// Lock disappeared between mkdir and stat; retry immediately.
				continue;
			}

			if (Date.now() >= deadline) throw new Error("Timed out waiting for the auth.json lock");
			await sleep(delay);
			delay = Math.min(delay * 2, 200);
		}
	}

	try {
		return await fn();
	} finally {
		await rm(lockPath, { recursive: true, force: true }).catch(() => {});
	}
}

async function writeAuthData(authPath: string, raw: Record<string, unknown>): Promise<void> {
	const tempPath = `${authPath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, JSON.stringify(raw, null, 2), { encoding: "utf-8", mode: 0o600 });
	try {
		await rename(tempPath, authPath);
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

// --- Rotation state -------------------------------------------------------

function freshState(slots: AuthSlots, autoFailover: boolean): RotationState {
	return {
		version: 2,
		autoFailover,
		failover: false,
		fingerprints: { key: fingerprint(slots.key), key2: fingerprint(slots.key2) },
	};
}

function parseState(value: unknown): RotationState | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const rawFingerprints = (record.fingerprints ?? {}) as Record<string, unknown>;
	return {
		version: 2,
		autoFailover: record.autoFailover !== false,
		failover: record.failover === true,
		failoverAt: typeof record.failoverAt === "number" ? record.failoverAt : undefined,
		lastProbeAt: typeof record.lastProbeAt === "number" ? record.lastProbeAt : undefined,
		fingerprints: {
			key: typeof rawFingerprints.key === "string" ? rawFingerprints.key : undefined,
			key2: typeof rawFingerprints.key2 === "string" ? rawFingerprints.key2 : undefined,
		},
	};
}

/**
 * Reconcile stored state with the current auth.json. A mismatch means the user
 * logged in or edited keys by hand, so their current `key` is authoritative.
 */
export function reconcileState(
	stored: RotationState | undefined,
	slots: AuthSlots,
): { state: RotationState; changed: boolean } {
	const matched =
		stored !== undefined &&
		(stored.fingerprints.key ?? undefined) === fingerprint(slots.key) &&
		(stored.fingerprints.key2 ?? undefined) === fingerprint(slots.key2);

	if (!matched) {
		return { state: freshState(slots, stored?.autoFailover ?? true), changed: true };
	}

	// Failover only makes sense with both subscriptions present.
	const failover = stored.failover && Boolean(slots.key && slots.key2);
	const changed = failover !== stored.failover;
	return { state: { ...stored, failover }, changed };
}

export async function readRotationState(paths: OpenCodePaths): Promise<{ state: RotationState; slots: AuthSlots }> {
	const slots = await readAuthSlots(paths.authPath);
	let stored: RotationState | undefined;
	try {
		stored = parseState(await readJsonObject(paths.statePath));
	} catch {
		stored = undefined;
	}
	const { state, changed } = reconcileState(stored, slots);
	if (changed) await writeRotationState(paths.statePath, state);
	return { state, slots };
}

async function writeRotationState(statePath: string, state: RotationState): Promise<void> {
	await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
	await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
}

export interface SwapOptions {
	failover: boolean;
}

/**
 * Swap the two saved keys so the standby subscription becomes the credential
 * pi reads. Returns the persisted state.
 */
export async function swapKeys(paths: OpenCodePaths, options: SwapOptions): Promise<RotationState> {
	const { state: current } = await readRotationState(paths);

	await withAuthLock(paths.authPath, async () => {
		const raw = await readJsonObject(paths.authPath);
		const credential = credentialRecord(raw);
		const primary = slotValue(credential, "key");
		const secondary = slotValue(credential, "key2");
		if (!primary || !secondary) {
			throw new Error("Key rotation needs both key and key2 in auth.json for opencode-go");
		}
		if (primary === secondary) {
			throw new Error("Both opencode-go keys are identical; nothing to rotate");
		}
		raw[PROVIDER_ID] = { ...credential, key: secondary, key2: primary };
		await writeAuthData(paths.authPath, raw);
	});

	const slots = await readAuthSlots(paths.authPath);
	const next: RotationState = {
		...current,
		failover: options.failover,
		failoverAt: options.failover ? Date.now() : undefined,
		fingerprints: { key: fingerprint(slots.key), key2: fingerprint(slots.key2) },
	};
	await writeRotationState(paths.statePath, next);
	return next;
}

export async function setAutoFailover(paths: OpenCodePaths, enabled: boolean): Promise<RotationState> {
	const { state } = await readRotationState(paths);
	const next: RotationState = { ...state, autoFailover: enabled };
	await writeRotationState(paths.statePath, next);
	return next;
}

// --- API ------------------------------------------------------------------

export function describeHttpError(status: number, body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string; _tag?: string };
		const message = parsed?.error?.message ?? parsed?.message ?? parsed?._tag;
		if (message) return `HTTP ${status}: ${message}`;
	} catch {
		// Not JSON; fall through to the raw body.
	}
	const snippet = body.trim().slice(0, 120);
	return snippet ? `HTTP ${status}: ${snippet}` : `HTTP ${status}`;
}

async function getJson(url: string, key: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
		signal: AbortSignal.timeout(timeoutMs),
	});
	const body = await response.text();
	if (!response.ok) throw new HttpError(describeHttpError(response.status, body), response.status);
	try {
		return JSON.parse(body);
	} catch {
		throw new Error(`Unparseable response from ${new URL(url).pathname}`);
	}
}

export function parseQuota(payload: unknown): QuotaWindow[] {
	const usage = (payload as { usage?: unknown } | null)?.usage;
	if (!usage || typeof usage !== "object") {
		throw new Error("Unexpected response shape from the OpenCode usage endpoint");
	}

	const windows = Object.entries(
		usage as Record<string, { percent?: unknown; status?: unknown; resetsAt?: unknown }>,
	).map(
		([key, value]): QuotaWindow => {
			const percent = Number(value?.percent);
			return {
				key,
				label: WINDOW_LABELS[key] ?? key,
				percent: Number.isFinite(percent) ? percent : 0,
				status: typeof value?.status === "string" ? value.status : "unknown",
				resetsAt: typeof value?.resetsAt === "string" ? value.resetsAt : undefined,
			};
		},
	);

	const rank = (key: string): number => {
		const index = WINDOW_ORDER.indexOf(key);
		return index === -1 ? WINDOW_ORDER.length : index;
	};
	return windows.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
}

function numberField(value: unknown): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function microCentsToDollars(value: unknown): number {
	return numberField(value) / MICROCENTS_PER_DOLLAR;
}

export function parseModelSpend(raw: unknown): ModelSpend {
	const model = (raw ?? {}) as Record<string, unknown>;
	return {
		model: typeof model.model === "string" ? model.model : "unknown",
		requests: numberField(model.totalRequests),
		inputTokens: numberField(model.totalInputTokens),
		outputTokens: numberField(model.totalOutputTokens),
		cacheReadTokens: numberField(model.totalCacheReadTokens),
		costDollars: microCentsToDollars(model.totalCostMicroCents),
	};
}

export async function fetchQuota(resolved: ResolvedKey, timeoutMs = FETCH_TIMEOUT_MS): Promise<QuotaWindow[]> {
	const windows = parseQuota(await getJson(QUOTA_URL, resolved.key, timeoutMs));
	if (windows.length === 0) throw new Error("The usage endpoint reported no quota windows");
	return windows;
}

export async function fetchSpend(key: string, range: Range, full: boolean): Promise<SpendSnapshot> {
	const [models, summary] = await Promise.all([
		(async () => {
			const collected: ModelSpend[] = [];
			let total = 0;
			let page = 1;
			for (;;) {
				const body = await getJson(
					`${SPEND_MODELS_URL}?range=${range}&page=${page}&pageSize=${full ? PAGE_SIZE : TOP_MODELS}`,
					key,
				);
				const record = (body ?? {}) as {
					items?: unknown;
					pageInfo?: { pageCount?: unknown; total?: unknown };
				};
				const items = Array.isArray(record.items) ? record.items : [];
				collected.push(...items.map(parseModelSpend));
				if (page === 1) total = numberField(record.pageInfo?.total) || collected.length;

				const pageCount = numberField(record.pageInfo?.pageCount);
				if (!full || items.length === 0 || page >= pageCount || page >= MAX_PAGES) break;
				page += 1;
			}
			return { models: collected.sort((a, b) => b.costDollars - a.costDollars), total };
		})(),
		getJson(`${SPEND_SUMMARY_URL}?range=${range}`, key),
	]);

	if (models.models.length === 0) throw new Error(`No per-model usage recorded for range ${range}`);

	const totals = (summary ?? {}) as Record<string, unknown>;
	return {
		range,
		full,
		totals: {
			requests: numberField(totals.totalRequests),
			outputTokens: numberField(totals.totalOutputTokens),
			costDollars: microCentsToDollars(totals.totalCostMicroCents),
		},
		models: models.models,
		total: Math.max(models.total, models.models.length),
		omitted: Math.max(0, Math.max(models.total, models.models.length) - (full ? models.models.length : TOP_MODELS)),
	};
}

/**
 * Explain a spend failure. The missing-Console-key hint is only accurate when
 * the same key passed the quota call, i.e. the key is valid but inference-only.
 */
export function describeSpendError(error: unknown, keyIsValid: boolean): string {
	const message = error instanceof Error ? error.message : String(error);
	if (keyIsValid && error instanceof HttpError && (error.status === 401 || error.status === 403)) {
		return "per-model spend needs a Console key (oc_sk_… service account or user token); inference keys are not allowed";
	}
	return `per-model spend unavailable — ${message}`;
}

// --- Key resolution -------------------------------------------------------

export async function resolveActiveKey(authPath?: string): Promise<ResolvedKey | undefined> {
	const path = authPath ?? defaultOpenCodePaths().authPath;
	const slots = await readAuthSlots(path).catch(() => ({}) as AuthSlots);
	if (slots.key) return { key: slots.key, source: "auth.json key", slot: "key" };
	if (slots.key2) return { key: slots.key2, source: "auth.json key2", slot: "key2" };

	const env = process.env.OPENCODE_API_KEY?.trim();
	if (env) return { key: env, source: "OPENCODE_API_KEY" };

	return undefined;
}

// --- Formatting -----------------------------------------------------------

function severityOf(window: QuotaWindow): Severity {
	if (window.status.toLowerCase() !== "ok") return "critical";
	if (window.percent >= 90) return "critical";
	if (window.percent >= 70) return "warn";
	return "ok";
}

const SEVERITY_STYLE: Record<Severity, SpanStyle> = {
	ok: "ok",
	warn: "warn",
	critical: "critical",
};

function formatPercent(percent: number): string {
	return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

function formatDollars(dollars: number): string {
	if (dollars > 0 && dollars < 0.005) return "<$0.01";
	return `$${dollars.toFixed(2)}`;
}

function formatCount(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
	if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 1 : 2)}M`;
	if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
	return String(Math.round(value));
}

function formatCountdown(iso: string | undefined, now: number): string {
	if (!iso) return "";
	const target = Date.parse(iso);
	if (!Number.isFinite(target)) return "";

	const seconds = Math.floor((target - now) / 1000);
	if (seconds <= 0) return "now";
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m`;
	return `${seconds}s`;
}

function formatResetMoment(iso: string | undefined, now: number): string {
	if (!iso) return "";
	const target = new Date(iso);
	if (Number.isNaN(target.getTime())) return "";

	const time = target.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
	const reference = new Date(now);
	if (target.toDateString() === reference.toDateString()) return time;
	if (target.getFullYear() === reference.getFullYear()) {
		return `${target.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
	}
	return `${target.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })} ${time}`;
}

function truncate(text: string, width: number): string {
	return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text;
}

export function buildQuotaLines(snapshot: UsageSnapshot): Line[] {
	const now = snapshot.fetchedAt;
	const lines: Line[] = [
		[
			{ text: "OpenCode Go", style: "accent" },
			{ text: `  ${snapshot.keyHint} (${snapshot.keySource})  ·  `, style: "dim" },
			{ text: new Date(now).toLocaleTimeString([], { hour12: false }), style: "text" },
		],
	];

	if (snapshot.quotaError) {
		lines.push([], [{ text: snapshot.quotaError, style: "critical" }]);
		return lines;
	}
	if (snapshot.windows.length === 0) return lines;

	lines.push([]);
	const labelWidth = Math.max(...snapshot.windows.map((window) => window.label.length));

	for (const window of snapshot.windows) {
		const severity = severityOf(window);
		const countdown = formatCountdown(window.resetsAt, now);
		const resetMoment = formatResetMoment(window.resetsAt, now);

		const spans: Line = [
			{ text: window.label.padEnd(labelWidth), style: "dim" },
			{ text: "  " },
			{ text: formatPercent(window.percent).padStart(4), style: SEVERITY_STYLE[severity] },
		];

		if (window.status.toLowerCase() !== "ok") {
			spans.push({ text: ` ${window.status}`, style: SEVERITY_STYLE[severity] });
		}
		if (countdown) {
			spans.push({ text: "   resets in ", style: "dim" }, { text: countdown, style: "text" });
			if (resetMoment) spans.push({ text: ` · ${resetMoment}`, style: "dim" });
		}
		lines.push(spans);
	}

	return lines;
}

export function buildSpendLines(spend: SpendSnapshot): Line[] {
	const lines: Line[] = [
		[
			{ text: `spend ${spend.range.padEnd(3)}`, style: "dim" },
			{ text: "   " },
			{ text: formatDollars(spend.totals.costDollars), style: "accent" },
			{
				text: `   ${formatCount(spend.totals.requests)} req · ${formatCount(spend.totals.outputTokens)} out`,
				style: "dim",
			},
		],
	];

	const shown = spend.full ? spend.models : spend.models.slice(0, TOP_MODELS);
	const nameWidth = Math.min(MODEL_NAME_WIDTH, Math.max(...shown.map((model) => model.model.length)));
	const costWidth = Math.max(...shown.map((model) => formatDollars(model.costDollars).length));
	const requestWidth = Math.max(...shown.map((model) => formatCount(model.requests).length));

	for (const model of shown) {
		lines.push([
			{ text: "  " },
			{ text: truncate(model.model, nameWidth).padEnd(nameWidth), style: "dim" },
			{ text: "  " },
			{ text: formatDollars(model.costDollars).padStart(costWidth), style: "text" },
			{ text: "  " },
			{ text: formatCount(model.requests).padStart(requestWidth), style: "text" },
			{ text: " req", style: "dim" },
		]);
	}

	if (spend.omitted > 0) {
		lines.push([
			{ text: `  … ${spend.omitted} more · `, style: "dim" },
			{ text: `/opencode-usage ${spend.range} full`, style: "dim" },
		]);
	}

	return lines;
}

export function buildUsagePanel(snapshot: UsageSnapshot): Line[] {
	const lines = buildQuotaLines(snapshot);
	if (snapshot.quotaError) return lines;

	lines.push([]);
	if (snapshot.spendError) lines.push([{ text: snapshot.spendError, style: "warn" }]);
	else if (snapshot.spend) lines.push(...buildSpendLines(snapshot.spend));

	return lines;
}

export function buildKeyPanel(snapshot: KeyPanelSnapshot): Line[] {
	const header: Line = [{ text: "OpenCode Go keys", style: "accent" }];
	header.push({ text: "   ", style: "dim" });
	if (snapshot.envOnly) {
		header.push({ text: "OPENCODE_API_KEY only", style: "warn" });
	} else {
		header.push({
			text: `auto-failover ${snapshot.autoFailover ? "on" : "off"}`,
			style: snapshot.autoFailover ? "ok" : "dim",
		});
		if (snapshot.failover) header.push({ text: "  ·  failed over", style: "warn" });
	}

	const lines: Line[] = [header];

	if (snapshot.envOnly) {
		lines.push([]);
		lines.push([
			{ text: "Save a second subscription as auth.json key2 to enable rotation.", style: "dim" },
		]);
		return lines;
	}

	if (snapshot.keys.length === 0) {
		lines.push([]);
		lines.push([{ text: "No opencode-go key/key2 found in auth.json.", style: "warn" }]);
		return lines;
	}

	if (!snapshot.keys.some((info) => info.active)) {
		lines.push([]);
		lines.push([
			{ text: "`key` is missing — pi cannot use `key2` until a key is saved with /login.", style: "warn" },
		]);
	}

	const now = snapshot.fetchedAt;
	for (const info of snapshot.keys) {
		const tags: string[] = [];
		if (info.active) tags.push("active");
		if (info.preferred && !info.active) tags.push("preferred");
		lines.push([]);
		lines.push([
			{ text: info.slot.padEnd(4), style: "text" },
			{ text: "  " },
			{ text: info.masked, style: info.active ? "accent" : "dim" },
			...(tags.length > 0
				? [{ text: `  ${tags.join(", ")}`, style: info.active ? "ok" : "warn" } as Span]
				: []),
		]);

		if (info.error) {
			lines.push([{ text: "    ", style: "dim" }, { text: info.error, style: "critical" }]);
			continue;
		}
		if (info.windows.length === 0) {
			lines.push([{ text: "    no quota data", style: "dim" }]);
			continue;
		}
		for (const window of info.windows) {
			const severity = severityOf(window);
			const countdown = formatCountdown(window.resetsAt, now);
			const spans: Line = [
				{ text: "    " },
				{ text: window.label.padEnd(7), style: "dim" },
				{ text: formatPercent(window.percent).padStart(4), style: SEVERITY_STYLE[severity] },
			];
			if (window.status.toLowerCase() !== "ok") {
				spans.push({ text: ` ${window.status}`, style: SEVERITY_STYLE[severity] });
			}
			if (countdown) spans.push({ text: "   resets in ", style: "dim" }, { text: countdown, style: "text" });
			lines.push(spans);
		}
	}

	lines.push([]);
	lines.push([
		{ text: "  /opencode-key rotate · use key|key2 · auto on|off", style: "dim" },
	]);
	return lines;
}

function paint(line: Line, theme: Theme): string {
	return line
		.map((span) => {
			switch (span.style) {
				case "accent":
					return theme.fg("accent", theme.bold(span.text));
				case "dim":
					return theme.fg("dim", span.text);
				case "ok":
					return theme.fg("success", theme.bold(span.text));
				case "warn":
					return theme.fg("warning", theme.bold(span.text));
				case "critical":
					return theme.fg("error", theme.bold(span.text));
				default:
					return span.text;
			}
		})
		.join("");
}

function plainPanel(title: string, lines: Line[]): string {
	return `${title}\n\n${lines.map((line) => line.map((span) => span.text).join("")).join("\n")}`;
}

// --- Argument parsing -----------------------------------------------------

export interface ParsedUsageArgs {
	range: Range;
	full: boolean;
	error?: string;
}

export function parseUsageArgs(args: string): ParsedUsageArgs {
	let range: Range = DEFAULT_RANGE;
	let full = false;

	for (const token of args.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
		if (token === "full" || token === "all-models") {
			full = true;
			continue;
		}
		if ((RANGES as readonly string[]).includes(token)) {
			range = token as Range;
			continue;
		}
		return { range, full, error: `Unknown argument "${token}". Use ${RANGES.join(" | ")} or full.` };
	}

	return { range, full };
}

export type KeyCommand =
	| { action: "status" }
	| { action: "rotate" }
	| { action: "auto"; enabled: boolean }
	| { action: "error"; message: string };

export function parseKeyArgs(args: string): KeyCommand {
	const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === "status")) return { action: "status" };

	if (tokens.length === 1 && tokens[0] === "rotate") return { action: "rotate" };

	if (tokens[0] === "auto") {
		if (tokens[1] === "on" || tokens[1] === "enable" || tokens[1] === "true") {
			return { action: "auto", enabled: true };
		}
		if (tokens[1] === "off" || tokens[1] === "disable" || tokens[1] === "false") {
			return { action: "auto", enabled: false };
		}
		return { action: "error", message: "Use `/opencode-key auto on` or `/opencode-key auto off`." };
	}

	return {
		action: "error",
		message: `Unknown argument "${tokens[0]}". Use rotate, auto on|off, or status.`,
	};
}

// --- Recovery / failover decisions ---------------------------------------

export function isExhausted(windows: QuotaWindow[]): boolean {
	return windows.some((window) => window.status.toLowerCase() !== "ok");
}

/** Healthy = every window OK and the rolling window below the recovery cap. */
export function isRecovered(windows: QuotaWindow[]): boolean {
	if (windows.length === 0) return false;
	if (windows.some((window) => window.status.toLowerCase() !== "ok" || window.percent >= 100)) return false;
	const rolling = windows.find((window) => window.key === "rolling");
	return rolling === undefined || rolling.percent < RECOVERY_PERCENT;
}

export function isExhaustionError(message: string | undefined): boolean {
	if (!message) return false;
	return /\b(quota|usage limit|rate.?limit|too many requests|insufficient|exhausted|payment required)\b|429/i.test(
		message,
	);
}

function isOpenCodeModel(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === PROVIDER_ID;
}

async function probeKeyQuota(key: string): Promise<QuotaWindow[]> {
	return fetchQuota({ key, source: "probe" }, PROBE_TIMEOUT_MS);
}

/**
 * If we are failed over and the preferred key looks healthy again, rotate back.
 * The preferred subscription is preserved in `key2` during a failover.
 */
export async function tryRecover(
	paths: OpenCodePaths,
	options: { force?: boolean } = {},
): Promise<{ recovered: boolean; masked?: string }> {
	const { state, slots } = await readRotationState(paths);
	if (!state.autoFailover) return { recovered: false };
	if (!state.failover) return { recovered: false };
	if (!options.force && state.lastProbeAt && Date.now() - state.lastProbeAt < PROBE_INTERVAL_MS) {
		return { recovered: false };
	}

	const preferredKey = slots.key2;
	if (!preferredKey) return { recovered: false };

	await writeRotationState(paths.statePath, { ...state, lastProbeAt: Date.now() });

	try {
		const windows = await probeKeyQuota(preferredKey);
		if (!isRecovered(windows)) return { recovered: false };
		await swapKeys(paths, { failover: false });
		return { recovered: true, masked: maskKey(preferredKey) };
	} catch {
		// Probe failures are not fatal; try again after the interval.
		return { recovered: false };
	}
}

let failoverInFlight: Promise<boolean> | null = null;
let lastFailoverAt = 0;

/**
 * Rotate away from the active key when it is exhausted. Never performs network
 * I/O: the recovery probe runs separately in the background.
 */
export async function failoverNow(paths: OpenCodePaths): Promise<boolean> {
	if (failoverInFlight) return failoverInFlight;

	failoverInFlight = (async () => {
		const { state, slots } = await readRotationState(paths);
		if (!state.autoFailover) return false;
		if (Date.now() - lastFailoverAt < FAILOVER_COOLDOWN_MS) return false;
		if (!slots.key || !slots.key2) return false;
		// Already on the standby key: wait for the background recovery probe.
		if (state.failover) return false;

		await swapKeys(paths, { failover: true });
		lastFailoverAt = Date.now();
		return true;
	})();

	try {
		return await failoverInFlight;
	} catch {
		return false;
	} finally {
		failoverInFlight = null;
	}
}

async function activeKeyHint(paths: OpenCodePaths): Promise<string> {
	const slots = await readAuthSlots(paths.authPath).catch(() => ({}) as AuthSlots);
	return slots.key ? maskKey(slots.key) : "key";
}

// --- Key panel data -------------------------------------------------------

export async function collectKeyPanel(paths: OpenCodePaths): Promise<KeyPanelSnapshot> {
	const { state, slots } = await readRotationState(paths);

	if (!slots.key && !slots.key2) {
		return {
			fetchedAt: Date.now(),
			autoFailover: state.autoFailover,
			failover: state.failover,
			envOnly: Boolean(process.env.OPENCODE_API_KEY?.trim()),
			keys: [],
		};
	}

	const keys = await Promise.all(
		SLOTS.filter((slot) => slots[slot]).map(async (slot): Promise<KeyInfo> => {
			const key = slots[slot]!;
			const info: KeyInfo = {
				slot,
				masked: maskKey(key),
				active: slot === "key",
				preferred: slot === (state.failover ? "key2" : "key"),
				windows: [],
			};
			try {
				info.windows = await probeKeyQuota(key);
			} catch (error) {
				info.error = error instanceof Error ? error.message : String(error);
			}
			return info;
		}),
	);

	return {
		fetchedAt: Date.now(),
		autoFailover: state.autoFailover,
		failover: state.failover,
		envOnly: false,
		keys,
	};
}

// --- Extension ------------------------------------------------------------

export function registerOpenCodeUsage(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<UsageSnapshot>(USAGE_CUSTOM_TYPE, (message, { outputPad }, theme) => {
		const snapshot = message.details;
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		if (!snapshot) {
			box.addChild(new Text(message.content as string, 0, 0));
			return box;
		}
		for (const line of buildUsagePanel(snapshot)) {
			box.addChild(new Text(line.length === 0 ? "" : paint(line, theme), 0, 0));
		}
		return box;
	});

	pi.registerMessageRenderer<KeyPanelSnapshot>(KEYS_CUSTOM_TYPE, (message, { outputPad }, theme) => {
		const snapshot = message.details;
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		if (!snapshot) {
			box.addChild(new Text(message.content as string, 0, 0));
			return box;
		}
		for (const line of buildKeyPanel(snapshot)) {
			box.addChild(new Text(line.length === 0 ? "" : paint(line, theme), 0, 0));
		}
		return box;
	});

	pi.registerCommand("opencode-usage", {
		description: "Show the OpenCode Go quota and per-model spend",
		getArgumentCompletions: (prefix) => {
			const token = prefix.trim().toLowerCase();
			// A second word is already a choice; offer completions only for the first.
			if (token.length === 0 || /\s/.test(token)) return null;
			const matches = [...RANGES, "full"].filter((option) => option.startsWith(token));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseUsageArgs(args);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}

			const resolved = await resolveActiveKey();
			if (!resolved) {
				ctx.ui.notify(
					`No ${PROVIDER_ID} API key found. Run /login ${PROVIDER_ID}, or set OPENCODE_API_KEY.`,
					"error",
				);
				return;
			}

			// Quota and spend come from different APIs with different
			// credentials; one failing must not hide the other.
			const [quota, spend] = await Promise.allSettled([
				fetchQuota(resolved),
				fetchSpend(resolved.key, parsed.range, parsed.full),
			]);

			const snapshot: UsageSnapshot = {
				keyHint: maskKey(resolved.key),
				keySource: resolved.source,
				fetchedAt: Date.now(),
				range: parsed.range,
				full: parsed.full,
				windows: quota.status === "fulfilled" ? quota.value : [],
				spend: spend.status === "fulfilled" ? spend.value : undefined,
			};

			if (quota.status === "rejected") {
				snapshot.quotaError = `Could not read OpenCode Go quota — ${
					quota.reason instanceof Error ? quota.reason.message : String(quota.reason)
				}`;
			}
			if (spend.status === "rejected") {
				snapshot.spendError = describeSpendError(spend.reason, quota.status === "fulfilled");
			}

			pi.sendMessage<UsageSnapshot>({
				customType: USAGE_CUSTOM_TYPE,
				content: plainPanel("OpenCode Go usage", buildUsagePanel(snapshot)),
				display: true,
				details: snapshot,
			});

			for (const problem of [snapshot.quotaError, snapshot.spendError]) {
				if (problem) ctx.ui.notify(problem, "error");
			}
		},
	});

	pi.registerCommand("opencode-key", {
		description: "Show or rotate the OpenCode Go auth.json subscriptions",
		getArgumentCompletions: (prefix) => {
			const token = prefix.trim().toLowerCase();
			const options = ["status", "rotate", "auto", "on", "off"];
			const matches = options.filter((option) => option.startsWith(token) && option !== token);
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseKeyArgs(args);
			const paths = defaultOpenCodePaths();

			if (parsed.action === "error") {
				ctx.ui.notify(parsed.message, "error");
				return;
			}

			if (parsed.action === "rotate") {
				const slots = await readAuthSlots(paths.authPath).catch(() => ({}) as AuthSlots);
				if (!slots.key || !slots.key2) {
					ctx.ui.notify("Key rotation needs both key and key2 saved in auth.json for opencode-go.", "error");
					return;
				}
				if (slots.key === slots.key2) {
					ctx.ui.notify("Both opencode-go keys are identical; nothing to rotate.", "warning");
					return;
				}

				await swapKeys(paths, { failover: false });
				const active = await activeKeyHint(paths);
				ctx.ui.notify(`OpenCode Go: rotated to the other subscription (${active}).`, "info");
				lastFailoverAt = 0;
			}

			if (parsed.action === "auto") {
				await setAutoFailover(paths, parsed.enabled);
				ctx.ui.notify(`OpenCode Go auto-failover ${parsed.enabled ? "enabled" : "disabled"}.`, "info");
			}

			const snapshot = await collectKeyPanel(paths);
			pi.sendMessage<KeyPanelSnapshot>({
				customType: KEYS_CUSTOM_TYPE,
				content: plainPanel("OpenCode Go keys", buildKeyPanel(snapshot)),
				display: true,
				details: snapshot,
			});
		},
	});

	// Recovery probes run in the background so they never delay a turn.
	const scheduleRecoveryProbe = (ctx: ExtensionContext, force = false) => {
		const paths = defaultOpenCodePaths();
		void (async () => {
			const { state } = await readRotationState(paths);
			if (!state.failover) return;
			const result = await tryRecover(paths, { force });
			if (result.recovered) {
				lastFailoverAt = 0;
				ctx.ui.notify(
					`OpenCode Go: preferred subscription recovered (${result.masked ?? "key"}) — switched back.`,
					"info",
				);
			}
		})().catch(() => {});
	};

	pi.on("session_start", (_event, ctx) => {
		scheduleRecoveryProbe(ctx, true);
	});

	pi.on("turn_start", (_event, ctx) => {
		scheduleRecoveryProbe(ctx);
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (event.status !== 429 && event.status !== 402) return;
		if (!isOpenCodeModel(ctx)) return;

		const paths = defaultOpenCodePaths();
		const rotated = await failoverNow(paths);
		if (rotated) {
			ctx.ui.notify(
				`OpenCode Go: HTTP ${event.status} — switched to the other subscription (${await activeKeyHint(paths)}).`,
				"warning",
			);
		} else {
			scheduleRecoveryProbe(ctx);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		if (message.provider !== PROVIDER_ID) return;
		if (message.stopReason !== "error" || !isExhaustionError(message.errorMessage)) return;

		const paths = defaultOpenCodePaths();
		const rotated = await failoverNow(paths);
		if (rotated) {
			ctx.ui.notify(
				`OpenCode Go: quota error — switched to the other subscription (${await activeKeyHint(paths)}).`,
				"warning",
			);
		} else {
			scheduleRecoveryProbe(ctx);
		}
	});
}
