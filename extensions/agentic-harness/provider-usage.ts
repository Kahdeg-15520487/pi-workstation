/**
 * Provider-agnostic usage / quota reporting.
 *
 * The footer and the /provider command both need "how much of this
 * subscription is left" for whichever provider is active. Each provider reports
 * that in a different shape, so this module normalises them to one model:
 *
 *   ProviderUsage { provider, fetchedAt, plan?, windows: UsageWindow[] }
 *   UsageWindow   { key, label, remainingPercent, unlimited, remaining?, ... }
 *
 * `remainingPercent` is always REMAINING (100 = untouched, 0 = exhausted),
 * because every consumer here asks "how much is left". OpenCode reports the
 * opposite (percent used), so that conversion happens in one place.
 *
 * Providers implemented:
 *
 *   opencode-go     GET opencode.ai/inference/go/v1/usage
 *                   rolling (~5h) / weekly / monthly, percent USED, key-scoped.
 *                   Delegates to resolveActiveKey + fetchQuota in opencode-usage.ts
 *                   so there is exactly one implementation of that API.
 *
 *   github-copilot  GET api.github.com/copilot_internal/user
 *                   quota_snapshots.{premium_interactions,chat,completions} with
 *                   percent_remaining, entitlement and quota_reset_date.
 *                   NOTE: this endpoint authenticates with the GitHub OAuth token
 *                   (auth.json `refresh`), NOT the Copilot `access` token -- the
 *                   access token returns 401 Bad credentials. pi-ai only stores
 *                   the access token for API calls and does not implement quota
 *                   at all, so this is the only place that reads `refresh`.
 *
 * `unlimited: true` windows (chat/completions on a business seat) are kept with
 * remainingPercent 100 and are ignored when picking the binding window.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { defaultOpenCodePaths, fetchQuota, resolveActiveKey } from "./opencode-usage.js";

export const PROVIDER_OPENCODE = "opencode-go";
export const PROVIDER_COPILOT = "github-copilot";

/** Providers this module can report usage for, in display order. */
export const USAGE_PROVIDERS = [PROVIDER_OPENCODE, PROVIDER_COPILOT] as const;
export type UsageProviderId = typeof USAGE_PROVIDERS[number];

export interface UsageWindow {
  /** Stable machine key ("rolling", "premium_interactions", ...). */
  key: string;
  /** Human label for prose ("rolling", "monthly", "premium"). */
  label: string;
  /**
   * Abbreviated label for the footer ("roll", "wk", "mo", "prem"). Without it
   * a bare percentage says nothing about which window it belongs to.
   */
  shortLabel?: string;
  /** 0..100, REMAINING. 100 = untouched, 0 = exhausted. */
  remainingPercent: number;
  /** True when the provider reports the window as unmetered. */
  unlimited: boolean;
  /** Absolute units remaining, when the provider reports them. */
  remaining?: number;
  /** Absolute units granted, when the provider reports them. */
  entitlement?: number;
  /** ISO timestamp/date the window resets, when reported. */
  resetsAt?: string;
}

export interface ProviderUsage {
  provider: string;
  fetchedAt: number;
  /** Subscription tier, when the provider reports one ("business", ...). */
  plan?: string;
  windows: UsageWindow[];
}

/** A provider-specific fetcher. Everything network-touching is injectable. */
export interface UsageSource {
  readonly provider: string;
  fetch(): Promise<ProviderUsage>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** "github-copilot" -> "copilot", "opencode-go" -> "opencode". */
export function shortProviderName(provider: string): string {
  if (provider === PROVIDER_COPILOT) return "copilot";
  if (provider === PROVIDER_OPENCODE) return "opencode";
  return provider;
}

// --- GitHub Copilot -------------------------------------------------------

export const COPILOT_QUOTA_URL = "https://api.github.com/copilot_internal/user";

/** Copilot headers, mirroring what the Copilot editor clients send. */
export const COPILOT_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Copilot-Integration-Id": "vscode-chat",
};

/** Display order + short labels for Copilot's quota_snapshots keys. */
const COPILOT_WINDOW_ORDER = ["premium_interactions", "chat", "completions"] as const;
const COPILOT_WINDOW_LABELS: Record<string, string> = {
  premium_interactions: "premium",
  chat: "chat",
  completions: "compl",
};

const COPILOT_WINDOW_SHORT: Record<string, string> = {
  premium_interactions: "prem",
  chat: "chat",
  completions: "comp",
};

