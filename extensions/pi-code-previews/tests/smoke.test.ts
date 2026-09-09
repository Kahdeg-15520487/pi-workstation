import { describe, expect, it } from "vitest";
import { escapeControlChars, stripAnsi } from "../src/terminal-text.ts";
import {
  defaultCodePreviewSettings,
  normalizeSettings,
  updateSetting,
} from "../src/settings.ts";

describe("compact previews setting", () => {
  it("exposes a boolean compactPreviews default", () => {
    expect(typeof defaultCodePreviewSettings.compactPreviews).toBe("boolean");
  });

  it("toggles compactPreviews through updateSetting", () => {
    const off = updateSetting(defaultCodePreviewSettings, "compactPreviews", "off");
    expect(off.compactPreviews).toBe(false);
    const on = updateSetting(off, "compactPreviews", "on");
    expect(on.compactPreviews).toBe(true);
  });

  it("preserves compactPreviews through normalizeSettings", () => {
    const normalized = normalizeSettings({ compactPreviews: false }, defaultCodePreviewSettings);
    expect(normalized.compactPreviews).toBe(false);
  });
});

describe("terminal text helpers", () => {
  it("strips ansi and makes control characters visible", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
    expect(escapeControlChars("a\rb\u001b[31m")).toBe("a␍b␛[31m");
  });
});
