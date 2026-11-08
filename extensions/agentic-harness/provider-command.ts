/**
 * /provider — one command namespace for every subscription provider pi knows
 * how to read usage from.
 *
 *   /provider                      overview: active provider + its quota
 *   /provider list                 which providers are configured
 *   /provider <provider> usage     quota windows (default verb)
 *   /provider <provider> keys      only opencode-go has switchable keys
 *   /provider <provider> key <v>   rotate | use key|key2 | auto on|off | status
 *
 * Provider-specific verbs are delegated rather than reimplemented:
 * `/provider opencode usage` forwards to runOpenCodeUsage and
 * `/provider opencode key rotate` to runOpenCodeKeys, so the legacy
 * /opencode-usage and /opencode-key commands cannot drift from this one.
 *
 * Usage reads go through the shared UsageCache, so opening the panel does not
 * add a second request when the footer already refreshed that provider.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

import { runOpenCodeKeys, runOpenCodeUsage } from "./opencode-usage.js";
import {
  PROVIDER_COPILOT,
  PROVIDER_OPENCODE,
  bindingWindow,
  describeWindow,
  getSharedUsageCache,
  shortProviderName,
  type ProviderUsage,
} from "./provider-usage.js";

const PANEL_TYPE = "provider-usage";

/** Accepted spellings for each provider. */
const PROVIDER_ALIASES: Record<string, string> = {
  opencode: PROVIDER_OPENCODE,
  "opencode-go": PROVIDER_OPENCODE,
  oc: PROVIDER_OPENCODE,
  go: PROVIDER_OPENCODE,
  copilot: PROVIDER_COPILOT,
  "github-copilot": PROVIDER_COPILOT,
  gh: PROVIDER_COPILOT,
  github: PROVIDER_COPILOT,
};

export function resolveProviderAlias(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return PROVIDER_ALIASES[token.trim().toLowerCase()];
}

export interface ProviderPanel {
  title: string;
  lines: string[];
}

function formatAge(fetchedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - fetchedAt) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** Build the body lines shared by every verb. */
export function buildUsageLines(usage: ProviderUsage | undefined, now: number): string[] {
  if (!usage) {
    return ["  (no snapshot yet — refresh pending)"];
  }
  const binding = bindingWindow(usage.windows);
  const lines = [
    `  plan:    ${usage.plan ?? "unknown"}`,
    `  binding: ${binding ? describeWindow(binding) : "no quota reported"}`,
    `  fetched: ${formatAge(usage.fetchedAt, now)}`,
    "",
  ];
  for (const window of usage.windows) {
    lines.push(`  - ${describeWindow(window)}`);
  }
  return lines;
}

function activeProviderId(ctx: ExtensionContext): string | undefined {
  // `model` is present on the extension context but not in older typings.
  const model = (ctx as unknown as { model?: { provider?: string } }).model;
  return model?.provider;
}

async function handleUsage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  provider: string,
  params: string[],
): Promise<void> {
  // opencode-go has richer verbs (ranges, spend) already implemented.
  if (provider === PROVIDER_OPENCODE) {
    await runOpenCodeUsage(pi, params.join(" "), ctx);
    return;
  }

  const cache = getSharedUsageCache(provider);
  if (!cache) {
    ctx.ui.notify(`No usage source for provider "${provider}".`, "error");
    return;
  }

  // Explicit request: skip the TTL, but the cache still honours any
  // provider-declared rate-limit window.
  const usage = await cache.refresh({ force: true });
  const now = Date.now();
  const lines = buildUsageLines(usage, now);
  const title = `${shortProviderName(provider)} usage`;
  pi.sendMessage<ProviderPanel>({
    customType: PANEL_TYPE,
    content: [title, ...lines].join("\n"),
    display: true,
    details: { title, lines },
  });

  if (!usage) {
    ctx.ui.notify(`Could not read ${provider} usage — see the panel for details.`, "error");
  }
}