/**
 * Normalise the `copilot_internal/user` payload.
 *
 * Kept separate from the fetch so tests can feed recorded payloads. Unknown
 * snapshot keys are still reported (labelled with their raw key) rather than
 * dropped, so a new quota type shows up instead of silently disappearing.
 */
export function parseCopilotQuota(payload: unknown): { windows: UsageWindow[]; plan?: string } {
  const root = asRecord(payload);
  if (!root) return { windows: [] };

  const snapshots = asRecord(root.quota_snapshots) ?? {};
  const resetDate = typeof root.quota_reset_date === "string" ? root.quota_reset_date : undefined;
  const unlimitedDefault = root.copilot_plan === "business" || root.copilot_plan === "enterprise";

  const keys = [
    ...COPILOT_WINDOW_ORDER.filter((key) => key in snapshots),
    ...Object.keys(snapshots).filter((key) => !(COPILOT_WINDOW_ORDER as readonly string[]).includes(key)),
  ];

  const windows: UsageWindow[] = [];
  for (const key of keys) {
    const snap = asRecord(snapshots[key]);
    if (!snap) continue;
    // has_quota === false means this bucket is not part of the plan at all.
    if (snap.has_quota === false) continue;

    const unlimited = snap.unlimited === true || (snap.unlimited === undefined && unlimitedDefault && key !== "premium_interactions");
    const percentRemaining = asNumber(snap.percent_remaining);
    const remaining = asNumber(snap.remaining) ?? asNumber(snap.quota_remaining);
    const entitlement = asNumber(snap.entitlement);

    // Derive from the absolute numbers when the percentage is missing.
    let remainingPercent = 100;
    if (!unlimited) {
      if (percentRemaining !== undefined) {
        remainingPercent = percentRemaining;
      } else if (remaining !== undefined && entitlement !== undefined && entitlement > 0) {
        remainingPercent = (remaining / entitlement) * 100;
      }
    }

    windows.push({
      key,
      label: COPILOT_WINDOW_LABELS[key] ?? key,
      ...(COPILOT_WINDOW_SHORT[key] !== undefined ? { shortLabel: COPILOT_WINDOW_SHORT[key] } : {}),
      remainingPercent: clampPercent(remainingPercent),
      unlimited,
      ...(remaining !== undefined ? { remaining } : {}),
      ...(entitlement !== undefined ? { entitlement } : {}),
      ...(resetDate !== undefined && key === "premium_interactions" ? { resetsAt: resetDate } : {}),
    });
  }

  const plan = typeof root.copilot_plan === "string" ? root.copilot_plan : undefined;
  return { windows, plan };
}

/** Read the GitHub OAuth token Copilot quota authenticates with. */
export function readCopilotRefreshToken(authPath?: string): string | undefined {
  const path = authPath ?? join(homedir(), ".pi", "agent", "auth.json");
  if (!existsSync(path)) return undefined;
  try {
    const auth = asRecord(JSON.parse(readFileSync(path, "utf-8")));
    const credential = asRecord(auth?.[PROVIDER_COPILOT]);
    const refresh = credential?.refresh;
    return typeof refresh === "string" && refresh.length > 0 ? refresh : undefined;
  } catch {
    return undefined;
  }
}

