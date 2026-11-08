import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROVIDER_COPILOT,
  PROVIDER_OPENCODE,
  UsageCache,
  UsageRateLimitError,
  bindingWindow,
  describeWindow,
  fetchOpenCodeUsage,
  formatUsageLimit,
  parseCopilotQuota,
  parseRetryAfterMs,
  remainingFromUsed,
  shortProviderName,
  type ProviderUsage,
  type UsageSource,
  type UsageWindow,
} from "../provider-usage.js";
import { buildUsageLines, resolveProviderAlias } from "../provider-command.js";

/** Recorded shape of api.github.com/copilot_internal/user (business seat). */
const COPILOT_PAYLOAD = {
  copilot_plan: "business",
  access_type_sku: "copilot_for_business_seat_quota",
  quota_reset_date: "2026-12-01",
  quota_snapshots: {
    chat: {
      percent_remaining: 100.0,
      quota_id: "chat",
      unlimited: true,
      has_quota: true,
      remaining: 0,
      entitlement: 0,
    },
    completions: {
      percent_remaining: 100.0,
      quota_id: "completions",
      unlimited: true,
      has_quota: true,
      remaining: 0,
      entitlement: 0,
    },
    premium_interactions: {
      overage_permitted: true,
      percent_remaining: 63.8,
      quota_id: "premium_interactions",
      quota_remaining: 31929.4,
      unlimited: false,
      has_quota: true,
      remaining: 31929,
      entitlement: 50000,
    },
  },
};

function window(overrides: Partial<UsageWindow> = {}): UsageWindow {
  return {
    key: "rolling",
    label: "5h",
    remainingPercent: 100,
    unlimited: false,
    ...overrides,
  };
}

function usage(windows: UsageWindow[]): ProviderUsage {
  return { provider: PROVIDER_OPENCODE, fetchedAt: 0, windows };
}

function sourceOf(fetchImpl: () => Promise<ProviderUsage>): UsageSource {
  return { provider: PROVIDER_OPENCODE, fetch: fetchImpl };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseCopilotQuota", () => {
  it("maps the recorded business-seat payload", () => {
    const { windows, plan } = parseCopilotQuota(COPILOT_PAYLOAD);
    expect(plan).toBe("business");
    expect(windows.map((w) => w.key)).toEqual(["premium_interactions", "chat", "completions"]);

    const premium = windows[0]!;
    expect(premium.label).toBe("premium");
    expect(premium.remainingPercent).toBeCloseTo(63.8);
    expect(premium.unlimited).toBe(false);
    expect(premium.remaining).toBe(31929);
    expect(premium.entitlement).toBe(50000);
    expect(premium.resetsAt).toBe("2026-12-01");

    // Unlimited buckets keep remainingPercent at 100 and are flagged.
    expect(windows[1]!.unlimited).toBe(true);
    expect(windows[1]!.remainingPercent).toBe(100);
  });

  it("drops buckets the plan does not include", () => {
    const { windows } = parseCopilotQuota({
      quota_snapshots: { premium_interactions: { has_quota: false, percent_remaining: 0 } },
    });
    expect(windows).toEqual([]);
  });

  it("falls back to remaining/entitlement when the percentage is absent", () => {
    const { windows } = parseCopilotQuota({
      quota_snapshots: { premium_interactions: { has_quota: true, unlimited: false, remaining: 25, entitlement: 100 } },
    });
    expect(windows[0]!.remainingPercent).toBe(25);
  });

  it("survives junk without throwing", () => {
    expect(parseCopilotQuota(null).windows).toEqual([]);
    expect(parseCopilotQuota("nope").windows).toEqual([]);
    expect(parseCopilotQuota({ quota_snapshots: "nope" }).windows).toEqual([]);
  });

  it("keeps unknown snapshot keys instead of silently dropping them", () => {
    const { windows } = parseCopilotQuota({
      quota_snapshots: { premium_interactions: { has_quota: true, percent_remaining: 50 }, new_thing: { has_quota: true, percent_remaining: 10 } },
    });
    expect(windows.map((w) => w.key)).toContain("new_thing");
  });
});

