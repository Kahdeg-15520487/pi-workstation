import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WorkstationFooter, type CacheStats, type ActiveTools, type ActiveToolStatus } from "./footer.js";
import { resolveAgenticUiSettings } from "./ui-settings.js";
import { shimmerText, type ShimmerPalette } from "./shimmer.js";
import { registerWelcomeCommand } from "./welcome-ui.js";
import { registerEditorStashCommands } from "./editor-stash.js";
import { installEditorComposition } from "./editor-composition.js";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { renderWebfetchCall, renderWebfetchResult } from "./webfetch/render.js";
import { readFile, writeFile, mkdir } from "fs/promises";
import { microcompactMessages, getCompactionPrompt, formatCompactSummary } from "./compaction.js";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";
import {
  defaultHarnessStateRoot,
  harnessStateSnapshotPath,
  readHarnessStateSnapshot,
  writeHarnessStateSnapshot,
  createHarnessStateSnapshot,
} from "./harness-storage.js";
import {
  extractHarnessReplayEventsFromSessionEntries,
  restoreHarnessStateFromSnapshotAndEvents,
} from "./harness-events.js";
import { createHarnessState, type HarnessState } from "./harness-state.js";
import { fetchUrlToMarkdown } from "./webfetch/utils.js";
import { registerHarnessTools } from "./harness-tools.js";
import { HarnessProgressProvider } from "./harness-progress.js";
import { restoreTodosFromBranchEntries } from "./simple-todo.js";
import { installUnhandledRejectionGuard } from "./unhandled-rejection-guard.js";
import { execFile } from "child_process";
import { promisify } from "util";
import type { GitStats, ModelInfo } from "./footer.js";

const execFileAsync = promisify(execFile);

const cacheStats: CacheStats = { totalInput: 0, totalCacheRead: 0, lastInput: 0, lastCacheRead: 0 };
const activeTools: ActiveTools = { running: new Map() };

async function computeGitStats(cwd: string): Promise<GitStats> {
  const result: GitStats = { ahead: 0, behind: 0, dirty: 0, untracked: 0 };

  try {
    const { stdout: abStdout } = await execFileAsync(
      "git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      { cwd, encoding: "utf-8", timeout: 3000 }
    );
    const parts = abStdout.trim().split("\t");
    if (parts.length === 2) {
      result.behind = Number(parts[0]) || 0;
      result.ahead = Number(parts[1]) || 0;
    }
  } catch {
    // No upstream or not a git repo
  }

  try {
    const { stdout: stStdout } = await execFileAsync(
      "git", ["status", "--porcelain"],
      { cwd, encoding: "utf-8", timeout: 3000 }
    );
    const lines = stStdout.trim().split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      if (line.startsWith("??")) {
        result.untracked++;
      } else {
        result.dirty++;
      }
    }
  } catch {
    // Not a git repo
  }

  return result;
}

function getModelInfo(ctx: any): ModelInfo {
  const model = ctx.model;
  if (!model) return { name: "no model", isLatest: false };

  const available = ctx.modelRegistry.getAvailable();
  const sameProvider = available.filter((m: any) => m.provider === model.provider);
  if (sameProvider.length === 0) return { name: model.name, isLatest: false };

  // Sort by contextWindow descending; highest is considered "latest" flagship
  sameProvider.sort((a: any, b: any) => b.contextWindow - a.contextWindow);
  const isLatest = sameProvider[0].id === model.id;

  return { name: model.name, isLatest };
}

const MICROCOMPACTION_ENV = "PI_AGENTIC_MICROCOMPACTION";

function isMicrocompactionEnabled(): boolean {
  return process.env[MICROCOMPACTION_ENV] === "1";
}

// Track running tool calls for footer/shimmer UI.
let harnessProgress: HarnessProgressProvider | null = null;
const WORKING_SHIMMER_INTERVAL_MS = 80;
const WORKING_BASE_MESSAGE = "Working…";
const WORKING_SHIMMER_PALETTE: ShimmerPalette = {
  low: "dim",
  mid: "accent",
  high: "warning",
  bold: true,
};
const WORKING_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let workingUiContext: any | null = null;
let workingMessageBase = WORKING_BASE_MESSAGE;
let workingMessageTimer: ReturnType<typeof setInterval> | null = null;