export interface CopilotUsageOptions {
  authPath?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export async function fetchCopilotUsage(options: CopilotUsageOptions = {}): Promise<ProviderUsage> {
  const now = options.now ?? Date.now;
  const token = readCopilotRefreshToken(options.authPath);
  if (!token) {
    throw new Error(`No ${PROVIDER_COPILOT} OAuth token in auth.json — run /login ${PROVIDER_COPILOT}.`);
  }

  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(COPILOT_QUOTA_URL, {
    headers: { ...COPILOT_HEADERS, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  if (!response.ok) {
    // 403 is GitHub's documented rate-limit status; 429 is the generic one.
    const retryAfterMs = response.status === 429 || response.status === 403
      ? parseRetryAfterMs(response.headers, now())
      : undefined;
    const message = `Copilot quota returned ${response.status} ${response.statusText}`;
    throw retryAfterMs !== undefined
      ? new UsageRateLimitError(message, retryAfterMs)
      : new Error(message);
  }

  const { windows, plan } = parseCopilotQuota(await response.json());
  return { provider: PROVIDER_COPILOT, fetchedAt: now(), windows, ...(plan ? { plan } : {}) };
}

// --- OpenCode Go ----------------------------------------------------------

export interface OpenCodeUsageOptions {
  /** Injected in tests; defaults to resolveActiveKey + fetchQuota. */
  resolveKey?: () => Promise<{ key: string; source: string } | undefined>;
  fetchQuotaImpl?: (resolved: { key: string; source: string }) => Promise<Array<{ key: string; label: string; percent: number; resetsAt?: string }>>;
  now?: () => number;
}

/** Convert a used-percent window to the remaining-percent model. */
export function remainingFromUsed(percentUsed: number): number {
  return clampPercent(100 - percentUsed);
}

/** Abbreviations for the footer; OpenCode reports rolling/weekly/monthly. */
const OPENCODE_WINDOW_SHORT: Record<string, string> = {
  rolling: "roll",
  weekly: "wk",
  monthly: "mo",
};

export async function fetchOpenCodeUsage(options: OpenCodeUsageOptions = {}): Promise<ProviderUsage> {
  const now = options.now ?? Date.now;
  const resolveKey = options.resolveKey ?? (async () => {
    const resolved = await resolveActiveKey(defaultOpenCodePaths().authPath);
    return resolved ? { key: resolved.key, source: resolved.source } : undefined;
  });
  const quota = options.fetchQuotaImpl ?? ((resolved) => fetchQuota(resolved));

  const resolved = await resolveKey();
  if (!resolved) {
    throw new Error(`No ${PROVIDER_OPENCODE} API key found — run /login ${PROVIDER_OPENCODE}.`);
  }

  const windows = (await quota(resolved)).map((window) => {
    const shortLabel = OPENCODE_WINDOW_SHORT[window.key];
    return {
      key: window.key,
      label: window.label,
      ...(shortLabel !== undefined ? { shortLabel } : {}),
      remainingPercent: remainingFromUsed(window.percent),
      unlimited: false,
      ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
    };
  });

  return { provider: PROVIDER_OPENCODE, fetchedAt: now(), windows };
}

// --- Selection ------------------------------------------------------------

/**
 * The window that actually constrains you: the metered one with the least
 * remaining. Unlimited windows are ignored; if every window is unlimited the
 * first is returned so the caller can still render "unlimited".
 */
export function bindingWindow(windows: readonly UsageWindow[]): UsageWindow | undefined {
  const metered = windows.filter((window) => !window.unlimited);
  if (metered.length === 0) return windows[0];
  return metered.reduce((worst, window) =>
    window.remainingPercent < worst.remainingPercent ? window : worst,
  );
}

/**
 * Compact footer text covering EVERY window: "roll 100% · wk 80% · mo 44%".
 *
 * Reporting only the binding window reads as "44% of what?" — a plan meters
 * several buckets at once, and which one is tightest changes as time passes
 * (OpenCode's rolling bucket recovers hourly while monthly barely moves). The
 * label travels with the number so each value is self-describing, and the
 * segment stays honest when the binding bucket flips.
 *
 * Unlimited buckets print "∞" rather than a percentage, because "chat 100%"
 * would imply a limit that is about to run out.
 */
export function formatUsageLimit(windows: readonly UsageWindow[]): string {
  if (windows.length === 0) return "—";
  return windows
    .map((window) => {
      const name = window.shortLabel ?? window.label;
      return window.unlimited ? `${name} ∞` : `${name} ${Math.round(window.remainingPercent)}%`;
    })
    .join(" · ");
}

/** Longer form for /provider output: "premium 63% (31929/50000, resets 2026-12-01)". */
export function describeWindow(window: UsageWindow): string {
  const head = `${window.label} ${Math.round(window.remainingPercent)}%`;
  if (window.unlimited) return `${window.label} unlimited`;
  const parts: string[] = [];
  if (window.remaining !== undefined && window.entitlement !== undefined && window.entitlement > 0) {
    parts.push(`${Math.round(window.remaining)}/${Math.round(window.entitlement)}`);
  }
  if (window.resetsAt) parts.push(`resets ${window.resetsAt}`);
  return parts.length > 0 ? `${head} (${parts.join(", ")})` : head;
}

// --- Cache ----------------------------------------------------------------

/**
 * Thrown by a source when the provider says "slow down". Carries how long to
 * wait so the cache can honour the provider's own window instead of guessing.
 * Parsed from Retry-After or x-ratelimit-reset by fetchCopilotUsage.
 */
export class UsageRateLimitError extends Error {
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
    this.name = "UsageRateLimitError";
  }
}

/**
 * Default freshness window. Deliberately coarse: quota windows are measured in
 * hours (rolling ~5h) or a month, so a 5-minute-old number is still accurate
 * enough for a footer badge, and the endpoints are rate limited.
 */
export const DEFAULT_USAGE_TTL_MS = 5 * 60_000;
/** Hard floor between any two attempts, whatever the TTL says. */
export const DEFAULT_USAGE_MIN_INTERVAL_MS = 60_000;
/** Cap for exponential backoff after failures. */
export const DEFAULT_USAGE_MAX_BACKOFF_MS = 60 * 60_000;

/**
 * Parse a rate-limit delay from response headers. Supports Retry-After
 * (seconds or HTTP date) and x-ratelimit-reset (epoch seconds, GitHub style).
 * Returns undefined when the response says nothing useful.
 */
export function parseRetryAfterMs(headers: Headers, nowMs: number = Date.now()): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  }

  const reset = headers.get("x-ratelimit-reset");
  if (reset) {
    const epochSeconds = Number.parseFloat(reset);
    if (Number.isFinite(epochSeconds)) return Math.max(0, epochSeconds * 1000 - nowMs);
  }

  return undefined;
}

export interface UsageCacheOptions {
  source: UsageSource;
  /** How long a successful snapshot stays fresh. Default DEFAULT_USAGE_TTL_MS. */
  ttlMs?: number;
  /** Minimum gap between attempts, even when stale. Default 60s. */
  minIntervalMs?: number;
  /** Cap for exponential backoff after failures. Default 1h. */
  maxBackoffMs?: number;
  now?: () => number;
  onUpdate?: (usage: ProviderUsage) => void;
  /** Optional JSON file used to survive process restarts. Best effort. */
  persistPath?: string;
}

interface PersistedUsage {
  usage: ProviderUsage;
  fetchedAtMs: number;
}

/**
 * Last-known-good cache around a UsageSource.
 *
 * The footer renders synchronously, so it can never await a network call. It
 * reads current() and calls ensureFresh(); the cache fetches in the background,
 * keeps the previous value on failure, and never runs two fetches at once.
 *
 * Refresh is deliberately sparse, because both quota endpoints are rate
 * limited and a footer re-renders constantly:
 *
 *   - a 5-minute TTL, so a render loop cannot turn into a request loop;
 *   - a 60s hard floor between attempts regardless of TTL;
 *   - exponential backoff on failure (1m, 2m, 4m ... capped at 1h), so a broken
 *     or offline provider is not retried on every render;
 *   - provider-declared delays (Retry-After / x-ratelimit-reset) win over all
 *     of the above, including an explicit force refresh;
 *   - an optional on-disk snapshot, so restarting pi does not refetch.
 */
export class UsageCache {
  private snapshot: ProviderUsage | undefined;
  private inflight: Promise<ProviderUsage | undefined> | undefined;
  /** Last SUCCESSFUL fetch. */
  private fetchedAtMs = 0;
  /** Last attempt, success or failure. undefined = never attempted. */
  private lastAttemptMs: number | undefined;
  private backoffMs = 0;
  private retryAfterUntilMs = 0;
  private readonly ttlMs: number;
  private readonly minIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly source: UsageSource;
  private readonly onUpdate: ((usage: ProviderUsage) => void) | undefined;
  private readonly listeners = new Set<(usage: ProviderUsage) => void>();
  private readonly persistPath: string | undefined;