describe("remaining arithmetic", () => {
  it("converts OpenCode's used-percent to remaining", () => {
    expect(remainingFromUsed(0)).toBe(100);
    expect(remainingFromUsed(14)).toBe(86);
    expect(remainingFromUsed(100)).toBe(0);
    expect(remainingFromUsed(140)).toBe(0);
    expect(remainingFromUsed(-5)).toBe(100);
  });

  it("shortens provider ids", () => {
    expect(shortProviderName(PROVIDER_COPILOT)).toBe("copilot");
    expect(shortProviderName(PROVIDER_OPENCODE)).toBe("opencode");
    expect(shortProviderName("something-else")).toBe("something-else");
  });
});

describe("binding window", () => {
  it("picks the metered window with the least remaining", () => {
    const binding = bindingWindow([window({ remainingPercent: 100 }), window({ key: "monthly", remainingPercent: 47 })]);
    expect(binding?.remainingPercent).toBe(47);
  });

  it("ignores unlimited windows", () => {
    const binding = bindingWindow([
      window({ key: "chat", remainingPercent: 100, unlimited: true }),
      window({ key: "premium", remainingPercent: 63 }),
    ]);
    expect(binding?.key).toBe("premium");
  });

  it("reports unlimited when nothing is metered", () => {
    expect(formatUsageLimit([window({ unlimited: true })])).toBe("5h ∞");
    expect(bindingWindow([window({ unlimited: true })])?.unlimited).toBe(true);
  });

  it("renders a rounded percentage and an em dash for nothing known", () => {
    expect(formatUsageLimit([window({ remainingPercent: 47.4 })])).toBe("5h 47%");
    expect(formatUsageLimit([])).toBe("—");
  });

  it("describes absolute units and reset dates", () => {
    expect(
      describeWindow(
        window({ key: "premium", label: "premium", remainingPercent: 63.8, remaining: 31929, entitlement: 50000, resetsAt: "2026-12-01" }),
      ),
    ).toBe("premium 64% (31929/50000, resets 2026-12-01)");
    expect(describeWindow(window({ key: "chat", label: "chat", unlimited: true }))).toBe("chat unlimited");
  });
});

describe("parseRetryAfterMs", () => {
  it("reads Retry-After seconds", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "120" }), 0)).toBe(120_000);
  });

  it("reads Retry-After as an HTTP date", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const headers = new Headers({ "retry-after": "Thu, 01 Jan 2026 00:05:00 GMT" });
    expect(parseRetryAfterMs(headers, now)).toBe(300_000);
  });

  it("reads x-ratelimit-reset epoch seconds", () => {
    expect(parseRetryAfterMs(new Headers({ "x-ratelimit-reset": "1000" }), 1_000_000)).toBe(0);
    expect(parseRetryAfterMs(new Headers({ "x-ratelimit-reset": "1" }), 0)).toBe(1000);
  });

  it("returns undefined when the response says nothing", () => {
    expect(parseRetryAfterMs(new Headers(), 0)).toBeUndefined();
  });
});

