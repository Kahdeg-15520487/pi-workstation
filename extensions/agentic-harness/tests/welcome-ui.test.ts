import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  keyHint: (key: string, description?: string) => `${key}${description ? ` ${description}` : ""}`,
  keyText: (key: string) => key,
  rawKeyHint: (key: string, description?: string) => `${key}${description ? ` ${description}` : ""}`,
}));

import {
  createWelcomeHeader,
  dismissWelcomeHeader,
  isWelcomeVisible,
  registerWelcomeCommand,
  showWelcomeHeader,
  toggleWelcomeHeader,
} from "../welcome-ui.js";


function ui() {
  return {
    setHeader: vi.fn(),
    notify: vi.fn(),
  };
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("welcome header controller", () => {
  it("creates a non-blocking header component", () => {
    const component = createWelcomeHeader()({} as any, theme);
    const rendered = component.render(120).join("\n");

    expect(rendered).toContain("Engineering Discipline Extension");
    expect(rendered).toContain("/clarify");
  });

  it("shows, dismisses, and toggles the header", () => {
    const mockUi = ui();

    showWelcomeHeader(mockUi as any);
    expect(isWelcomeVisible()).toBe(true);
    expect(mockUi.setHeader).toHaveBeenLastCalledWith(expect.any(Function));

    dismissWelcomeHeader(mockUi as any);
    expect(isWelcomeVisible()).toBe(false);
    expect(mockUi.setHeader).toHaveBeenLastCalledWith(undefined);

    expect(toggleWelcomeHeader(mockUi as any)).toBe(true);
    expect(isWelcomeVisible()).toBe(true);
  });

  it("registers /welcome command for show, hide, and toggle", async () => {
    const commands = new Map<string, any>();
    registerWelcomeCommand({ registerCommand: (name: string, def: any) => commands.set(name, def) } as any);

    const command = commands.get("welcome");
    expect(command).toBeDefined();
    expect(command.description).toContain("welcome header");

    const mockUi = ui();
    await command.handler("off", { ui: mockUi });
    expect(mockUi.setHeader).toHaveBeenLastCalledWith(undefined);
    expect(mockUi.notify).toHaveBeenLastCalledWith("Welcome header hidden", "info");

    await command.handler("on", { ui: mockUi });
    expect(mockUi.setHeader).toHaveBeenLastCalledWith(expect.any(Function));
    expect(mockUi.notify).toHaveBeenLastCalledWith("Welcome header shown", "info");

    await command.handler("toggle", { ui: mockUi });
    expect(mockUi.setHeader).toHaveBeenLastCalledWith(undefined);
    expect(mockUi.notify).toHaveBeenLastCalledWith("Welcome header hidden", "info");
  });
});
