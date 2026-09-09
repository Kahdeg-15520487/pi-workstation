import { describe, expect, it } from "vitest";
import { normalizeFooterGlyphs, normalizeModelDisplayName, normalizeFooterPreset, resolveAgenticUiSettings } from "../ui-settings.js";

function resolver(files: Record<string, string>, env: NodeJS.ProcessEnv = {}) {
  return resolveAgenticUiSettings({
    cwd: "/repo",
    homeDir: "/home/tester",
    env,
    exists: (path) => Object.prototype.hasOwnProperty.call(files, path.replace(/\\/g, "/")),
    readFile: (path) => files[path.replace(/\\/g, "/")],
  });
}

describe("normalizeFooterPreset", () => {
  it("accepts the three supported presets case-insensitively", () => {
    expect(normalizeFooterPreset("default")).toBe("default");
    expect(normalizeFooterPreset("COMPACT")).toBe("compact");
    expect(normalizeFooterPreset(" Minimal ")).toBe("minimal");
  });

  it("rejects invalid preset names", () => {
    expect(normalizeFooterPreset("full")).toBeNull();
    expect(normalizeFooterPreset(123)).toBeNull();
    expect(normalizeFooterPreset(undefined)).toBeNull();
  });
});

describe("normalizeFooterGlyphs", () => {
  it("accepts supported glyph modes case-insensitively", () => {
    expect(normalizeFooterGlyphs("plain")).toBe("plain");
    expect(normalizeFooterGlyphs(" NERD ")).toBe("nerd");
  });

  it("rejects invalid glyph modes", () => {
    expect(normalizeFooterGlyphs("powerline")).toBeNull();
    expect(normalizeFooterGlyphs(123)).toBeNull();
    expect(normalizeFooterGlyphs(undefined)).toBeNull();
  });
});

describe("normalizeModelDisplayName", () => {
  it("trims and accepts non-empty strings", () => {
    expect(normalizeModelDisplayName("  GLM 4.7  ")).toBe("GLM 4.7");
  });

  it("rejects empty strings and non-strings", () => {
    expect(normalizeModelDisplayName("   ")).toBeNull();
    expect(normalizeModelDisplayName("")).toBeNull();
    expect(normalizeModelDisplayName(123)).toBeNull();
    expect(normalizeModelDisplayName(undefined)).toBeNull();
  });
});

describe("resolveAgenticUiSettings", () => {
  it("falls back to defaults when no settings exist", () => {
    expect(resolver({})).toMatchObject({ footerPreset: "default", footerGlyphs: "plain" });
    expect(resolver({}).modelDisplayName).toBeUndefined();
  });

  it("uses PI_AGENTIC_FOOTER_PRESET when valid", () => {
    expect(resolver({}, { PI_AGENTIC_FOOTER_PRESET: "compact" }).footerPreset).toBe("compact");
  });

  it("uses PI_AGENTIC_FOOTER_GLYPHS when valid", () => {
    expect(resolver({}, { PI_AGENTIC_FOOTER_GLYPHS: "nerd" }).footerGlyphs).toBe("nerd");
  });

  it("ignores invalid env preset and falls back to config/default", () => {
    const files = {
      "/home/tester/.pi/agent/settings.json": JSON.stringify({ agenticHarness: { footerPreset: "minimal" } }),
    };

    expect(resolver(files, { PI_AGENTIC_FOOTER_PRESET: "giant" }).footerPreset).toBe("minimal");
  });

  it("reads global agenticHarness footerPreset and footerGlyphs", () => {
    const files = {
      "/home/tester/.pi/agent/settings.json": JSON.stringify({ agenticHarness: { footerPreset: "compact", footerGlyphs: "nerd" } }),
    };

    expect(resolver(files)).toMatchObject({ footerPreset: "compact", footerGlyphs: "nerd" });
  });

  it("lets project settings override global settings", () => {
    const files = {
      "/home/tester/.pi/agent/settings.json": JSON.stringify({ agenticHarness: { footerPreset: "compact", footerGlyphs: "nerd" } }),
      "/repo/.pi/settings.json": JSON.stringify({ agenticHarness: { footerPreset: "minimal", footerGlyphs: "plain" } }),
    };

    expect(resolver(files)).toMatchObject({ footerPreset: "minimal", footerGlyphs: "plain" });
  });

  it("supports powerlineUi preset alias and ignores malformed JSON", () => {
    const files = {
      "/home/tester/.pi/agent/settings.json": "{not json",
      "/repo/.pi/settings.json": JSON.stringify({ powerlineUi: { preset: "compact" } }),
    };

    expect(resolver(files).footerPreset).toBe("compact");
  });

  it("ignores invalid glyph env and falls back to config/default", () => {
    const files = {
      "/home/tester/.pi/agent/settings.json": JSON.stringify({ agenticHarness: { footerGlyphs: "nerd" } }),
    };

    expect(resolver(files, { PI_AGENTIC_FOOTER_GLYPHS: "powerline" }).footerGlyphs).toBe("nerd");
  });

  it("reads modelDisplayName from global settings", () => {
    const files = {
      "/home/tester/.pi/agent/settings.json": JSON.stringify({ agenticHarness: { modelDisplayName: "My Custom Model" } }),
    };

    expect(resolver(files).modelDisplayName).toBe("My Custom Model");
  });

  it("lets project modelDisplayName override global modelDisplayName", () => {
    const files = {
      "/home/tester/.pi/agent/settings.json": JSON.stringify({ agenticHarness: { modelDisplayName: "Global Label" } }),
      "/repo/.pi/settings.json": JSON.stringify({ agenticHarness: { modelDisplayName: "Project Label" } }),
    };

    expect(resolver(files).modelDisplayName).toBe("Project Label");
  });

  it("uses PI_AGENTIC_MODEL_DISPLAY_NAME over configured settings", () => {
    const files = {
      "/home/tester/.pi/agent/settings.json": JSON.stringify({ agenticHarness: { modelDisplayName: "Configured Label" } }),
    };

    expect(resolver(files, { PI_AGENTIC_MODEL_DISPLAY_NAME: "Env Label" }).modelDisplayName).toBe("Env Label");
  });

  it("supports the modelName alias key", () => {
    const files = {
      "/home/tester/.pi/agent/settings.json": JSON.stringify({ agenticHarness: { modelName: "Alias Label" } }),
    };

    expect(resolver(files).modelDisplayName).toBe("Alias Label");
  });
});
