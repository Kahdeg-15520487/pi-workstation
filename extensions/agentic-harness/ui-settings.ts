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
  };
}
