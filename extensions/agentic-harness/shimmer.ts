import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";

const CLASSIC_PADDING = 10;
export const SHIMMER_SWEEP_MS = 1400;
const CLASSIC_BAND_HALF_WIDTH = 6;
const TIER_HIGH = 0.65;
const TIER_MID = 0.22;
const FG_RESET = "\x1b[39m";
const BOLD_OPEN = "\x1b[1m";
const BOLD_CLOSE = "\x1b[22m";

type ShimmerTheme = Pick<Theme, "getFgAnsi">;
type ShimmerPaletteTier = ThemeColor | { ansi: string };
type Tier = "low" | "mid" | "high";

export interface ShimmerPalette {
  low: ShimmerPaletteTier;
  mid: ShimmerPaletteTier;
  high: ShimmerPaletteTier;
  bold?: boolean;
}

export interface ShimmerSegment {
  text: string;
  palette?: ShimmerPalette;
}

export const DEFAULT_SHIMMER_PALETTE: ShimmerPalette = {
  low: "dim",
  mid: "accent",
  high: "warning",
  bold: true,
};

function resolveTierAnsi(theme: ShimmerTheme, tier: ShimmerPaletteTier): string {
  return typeof tier === "string" ? theme.getFgAnsi(tier) : tier.ansi;
}

function classicIntensity(time: number, index: number, length: number): number {
  const period = length + CLASSIC_PADDING * 2;
  const pos = ((time % SHIMMER_SWEEP_MS) / SHIMMER_SWEEP_MS) * period;
  const dist = Math.abs(index + CLASSIC_PADDING - pos);
  if (dist >= CLASSIC_BAND_HALF_WIDTH) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * dist) / CLASSIC_BAND_HALF_WIDTH));
}

function tierFor(intensity: number): Tier {
  if (intensity >= TIER_HIGH) return "high";
  if (intensity >= TIER_MID) return "mid";
  return "low";
}

function openCloseFor(theme: ShimmerTheme, palette: ShimmerPalette, tier: Tier): { open: string; close: string } {
  const ansi = resolveTierAnsi(theme, palette[tier]);
  if (tier === "high" && palette.bold) return { open: `${BOLD_OPEN}${ansi}`, close: `${BOLD_CLOSE}${FG_RESET}` };
  return { open: ansi, close: FG_RESET };
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function shimmerSegments(
  segments: readonly ShimmerSegment[],
  theme: ShimmerTheme,
  now: number = Date.now(),
): string {
  const prepared = segments.map((segment) => ({
    chars: Array.from(segment.text),
    palette: segment.palette ?? DEFAULT_SHIMMER_PALETTE,
  }));
  const total = prepared.reduce((sum, segment) => sum + segment.chars.length, 0);
  if (total === 0) return "";

  let out = "";
  let globalIndex = 0;
  for (const segment of prepared) {
    let runTier: Tier | null = null;
    let runText = "";

    for (const char of segment.chars) {
      const tier = tierFor(classicIntensity(now, globalIndex, total));
      if (runTier !== null && tier !== runTier) {
        const seq = openCloseFor(theme, segment.palette, runTier);
        out += `${seq.open}${runText}${seq.close}`;
        runText = "";
      }
      runTier = tier;
      runText += char;
      globalIndex++;
    }

    if (runTier !== null && runText.length > 0) {
      const seq = openCloseFor(theme, segment.palette, runTier);
      out += `${seq.open}${runText}${seq.close}`;
    }
  }

  return out;
}

export function shimmerText(
  text: string,
  theme: ShimmerTheme,
  palette?: ShimmerPalette,
  now: number = Date.now(),
): string {
  return shimmerSegments([{ text, palette }], theme, now);
}