  constructor(options: UsageCacheOptions) {
    this.source = options.source;
    this.ttlMs = options.ttlMs ?? DEFAULT_USAGE_TTL_MS;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_USAGE_MIN_INTERVAL_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_USAGE_MAX_BACKOFF_MS;
    this.now = options.now ?? Date.now;
    this.onUpdate = options.onUpdate;
    this.persistPath = options.persistPath;
    this.loadPersisted();
    if (options.onUpdate) this.listeners.add(options.onUpdate);
  }

  /** Notified after every successful fetch. Returns an unsubscribe function. */
  subscribe(listener: (usage: ProviderUsage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get provider(): string {
    return this.source.provider;
  }

  current(): ProviderUsage | undefined {
    return this.snapshot;
  }

  isStale(): boolean {
    return this.snapshot === undefined || this.now() - this.fetchedAtMs >= this.ttlMs;
  }

  /** True when a fetch would be allowed right now. */
  canAttempt(): boolean {
    const now = this.now();
    if (now < this.retryAfterUntilMs) return false;
    // undefined means "never attempted", which must not be confused with a
    // genuine timestamp of 0 (tests run with a zeroed clock).
    if (this.lastAttemptMs !== undefined && now - this.lastAttemptMs < this.minIntervalMs) return false;
    // Backoff only gates retries; a fresh snapshot needs no fetch anyway.
    if (this.backoffMs > 0 && this.lastAttemptMs !== undefined && now - this.lastAttemptMs < this.backoffMs) return false;
    return true;
  }

  /** Kick off a refresh when stale. Safe to call on every render. */
  ensureFresh(): void {
    if (this.inflight || !this.isStale() || !this.canAttempt()) return;
    void this.refresh();
  }

  /**
   * Fetch now. Used by /provider so an interactive request is never stale.
   * force=true skips the TTL and the failure backoff, but NOT a provider-
   * declared rate-limit window: when GitHub says wait, we wait.
   */
  async refresh(options: { force?: boolean } = {}): Promise<ProviderUsage | undefined> {
    if (this.inflight) return this.inflight;

    const now = this.now();
    if (now < this.retryAfterUntilMs) return this.snapshot;
    if (!options.force && !this.canAttempt()) return this.snapshot;
    // A forced refresh still collapses rapid double-invocations.
    if (options.force && this.lastAttemptMs !== undefined && now - this.lastAttemptMs < 1_000) {
      return this.snapshot;
    }

    this.lastAttemptMs = now;
    const run = (async () => {
      try {
        const usage = await this.source.fetch();
        this.snapshot = usage;
        this.fetchedAtMs = this.now();
        this.backoffMs = 0;
        this.retryAfterUntilMs = 0;
        this.savePersisted();
        this.onUpdate?.(usage);
        for (const listener of this.listeners) {
          try {
            listener(usage);
          } catch {
            // A broken listener must not poison a successful fetch.
          }
        }
        return usage;
      } catch (error) {
        if (error instanceof UsageRateLimitError) {
          this.retryAfterUntilMs = this.now() + Math.max(1_000, error.retryAfterMs);
        } else {
          this.backoffMs = this.backoffMs === 0
            ? this.minIntervalMs
            : Math.min(this.maxBackoffMs, this.backoffMs * 2);
        }
        // Keep the last good snapshot; the footer shows it rather than nothing.
        return this.snapshot;
      } finally {
        this.inflight = undefined;
      }
    })();
    this.inflight = run;
    return run;
  }

  private loadPersisted(): void {
    if (!this.persistPath) return;
    try {
      if (!existsSync(this.persistPath)) return;
      const raw = asRecord(JSON.parse(readFileSync(this.persistPath, "utf-8")));
      const usage = asRecord(raw?.usage);
      const fetchedAtMs = asNumber(raw?.fetchedAtMs);
      if (!usage || fetchedAtMs === undefined) return;
      if (usage.provider !== this.source.provider) return;
      this.snapshot = usage as unknown as ProviderUsage;
      this.fetchedAtMs = fetchedAtMs;
    } catch {
      // A corrupt cache file must never break startup.
    }
  }

  private savePersisted(): void {
    if (!this.persistPath || !this.snapshot) return;
    try {
      const payload: PersistedUsage = { usage: this.snapshot, fetchedAtMs: this.fetchedAtMs };
      writeFileSync(this.persistPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    } catch {
      // Best effort: an unwritable cache dir is not a reason to fail a render.
    }
  }
}

// --- Shared registry ------------------------------------------------------

/**
 * One cache per provider for the whole process.
 *
 * Both the footer (on every render) and /provider (on demand) must read the same
 * snapshot; two independent caches would double the request rate against
 * endpoints that are already rate limited, and could disagree on screen.
 */
const sharedCaches = new Map<string, UsageCache>();

export function createUsageSource(provider: string): UsageSource | undefined {
  if (provider === PROVIDER_COPILOT) {
    return { provider: PROVIDER_COPILOT, fetch: () => fetchCopilotUsage() };
  }
  if (provider === PROVIDER_OPENCODE) {
    return { provider: PROVIDER_OPENCODE, fetch: () => fetchOpenCodeUsage() };
  }
  return undefined;
}

/** Default on-disk cache location, so a pi restart does not refetch immediately. */
export function defaultUsageCachePath(provider: string): string {
  return join(homedir(), ".pi", "agent", `usage-cache-${provider}.json`);
}

/**
 * Get (or lazily create) the shared cache for a provider.
 * Returns undefined for providers this module cannot report on, so callers can
 * skip the segment entirely rather than render a permanently empty one.
 */
export function getSharedUsageCache(provider: string | undefined): UsageCache | undefined {
  if (!provider) return undefined;
  const existing = sharedCaches.get(provider);
  if (existing) return existing;

  const source = createUsageSource(provider);
  if (!source) return undefined;

  const cache = new UsageCache({
    source,
    persistPath: defaultUsageCachePath(provider),
  });
  sharedCaches.set(provider, cache);
  return cache;
}

/** Test seam: drop all shared caches. */
export function resetSharedUsageCaches(): void {
  sharedCaches.clear();
}
