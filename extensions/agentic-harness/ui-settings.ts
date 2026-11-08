import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const FOOTER_PRESETS = ["default", "compact", "minimal"] as const;
export type FooterPresetName = typeof FOOTER_PRESETS[number];

export const FOOTER_GLYPHS = ["plain", "nerd"] as const;
export type FooterGlyphMode = typeof FOOTER_GLYPHS[number];

export interface AgenticUiSettings {
  footerPreset: FooterPresetName;
  footerGlyphs: FooterGlyphMode;
  /** Cosmetic override for the displayed model name (footer + editor border). Undefined = show the real active model name. */
  modelDisplayName?: string;
  /**
   * Per-segment visibility overrides for the footer.
   *
   * Only explicitly disabled (or re-enabled) segments appear here; a segment
   * that is absent keeps the default, which is visible. That keeps presets
   * useful — a new segment does not silently vanish for everyone — while still
   * letting one element be switched off without redefining a whole preset.
   */
  footerSegments: Record<string, boolean>;
}

export interface UiSettingsResolverOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
}

const DEFAULT_SETTINGS: AgenticUiSettings = {
  footerPreset: "default",
  footerGlyphs: "plain",
  footerSegments: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeFooterPreset(value: unknown): FooterPresetName | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (FOOTER_PRESETS as readonly string[]).includes(normalized)
    ? (normalized as FooterPresetName)
    : null;
}

export function normalizeFooterGlyphs(value: unknown): FooterGlyphMode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (FOOTER_GLYPHS as readonly string[]).includes(normalized)
    ? (normalized as FooterGlyphMode)
    : null;
}

export function normalizeModelDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const FALSE_WORDS = new Set(["0", "off", "false", "no", "hide", "hidden", "disable", "disabled"]);
const TRUE_WORDS = new Set(["1", "on", "true", "yes", "show", "visible", "enable", "enabled"]);

function parseSegmentFlag(raw: string): boolean | undefined {
  const token = raw.trim().toLowerCase();
  if (FALSE_WORDS.has(token)) return false;
  if (TRUE_WORDS.has(token)) return true;
  return undefined;
}

/**
 * Normalise per-segment footer visibility from either form:
 *
 *   object  { "provider": false, "cache": true }     (settings.json)
 *   string  "provider=off,cache=on"                   (env var)
 *
 * Unknown segment names are kept: the footer decides which segments exist, so a
 * typo becomes a harmless no-op instead of an error during render. Returns null
 * when nothing usable was supplied, so callers can fall through to defaults.
 */
export function normalizeFooterSegments(value: unknown): Record<string, boolean> | null {
  const result: Record<string, boolean> = {};

  if (isRecord(value)) {
    for (const [key, raw] of Object.entries(value)) {
      const name = key.trim().toLowerCase();
      if (!name) continue;
      if (typeof raw === "boolean") {
        result[name] = raw;
      } else if (typeof raw === "string") {
        const flag = parseSegmentFlag(raw);
        if (flag !== undefined) result[name] = flag;
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  }

  if (typeof value === "string") {
    for (const part of value.split(",")) {
      const entry = part.trim();
      if (!entry) continue;
      const [rawName, rawFlag] = entry.split("=");
      const name = rawName?.trim().toLowerCase();
      if (!name) continue;
      // A bare segment name means "show it", matching the usual CLI idiom.
      if (rawFlag === undefined) {
        result[name] = true;
        continue;
      }
      const flag = parseSegmentFlag(rawFlag);
      if (flag !== undefined) result[name] = flag;
    }
    return Object.keys(result).length > 0 ? result : null;
  }

  return null;
}

/** True when a footer segment should render. Absent overrides default to visible. */
export function isFooterSegmentEnabled(settings: AgenticUiSettings, segmentId: string): boolean {
  return settings.footerSegments[segmentId] ?? true;
}

function readSettingsFile(path: string, exists: (path: string) => boolean, readFile: (path: string) => string): Record<string, unknown> {
  if (!exists(path)) return {};
  try {
    const parsed = JSON.parse(readFile(path));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readConfiguredPreset(settings: Record<string, unknown>): FooterPresetName | null {
  const agenticHarness = isRecord(settings.agenticHarness) ? settings.agenticHarness : undefined;
  const powerlineUi = isRecord(settings.powerlineUi) ? settings.powerlineUi : undefined;

  return normalizeFooterPreset(agenticHarness?.footerPreset)
    ?? normalizeFooterPreset(agenticHarness?.preset)
    ?? normalizeFooterPreset(powerlineUi?.footerPreset)
    ?? normalizeFooterPreset(powerlineUi?.preset);
}

function readConfiguredGlyphs(settings: Record<string, unknown>): FooterGlyphMode | null {
  const agenticHarness = isRecord(settings.agenticHarness) ? settings.agenticHarness : undefined;
  return normalizeFooterGlyphs(agenticHarness?.footerGlyphs);
}

function readConfiguredModelDisplayName(settings: Record<string, unknown>): string | null {
  const agenticHarness = isRecord(settings.agenticHarness) ? settings.agenticHarness : undefined;
  return normalizeModelDisplayName(agenticHarness?.modelDisplayName) ?? normalizeModelDisplayName(agenticHarness?.modelName);
}

function readConfiguredSegments(settings: Record<string, unknown>): Record<string, boolean> | null {
  const agenticHarness = isRecord(settings.agenticHarness) ? settings.agenticHarness : undefined;
  const powerlineUi = isRecord(settings.powerlineUi) ? settings.powerlineUi : undefined;
  return normalizeFooterSegments(agenticHarness?.footerSegments)
    ?? normalizeFooterSegments(powerlineUi?.footerSegments);
}

export function resolveAgenticUiSettings(options: UiSettingsResolverOptions = {}): AgenticUiSettings {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env.HOME ?? env.USERPROFILE ?? homedir();
  const exists = options.exists ?? existsSync;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf-8"));

  const globalSettings = readSettingsFile(join(homeDir, ".pi", "agent", "settings.json"), exists, readFile);
  const projectSettings = readSettingsFile(join(cwd, ".pi", "settings.json"), exists, readFile);

  return {
    ...DEFAULT_SETTINGS,
    footerPreset:
      normalizeFooterPreset(env.PI_AGENTIC_FOOTER_PRESET)
      ?? readConfiguredPreset(projectSettings)
      ?? readConfiguredPreset(globalSettings)
      ?? DEFAULT_SETTINGS.footerPreset,
    footerGlyphs:
      normalizeFooterGlyphs(env.PI_AGENTIC_FOOTER_GLYPHS)
      ?? readConfiguredGlyphs(projectSettings)
      ?? readConfiguredGlyphs(globalSettings)
      ?? DEFAULT_SETTINGS.footerGlyphs,
    modelDisplayName:
      normalizeModelDisplayName(env.PI_AGENTIC_MODEL_DISPLAY_NAME)
      ?? readConfiguredModelDisplayName(projectSettings)
      ?? readConfiguredModelDisplayName(globalSettings)
      ?? undefined,
    footerSegments: {
      // Merged rather than replaced: the env var can flip one segment without
      // discarding what settings.json already set.
      ...(readConfiguredSegments(globalSettings) ?? {}),
      ...(readConfiguredSegments(projectSettings) ?? {}),
      ...(normalizeFooterSegments(env.PI_AGENTIC_FOOTER_SEGMENTS) ?? {}),
    },
  };
}