async function handleOverview(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const active = activeProviderId(ctx);
  const lines: string[] = [];

  lines.push("  providers:");
  for (const provider of Object.values(PROVIDER_ALIASES)) {
    if (provider !== PROVIDER_COPILOT && provider !== PROVIDER_OPENCODE) continue;
    if (lines.some((line) => line.includes(` ${provider}`))) continue;
    const marker = provider === active ? "*" : " ";
    lines.push(`  ${marker} ${provider}`);
  }

  if (active) {
    lines.push("", `  active: ${active}`);
    const cache = getSharedUsageCache(active);
    if (cache) {
      const usage = cache.current();
      // Never block the overview on the network: show what is known and kick a
      // background refresh if it is stale.
      cache.ensureFresh();
      if (usage) {
        lines.push(...buildUsageLines(usage, Date.now()));
      } else {
        lines.push("  (no snapshot yet — refresh pending, re-run in a moment)");
      }
    } else {
      lines.push("  (no usage source for this provider)");
    }
  } else {
    lines.push("", "  active: unknown");
  }

  lines.push("", "  verbs: usage · keys · key rotate|use key2|auto on|off");

  const title = "Provider usage";
  pi.sendMessage<ProviderPanel>({
    customType: PANEL_TYPE,
    content: [title, ...lines].join("\n"),
    display: true,
    details: { title, lines },
  });
}

/** Parse "/provider <provider> <verb> [params]" and dispatch. */
export async function runProviderCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const head = tokens[0]?.toLowerCase();

  if (tokens.length === 0 || head === "list" || head === "ls") {
    await handleOverview(pi, ctx);
    return;
  }

  const provider = resolveProviderAlias(head);
  if (!provider) {
    ctx.ui.notify(
      `Unknown provider "${tokens[0]}". Known: ${[...new Set(Object.values(PROVIDER_ALIASES))].join(", ")}`,
      "error",
    );
    return;
  }

  const verb = tokens[1]?.toLowerCase();
  const params = tokens.slice(2);

  if (!verb || verb === "usage") {
    await handleUsage(pi, ctx, provider, params);
    return;
  }

  if (verb === "key" || verb === "keys") {
    if (provider !== PROVIDER_OPENCODE) {
      ctx.ui.notify(`${provider} has no switchable keys — that is opencode-go only.`, "error");
      return;
    }
    // Delegate so /provider and /opencode-key share one implementation.
    await runOpenCodeKeys(pi, [verb === "key" ? "" : "status", ...params].join(" ").trim(), ctx);
    return;
  }

  ctx.ui.notify(`Unknown verb "${verb}". Try usage, keys, or key.`, "error");
}

const COMPLETION_VERBS = ["usage", "keys", "key", "key rotate", "key auto on", "key auto off"];

export function registerProviderCommand(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<ProviderPanel>(PANEL_TYPE, (message, { outputPad }, theme) => {
    const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
    const panel = message.details;
    if (!panel) {
      box.addChild(new Text(message.content as string, 0, 0));
      return box;
    }
    box.addChild(new Text(theme.bold(panel.title), 0, 0));
    for (const line of panel.lines) {
      box.addChild(new Text(line.length === 0 ? "" : line, 0, 0));
    }
    return box;
  });

  pi.registerCommand("provider", {
    description: "Provider usage and keys: /provider <provider> <verb> [params]",
    getArgumentCompletions: (prefix) => {
      const text = prefix.trim().toLowerCase();
      if (/\s/.test(text)) {
        const [head, ...rest] = text.split(/\s+/);
        const provider = resolveProviderAlias(head);
        if (!provider) return null;
        const tail = rest.join(" ");
        const verbs = provider === PROVIDER_OPENCODE
          ? COMPLETION_VERBS
          : COMPLETION_VERBS.filter((verb) => verb === "usage");
        const matches = verbs.filter((verb) => verb.startsWith(tail) && verb !== tail);
        return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
      }
      const names = [...new Set(Object.keys(PROVIDER_ALIASES))].filter((name) => name.startsWith(text));
      return names.length > 0 ? names.map((value) => ({ value, label: value })) : null;
    },
    handler: (args, ctx) => runProviderCommand(pi, args, ctx),
  });
}