describe("UsageCache refresh policy", () => {
  it("keeps a fresh snapshot instead of refetching on every call", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => usage([window()]));
    const cache = new UsageCache({ source: sourceOf(fetchImpl), now: () => now, persistPath: undefined });

    cache.ensureFresh();
    await cache.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Well inside the 5-minute TTL: no further requests however often we ask.
    for (let i = 0; i < 50; i++) {
      cache.ensureFresh();
      await Promise.resolve();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refetches once the TTL has elapsed", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => usage([window()]));
    const cache = new UsageCache({ source: sourceOf(fetchImpl), now: () => now, ttlMs: 1000, minIntervalMs: 0 });

    await cache.refresh();
    now = 1001;
    await cache.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("enforces the minimum interval between attempts", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => usage([window()]));
    const cache = new UsageCache({ source: sourceOf(fetchImpl), now: () => now, ttlMs: 1000, minIntervalMs: 60_000 });

    await cache.refresh();
    now = 2000; // stale by TTL, but inside the floor
    expect(cache.canAttempt()).toBe(false);
    await cache.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now = 62_000;
    expect(cache.canAttempt()).toBe(true);
    await cache.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("backs off exponentially after failures", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    const cache = new UsageCache({ source: sourceOf(fetchImpl), now: () => now, minIntervalMs: 60_000, ttlMs: 0 });

    await cache.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // First failure sets a 60s backoff; a second failure doubles it.
    now = 60_001;
    await cache.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    now = 60_001 + 60_000;
    expect(cache.canAttempt()).toBe(false);
    now = 60_001 + 120_001;
    expect(cache.canAttempt()).toBe(true);
  });

  it("honours a provider-declared rate limit, even for a forced refresh", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => {
      throw new UsageRateLimitError("slow down", 300_000);
    });
    const cache = new UsageCache({ source: sourceOf(fetchImpl), now: () => now, minIntervalMs: 0, ttlMs: 0 });

    await cache.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now = 1000;
    await cache.refresh({ force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // still waiting out the 5m window

    now = 300_001;
    await cache.refresh({ force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good snapshot when a refresh fails", async () => {
    let now = 0;
    let shouldFail = false;
    const fetchImpl = vi.fn(async () => {
      if (shouldFail) throw new Error("network down");
      return usage([window({ remainingPercent: 42 })]);
    });
    const cache = new UsageCache({ source: sourceOf(fetchImpl), now: () => now, ttlMs: 0, minIntervalMs: 0 });

    await cache.refresh();
    shouldFail = true;
    now = 1000;
    const after = await cache.refresh();
    expect(after?.windows[0]?.remainingPercent).toBe(42);
    expect(cache.current()?.windows[0]?.remainingPercent).toBe(42);
  });

  it("never runs two fetches at once", async () => {
    let release: (() => void) | undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<ProviderUsage>((resolve) => {
          release = () => resolve(usage([window()]));
        }),
    );
    const cache = new UsageCache({ source: sourceOf(fetchImpl), now: () => 0 });

    const first = cache.refresh();
    const second = cache.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release?.();
    await Promise.all([first, second]);
  });

  it("notifies subscribers after a successful fetch", async () => {
    const seen: number[] = [];
    const cache = new UsageCache({ source: sourceOf(async () => usage([window({ remainingPercent: 88 })])), now: () => 0 });
    const unsubscribe = cache.subscribe((snapshot) => seen.push(snapshot.windows[0]!.remainingPercent));

    await cache.refresh();
    expect(seen).toEqual([88]);

    unsubscribe();
    await cache.refresh({ force: true });
    expect(seen).toEqual([88]);
  });

  it("survives a restart by loading the persisted snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-cache-"));
    try {
      const persistPath = join(dir, "cache.json");
      const writer = new UsageCache({
        source: sourceOf(async () => usage([window({ remainingPercent: 61 })])),
        now: () => 1234,
        persistPath,
      });
      await writer.refresh();

      const fetchImpl = vi.fn(async () => usage([window({ remainingPercent: 0 })]));
      const reader = new UsageCache({ source: sourceOf(fetchImpl), now: () => 1300, persistPath });
      expect(reader.current()?.windows[0]?.remainingPercent).toBe(61);
      // Still inside the 5-minute TTL, so the restored snapshot is reused and no
      // request is made on startup.
      reader.ensureFresh();
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a persisted snapshot belonging to a different provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-cache-"));
    try {
      const persistPath = join(dir, "cache.json");
      const cache = new UsageCache({
        source: sourceOf(async () => usage([window()])),
        now: () => 0,
        persistPath,
      });
      void cache.refresh();

      const other = new UsageCache({
        source: { provider: PROVIDER_COPILOT, fetch: async () => ({ provider: PROVIDER_COPILOT, fetchedAt: 0, windows: [] }) },
        now: () => 0,
        persistPath,
      });
      expect(other.current()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("/provider command surface", () => {
  it("accepts aliases for both providers", () => {
    expect(resolveProviderAlias("oc")).toBe(PROVIDER_OPENCODE);
    expect(resolveProviderAlias("OpenCode-Go")).toBe(PROVIDER_OPENCODE);
    expect(resolveProviderAlias("gh")).toBe(PROVIDER_COPILOT);
    expect(resolveProviderAlias("Copilot")).toBe(PROVIDER_COPILOT);
    expect(resolveProviderAlias("nope")).toBeUndefined();
    expect(resolveProviderAlias(undefined)).toBeUndefined();
  });

  it("renders usage lines with plan, binding window and age", () => {
    const lines = buildUsageLines(
      { provider: PROVIDER_COPILOT, fetchedAt: 0, plan: "business", windows: [window({ key: "premium", label: "premium", remainingPercent: 63.8, remaining: 31929, entitlement: 50000, resetsAt: "2026-12-01" })] },
      120_000,
    );
    const text = lines.join("\n");
    expect(text).toContain("plan:    business");
    expect(text).toContain("binding: premium 64%");
    expect(text).toContain("fetched: 2m ago");
  });

  it("says so when there is no snapshot yet", () => {
    expect(buildUsageLines(undefined, 0).join("\n")).toContain("no snapshot yet");
  });
});

describe("formatUsageLimit window labels", () => {
  it("names the window so a percentage is never ambiguous", () => {
    expect(formatUsageLimit([window({ shortLabel: "mo", remainingPercent: 47.4 })])).toBe("mo 47%");
  });

  it("lists every window, not just the tightest one", () => {
    const windows = [
      window({ key: "rolling", label: "rolling", shortLabel: "roll", remainingPercent: 90 }),
      window({ key: "weekly", label: "weekly", shortLabel: "wk", remainingPercent: 81 }),
      window({ key: "monthly", label: "monthly", shortLabel: "mo", remainingPercent: 45 }),
    ];
    expect(formatUsageLimit(windows)).toBe("roll 90% · wk 81% · mo 45%");
  });

  it("marks unlimited buckets instead of implying they are about to run out", () => {
    const windows = [
      window({ key: "premium_interactions", shortLabel: "prem", remainingPercent: 64 }),
      window({ key: "chat", shortLabel: "chat", unlimited: true }),
    ];
    expect(formatUsageLimit(windows)).toBe("prem 64% · chat ∞");
  });

  it("falls back to the long label when no abbreviation exists", () => {
    expect(formatUsageLimit([window({ label: "daily", remainingPercent: 47.4 })])).toBe("daily 47%");
  });
});

describe("fetchOpenCodeUsage", () => {
  it("converts used-percent to remaining and tags every window", async () => {
    const result = await fetchOpenCodeUsage({
      resolveKey: async () => ({ key: "test-key", source: "auth.json" }),
      fetchQuotaImpl: async () => [
        { key: "rolling", label: "rolling", percent: 10 },
        { key: "weekly", label: "weekly", percent: 20 },
        { key: "monthly", label: "monthly", percent: 55, resetsAt: "2026-11-13T04:09:09.000Z" },
      ],
    });

    expect(result.provider).toBe(PROVIDER_OPENCODE);
    expect(result.windows.map((w) => [w.key, w.remainingPercent, w.shortLabel])).toEqual([
      ["rolling", 90, "roll"],
      ["weekly", 80, "wk"],
      ["monthly", 45, "mo"],
    ]);
    expect(result.windows[2]?.resetsAt).toBe("2026-11-13T04:09:09.000Z");
    expect(formatUsageLimit(result.windows)).toBe("roll 90% · wk 80% · mo 45%");
  });

  it("keeps an unknown window key usable, just unlabelled", async () => {
    const result = await fetchOpenCodeUsage({
      resolveKey: async () => ({ key: "test-key", source: "auth.json" }),
      fetchQuotaImpl: async () => [{ key: "daily", label: "daily", percent: 4 }],
    });

    expect(result.windows[0]?.shortLabel).toBeUndefined();
    expect(formatUsageLimit(result.windows)).toBe("daily 96%");
  });

  it("explains a missing credential instead of returning empty windows", async () => {
    await expect(fetchOpenCodeUsage({ resolveKey: async () => undefined })).rejects.toThrow(/No opencode-go API key/);
  });
});
