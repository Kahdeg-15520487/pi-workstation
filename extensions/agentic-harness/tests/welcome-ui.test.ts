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
import { SHIMMER_SWEEP_MS } from "../shimmer.js";

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

const shimmerTheme = {
  ...theme,
  getFgAnsi: (color: string) => color === "warning" ? "\x1b[33m" : "\x1b[36m",
} as any;

const SHIMMER_HIGHLIGHT_ANSI = "\x1b[38;2;241;248;242m";

function render(component: { render(width: number): string[] }): string {
  return component.render(120).join("\n");
}

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

  it("keeps the banner shimmer running while the header is shown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const component = createWelcomeHeader()({ requestRender: vi.fn() } as any, shimmerTheme);

    const initialRender = render(component);
    expect(initialRender).toContain("\x1b[");
    expect(initialRender).toContain(SHIMMER_HIGHLIGHT_ANSI);
    expect(initialRender).not.toContain("\x1b[33m");

    vi.setSystemTime(350);
    expect(render(component)).not.toBe(initialRender);

    vi.setSystemTime(SHIMMER_SWEEP_MS * 3);
    const laterRender = render(component);

    expect(laterRender).toContain("\x1b[");
    expect(laterRender).toContain("Engineering Discipline Extension");
  });

  it("clears the shimmer timer on dispose", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const requestRender = vi.fn();

    const component = createWelcomeHeader()({ requestRender } as any, shimmerTheme);
    component.dispose?.();
    vi.advanceTimersByTime(80);

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(requestRender).not.toHaveBeenCalled();
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
