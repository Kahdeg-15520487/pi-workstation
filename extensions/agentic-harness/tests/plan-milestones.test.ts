import { describe, expect, it, vi } from "vitest";
import extension from "../index.js";

function loadHarness() {
  const commands = new Map<string, any>();
  const api: any = {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, definition: any) => {
      commands.set(name, definition);
    }),
    sendUserMessage: vi.fn(),
  };

  extension(api);

  return { api, commands };
}

describe("Harness surface", () => {
  it("registers setup/welcome/stash commands and no workflow commands", () => {
    const { commands } = loadHarness();

    expect(commands.has("init")).toBe(true);
    expect(commands.has("setup")).toBe(true);
    expect(commands.has("welcome")).toBe(true);
    expect(commands.has("stash-save")).toBe(true);
    expect(commands.has("stash-restore")).toBe(true);
    expect(commands.has("stash-clear")).toBe(true);

    for (const removed of ["clarify", "goal", "plan", "review", "team", "ask", "reset-phase", "ultraplan", "ultrareview"]) {
      expect(commands.has(removed)).toBe(false);
    }
  });

  it("does not send any messages during harness load", () => {
    const { api } = loadHarness();

    expect(api.sendUserMessage).not.toHaveBeenCalled();
  });
});