function formatToolIntent(toolName: string, intent: unknown): string | undefined {
  if (typeof intent === "string" && intent.trim().length > 0) return intent.trim();
  return undefined;
}

function currentWorkingBaseMessage(activeTools: ActiveTools): string {
  const tools = [...activeTools.running.values()]
    .map((value) => typeof value === "string" ? { name: value, startedAt: 0 } : value)
    .sort((a, b) => b.startedAt - a.startedAt);
  const current = tools.find((tool) => tool.intent && tool.intent.trim().length > 0) ?? tools[0];
  return current?.intent?.trim() || current?.name || WORKING_BASE_MESSAGE;
}

function applyWorkingMessageFrame(ctx: any): void {
  if (!ctx?.ui?.setWorkingMessage || !ctx?.ui?.theme) return;
  ctx.ui.setWorkingMessage(shimmerText(workingMessageBase, ctx.ui.theme, WORKING_SHIMMER_PALETTE));
}

function configureWorkingIndicator(ctx: any): void {
  if (!ctx?.ui?.setWorkingIndicator || !ctx?.ui?.theme) return;
  ctx.ui.setWorkingIndicator({
    frames: WORKING_SPINNER_FRAMES.map((frame) => ctx.ui.theme.fg("accent", frame)),
    intervalMs: WORKING_SHIMMER_INTERVAL_MS,
  });
}

function startWorkingMessageShimmer(ctx: any): void {
  workingUiContext = ctx;
  configureWorkingIndicator(ctx);
  applyWorkingMessageFrame(ctx);
  if (workingMessageTimer) return;
  workingMessageTimer = setInterval(() => {
    if (workingUiContext) applyWorkingMessageFrame(workingUiContext);
  }, WORKING_SHIMMER_INTERVAL_MS);
}

function stopWorkingMessageShimmer(): void {
  if (workingMessageTimer) {
    clearInterval(workingMessageTimer);
    workingMessageTimer = null;
  }
  if (workingUiContext?.ui?.setWorkingMessage) workingUiContext.ui.setWorkingMessage();
  workingUiContext = null;
  workingMessageBase = WORKING_BASE_MESSAGE;
}

function refreshWorkingMessageFromTools(ctx: any, activeTools: ActiveTools): void {
  workingMessageBase = currentWorkingBaseMessage(activeTools);
  if (workingUiContext || activeTools.running.size > 0) startWorkingMessageShimmer(ctx);
}
function preferTodoSurfaceTools(pi: any): void {
  try {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {
      return;
    }
    const active = pi.getActiveTools();
    if (!Array.isArray(active)) return;
    pi.setActiveTools(active.filter((name: string) => name !== "harness_plan" && name !== "harness_todo"));
  } catch {
    // Ignore "Extension runtime not initialized" errors during early loading.
    // Will be retried on session_start.
  }
}

export default function (pi: ExtensionAPI) {
  installUnhandledRejectionGuard();
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const BUNDLED_SKILLS_DIR = join(__dirname, "skills");

  const DIRECT_INPUT_OPTION = "Enter custom response";


  const QuestionItem = Type.Object({
    question: Type.String({
      description: "The question to ask the user.",
    }),
    choices: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Multiple choice options. 'Enter custom response' is auto-appended. Omit for free-text input.",
      })
    ),
    placeholder: Type.Optional(
      Type.String({
        description: "Placeholder hint for free-text input mode.",
      })
    ),
    defaultValue: Type.Optional(
      Type.String({
        description: "Default value if user presses Enter without typing.",
      })
    ),
  });

  const AskUserQuestionParams = Type.Object({
    question: Type.Optional(Type.String({
      description: "The question to ask the user. The agent generates this dynamically based on context. Use this for a single question, or use 'questions' for multiple.",
    })),
    choices: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Multiple choice options generated by the agent. 'Enter custom response' is auto-appended. Omit for free-text input.",
      })
    ),
    placeholder: Type.Optional(
      Type.String({
        description: "Placeholder hint for free-text input mode.",
      })
    ),
    defaultValue: Type.Optional(
      Type.String({
        description: "Default value if user presses Enter without typing.",
      })
    ),
    questions: Type.Optional(
      Type.Array(QuestionItem, {
        description:
          "Array of questions to ask in sequence within a single tool call. Each item has its own question, choices, placeholder, and defaultValue. Use this to batch multiple related questions.",
      })
    ),
  });

  // Helper to ask a single question via UI and return the answer.
  const askSingleQuestion = async (
    q: { question: string; choices?: string[]; placeholder?: string; defaultValue?: string },
    signal: AbortSignal | undefined,
    ctx: any,
  ): Promise<string | undefined> => {
    const { question, choices, placeholder, defaultValue } = q;
    let answer: string | undefined;

    if (choices && choices.length > 0) {
      const withDirect = choices.includes(DIRECT_INPUT_OPTION)
        ? choices
        : [...choices, DIRECT_INPUT_OPTION];

      answer = await ctx.ui.select(question, withDirect, { signal });

      if (answer === DIRECT_INPUT_OPTION) {
        answer = await ctx.ui.input(question, placeholder || defaultValue, {
          signal,
        });
      }
    } else {
      answer = await ctx.ui.input(question, placeholder || defaultValue, {
        signal,
      });
    }

    return answer;
  };

  pi.registerTool({
        name: "ask_user_question",
        label: "Ask User Question",
        description:
          "Ask the user a question when the agent needs clarification. The agent composes the question and optional choices dynamically. Returns the user's answer as text. Supports a single question or multiple questions in one call via the 'questions' array.",
        promptSnippet:
          "Ask the user a clarifying question with optional multiple-choice answers",
        promptGuidelines: [
          "Use ask_user_question whenever you encounter ambiguity, unclear scope, or need user preference.",
          "Generate the question and choices yourself based on the current context — do not rely on predefined templates.",
          "Offer concrete choices (A/B/C style) when the options are enumerable. Omit choices for open-ended questions.",
          "Ask one focused question at a time, or use the 'questions' array to batch multiple related questions in a single call.",
          "After receiving an answer, decide whether further clarification is needed or proceed with the task.",
        ],
        parameters: AskUserQuestionParams,
        execute: async (toolCallId, params, signal, onUpdate, ctx) => {
          const { question, choices, placeholder, defaultValue, questions } = params;

          // Format a single Q&A entry, including choices if present.
          const formatQA = (q: string, a: string, ch?: string[]): string => {
            let out = `Q: ${q}`;
            if (ch && ch.length > 0) {
              out += `\nChoices:\n${ch.map((c) => `\t- ${c}`).join("\n")}`;
            }
            out += `\nA: ${a}`;
            return out;
          };

          // Multi-question mode: ask each question in sequence, collect all answers.
          if (questions && questions.length > 0) {
            const entries: string[] = [];

            for (const q of questions) {
              const answer = await askSingleQuestion(q, signal, ctx);
              if (answer === undefined) {
                entries.push(formatQA(q.question, "[cancelled]", q.choices));
                return {
                  content: [{ type: "text", text: entries.join("\n\n") + "\n\n(User cancelled — remaining questions skipped.)" }],
                  details: undefined,
                };
              }
              entries.push(formatQA(q.question, answer, q.choices));
            }

            return {
              content: [{ type: "text", text: entries.join("\n\n") }],
              details: undefined,
            };
          }

          // Single-question mode (backward compatible).
          if (!question) {
            return {
              content: [{ type: "text", text: "Error: either 'question' or 'questions' must be provided." }],
              details: undefined,
            };
          }

          const answer = await askSingleQuestion({ question, choices, placeholder, defaultValue }, signal, ctx);

          if (answer === undefined) {
            return {
              content: [{ type: "text", text: formatQA(question, "[cancelled]", choices) + "\n\n(User cancelled the question.)" }],
              details: undefined,
            };
          }

          return {
            content: [{ type: "text", text: formatQA(question, answer, choices) }],
            details: undefined,
          };
        },
      });

  const WebFetchParams = Type.Object({
    url: Type.String({
      description: "The URL to fetch and convert to Markdown",
    }),
    raw: Type.Optional(
      Type.Boolean({
        description:
          "Convert the full HTML page to Markdown without filtering",
        default: false,
      }),
    ),
    includeScripts: Type.Optional(
      Type.Boolean({
        description:
          "Include <script> and <style> tag content in the output. Default: false (stripped)",
        default: false,
      }),
    ),
    maxLength: Type.Optional(
      Type.Number({
        description:
          "Maximum number of characters to return. Content beyond this limit is truncated.",
      }),
    ),
  });

  pi.registerTool({
    name: "webfetch",
    label: "WebFetch",
    description:
      "Fetch a URL and convert its HTML content to clean Markdown. Uses Turndown + GFM for Markdown conversion. Results are cached for 15 minutes.",
    promptSnippet: "Fetch a URL and convert to Markdown",
    promptGuidelines: [
      "Use webfetch to retrieve and read web pages, documentation, or any URL content.",
      "Script and style tags are stripped by default. Use includeScripts: true when you need CSS/JS source code.",
      "Use raw: true when you need the full HTML page converted without any filtering.",
      "Use maxLength to limit output size for very large pages.",
      "Results are cached for 15 minutes — repeated requests for the same URL return instantly.",
    ],
    parameters: WebFetchParams,

    renderCall: (args, theme) => renderWebfetchCall(args, theme),
    renderResult: (result, { expanded }, theme) =>
      renderWebfetchResult(result, expanded, theme),

    execute: async (toolCallId, params, signal, _onUpdate, _ctx) => {
      const { url, raw, maxLength, includeScripts } = params;
      try {
        const { content, details } = await fetchUrlToMarkdown(url, {
          raw,
          maxLength,
          includeScripts,
          signal,
        });
        return {
          content: [{ type: "text" as const, text: content }],
          details,
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching ${url}: ${message}`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }
    },
  });

  registerHarnessTools(pi);
  // Try now (may fail if runtime not initialized — caught and retried on session_start)
  preferTodoSurfaceTools(pi);

  pi.on("session_shutdown", async (_event, _ctx) => {
    stopWorkingMessageShimmer();
    harnessProgress = null;
  });

  pi.on("resources_discover", async (_event, _ctx) => {
    return {
      skillPaths: [BUNDLED_SKILLS_DIR],
    };
  });

  // Progress tracking — always injected into system prompt.
  // The structured todo state drives real-time footer progress.
  const PROGRESS_TRACKING_RULES = [
    "\n\n## Progress Tracking (NON-NEGOTIABLE)",
    "",
    "1. **todoread before status changes**: Read the current todo state before changing task status.",
    "2. **todowrite immediately after progress**: Update todos as soon as task progress changes. Never defer to later.",
    "",
    "**Why**: The footer reads structured todo state for progress.",
  ].join("\n");

  pi.on("before_agent_start", async (event, ctx) => {
    workingMessageBase = currentWorkingBaseMessage(activeTools);
    startWorkingMessageShimmer(ctx);

    return {
      systemPrompt: event.systemPrompt + PROGRESS_TRACKING_RULES,
    };
  });

  pi.on("context", async (event, _ctx) => {
    if (!isMicrocompactionEnabled()) return;

    const compacted = microcompactMessages(event.messages);
    const changed = compacted.some((msg, i) => msg !== event.messages[i]);
    if (!changed) return;
    return { messages: compacted };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, signal } = event;
    const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

    const model = ctx.model;
    if (!model) {
      ctx.ui.notify("No model available, using default compaction", "warning");
      return;
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      ctx.ui.notify("Compaction auth failed, using default compaction", "warning");
      return;
    }

    const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
    if (allMessages.length === 0) return;

    ctx.ui.notify(
      `Custom compaction: summarizing ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens)...`,
      "info",
    );

    const conversationText = serializeConversation(convertToLlm(allMessages));

    const promptText = getCompactionPrompt(event.customInstructions);

    const previousContext = previousSummary
      ? `\n\nPrevious session summary for context:\n${previousSummary}`
      : "";

    const summaryMessages = [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: `${promptText}${previousContext}\n\n<conversation>\n${conversationText}\n</conversation>`,
          },
        ],
        timestamp: Date.now(),
      },
    ];

    try {
      const response = await complete(
        model,
        { messages: summaryMessages },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          maxTokens: 8192,
          signal,
        },
      );

      const summary = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      if (!summary.trim()) {
        if (!signal.aborted) {
          ctx.ui.notify("Compaction summary was empty, using default", "warning");
        }
        return;
      }

      const formattedSummary = formatCompactSummary(summary);

      return {
        compaction: {
          summary: formattedSummary,
          firstKeptEntryId,
          tokensBefore,
          details: {},
        },
      };
    } catch (error) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Compaction failed: ${message}`, "error");
      return;
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const toolName = event.toolName;

    if (toolName === "harness_milestone" || toolName === "harness_plan" || toolName === "harness_todo") {
      const input = event.input as Record<string, unknown> | undefined;
      const runId = typeof input?.runId === "string" ? input.runId : undefined;
      const inputRootDir = typeof input?.rootDir === "string" ? input.rootDir : undefined;
      if (runId) {
        if (!harnessProgress) {
          harnessProgress = new HarnessProgressProvider();
        }
        const current = harnessProgress.getRunIdentity();
        const rootDir = inputRootDir ?? (current.runId === runId ? current.rootDir : undefined);
        harnessProgress.setRun(runId, rootDir);
      }
    }
  });

  const setupHandler = async (_args: string, ctx: any) => {
    const settingsPath = join(homedir(), ".pi", "agent", "settings.json");

    let current: Record<string, unknown> = {};
    try {
      const raw = await readFile(settingsPath, "utf-8");
      current = JSON.parse(raw);
    } catch {
    }

    if (current.quietStartup === true) {
      ctx.ui.notify("Settings already configured — quietStartup is true.", "info");
      return;
    }

    const ok = await ctx.ui.confirm(
      "Setup: Configure Recommended Settings",
      [
        "This will add \"quietStartup\": true to your settings.json:",
        `  ${settingsPath}`,
        "",
        "This hides the default Skills/Extensions/Themes listing at startup.",
        "The Pi Workstation banner takes over instead.",
        "",
        "Proceed?",
      ].join("\n"),
    );
    if (!ok) return;

    const updated = { ...current, quietStartup: true };
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(updated, null, 2) + "\n");

    ctx.ui.notify("Settings updated — quietStartup is now true. Restart pi to see the effect.", "info");

    try {
      const { execSync } = await import("child_process");
      execSync("gh auth status", { stdio: "pipe", timeout: 3000 });
      const star = await ctx.ui.confirm(
        "Star pi-workstation on GitHub?",
        "Thanks for using Pi Workstation! Would you like to star the repository? ⭐",
      );
      if (star) {
        execSync("gh api user/starred/Kahdeg-15520487/pi-workstation -X PUT", { stdio: "pipe" });
        ctx.ui.notify("Thanks for the star! ⭐", "info");
      }
    } catch {
      // gh not available or not authenticated — skip silently
    }
  };

  pi.registerCommand("init", {
    description:
      "Configure recommended settings — sets quietStartup: true in ~/.pi/agent/settings.json",
    handler: setupHandler,
  });

  pi.registerCommand("setup", {
    description:
      "Configure recommended settings — sets quietStartup: true in ~/.pi/agent/settings.json",
    handler: setupHandler,
  });

  registerWelcomeCommand(pi);
  registerEditorStashCommands(pi);

  (pi as any).on("message_end", async (event: any, ctx: any) => {
    const msg = event.message;
    if (msg.role === "assistant") {
      const usage = msg.usage;
      if (usage) {
        cacheStats.totalInput += usage.input;
        cacheStats.totalCacheRead += usage.cacheRead;
        // Keep this turn's telemetry so the footer can show a per-turn cache rate
        // alongside the session average.
        cacheStats.lastInput = usage.input;
        cacheStats.lastCacheRead = usage.cacheRead;
      }
      stopWorkingMessageShimmer();
    }
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    activeTools.running.set(event.toolCallId, {
      name: event.toolName,
      intent: formatToolIntent(event.toolName, (event as any).intent),
      startedAt: Date.now(),
    } satisfies ActiveToolStatus);
    refreshWorkingMessageFromTools(ctx, activeTools);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    activeTools.running.delete(event.toolCallId);
    refreshWorkingMessageFromTools(ctx, activeTools);
  });

  pi.on("session_start", async (_event, ctx) => {
    preferTodoSurfaceTools(pi);

    cacheStats.totalInput = 0;
    cacheStats.totalCacheRead = 0;
    cacheStats.lastInput = 0;
    cacheStats.lastCacheRead = 0;
    activeTools.running.clear();
    stopWorkingMessageShimmer();
    const branchEntries = ctx.sessionManager?.getBranch?.() ?? [];

    // Restore simple todo state from session branch entries
    restoreTodosFromBranchEntries(branchEntries);

    // --- Structured-first session restore (M6) ---
    // Detect structured state via validated HARNESS_STATE_EVENT_CUSTOM_TYPE entries.
    // If structured state exists, use it as the primary restore path.
    // Otherwise, fall back to legacy parser-derived reconstruction.
    let structuredRestore: { rootDir: string; state: HarnessState } | null = null;
    const harnessEvents = extractHarnessReplayEventsFromSessionEntries(branchEntries);
    const latestHarnessEvent = harnessEvents.at(-1);
    const structuredRunId = latestHarnessEvent?.runId;

    if (structuredRunId) {
      // Primary path: load snapshot + replay structured events
      const defaultRootDir = defaultHarnessStateRoot(ctx.cwd);
      const rootDir = latestHarnessEvent?.rootDir ?? defaultRootDir;
      const snapshot = await readHarnessStateSnapshot(harnessStateSnapshotPath(rootDir, structuredRunId));
      const matchingEvents = harnessEvents.filter((event) =>
        event.runId === structuredRunId && (event.rootDir ?? defaultRootDir) === rootDir
      );
      const reconstructedState = restoreHarnessStateFromSnapshotAndEvents(
        snapshot,
        createHarnessState({ runId: structuredRunId, title: structuredRunId }),
        matchingEvents,
      );
      await writeHarnessStateSnapshot(
        harnessStateSnapshotPath(rootDir, structuredRunId),
        createHarnessStateSnapshot(reconstructedState),
      );
      structuredRestore = { rootDir, state: reconstructedState };
    }

    const uiSettings = resolveAgenticUiSettings({ cwd: ctx.cwd });

    harnessProgress = new HarnessProgressProvider();
    if (structuredRestore) {
      harnessProgress.hydrate(structuredRestore.state, structuredRestore.rootDir);
    } else if (latestHarnessEvent?.runId) {
      harnessProgress.setRun(latestHarnessEvent.runId, latestHarnessEvent.rootDir);
    }

    ctx.ui.setFooter((tui, theme, footerData) => {
      let gitStats: GitStats = { ahead: 0, behind: 0, dirty: 0, untracked: 0 };

      async function refreshGitStats() {
        gitStats = await computeGitStats(ctx.cwd);
        tui.requestRender();
      }

      const gitTimer = setInterval(refreshGitStats, 5000);
      refreshGitStats();
      const unsubBranch = footerData.onBranchChange(() => refreshGitStats());

      const footer = new WorkstationFooter(theme, footerData, {
        cwd: ctx.cwd,
        getModelName: () => ctx.model?.name,
        getContextUsage: () => ctx.getContextUsage(),
        getGitStats: () => gitStats,
        getThinkingLevel: () => undefined,
        getModelInfo: () => getModelInfo(ctx),
      }, cacheStats, activeTools, tui, {
        preset: uiSettings.footerPreset,
        glyphs: uiSettings.footerGlyphs,
        modelDisplayName: uiSettings.modelDisplayName,
      });

      const originalDispose = footer.dispose.bind(footer);
      footer.dispose = () => {
        originalDispose();
        clearInterval(gitTimer);
        unsubBranch();
      };

      return footer;
    });

    installEditorComposition(ctx.ui as any, {
      getBorderContext: () => {
        const usage = ctx.getContextUsage();
        return {
          modelName: uiSettings.modelDisplayName ?? ctx.model?.name ?? "unknown",
          thinkingLevel: "off" as const,
          cwd: ctx.cwd,
          gitBranch: null,
          gitDirty: false,
          contextPercent: usage?.percent ?? 0,
          contextWindow: usage?.contextWindow ?? 0,
        };
      },
    });

    ctx.ui.notify(
      "Agentic Harness loaded",
      "info"
    );
  });
}
