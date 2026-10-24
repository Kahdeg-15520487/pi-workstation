import { describe, expect, it, vi } from "vitest";
import { visibleWidth, type EditorComponent } from "@earendil-works/pi-tui";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  CustomEditor: class MockCustomEditor {
    borderColor = (text: string) => text;
    handleInput = vi.fn();
    render = vi.fn((width: number) => ["default".slice(0, width)]);
    getText = vi.fn(() => "");
    setText = vi.fn();
  },
}));

import { decorateEditor, editorCompositionShortcuts, installEditorComposition } from "../editor-composition.js";
import { EditorStash } from "../editor-stash.js";
import type { BorderContext } from "../editor-border.js";

function createEditor(lines: string[] = ["editor"]): EditorComponent {
  return {
    render: vi.fn((width: number) => lines.map((line) => line.slice(0, width))),
    invalidate: vi.fn(),
    getText: vi.fn(() => ""),
    setText: vi.fn(),
    handleInput: vi.fn(),
    borderColor: (text: string) => text,
  };
}

function createUi(text = "") {
  let editorText = text;
  return {
    getEditorText: vi.fn(() => editorText),
    setEditorText: vi.fn((next: string) => { editorText = next; }),
    notify: vi.fn(),
    get text() { return editorText; },
  };
}

const theme = {
  borderColor: (text: string) => `<border>${text}</border>`,
  selectList: {},
} as any;

describe("editor composition", () => {
  it("composes with an existing editor factory from getEditorComponent", () => {
    const existingEditor = createEditor(["existing"]);
    const previousFactory = vi.fn(() => existingEditor);
    const setEditorComponent = vi.fn();
    const ui = {
      ...createUi("hello"),
      getEditorComponent: vi.fn(() => previousFactory),
      setEditorComponent,
    };

    installEditorComposition(ui as any, { stash: new EditorStash() });

    expect(ui.getEditorComponent).toHaveBeenCalledTimes(1);
    expect(setEditorComponent).toHaveBeenCalledWith(expect.any(Function));

    const factory = setEditorComponent.mock.calls[0][0];
    const decorated = factory({} as any, theme, {} as any);

    expect(previousFactory).toHaveBeenCalledTimes(1);
    expect(decorated).toBe(existingEditor);
    expect(decorated.render(80).join("\n")).toContain("stash empty");
  });

  it("falls back to CustomEditor when no previous factory exists", () => {
    const setEditorComponent = vi.fn();
    const ui = {
      ...createUi(),
      getEditorComponent: vi.fn(() => undefined),
      setEditorComponent,
    };

    installEditorComposition(ui as any, { stash: new EditorStash() });
    const factory = setEditorComponent.mock.calls[0][0];
    const editor = factory({} as any, theme, {} as any);

    expect(editor.render(80).join("\n")).toContain("default");
    expect(editor.render(80).join("\n")).toContain("stash empty");
  });

  it("does not stack stash status lines when installed repeatedly on reload", () => {
    let currentFactory: any;
    const ui = {
      ...createUi(),
      getEditorComponent: vi.fn(() => currentFactory),
      setEditorComponent: vi.fn((factory: any) => { currentFactory = factory; }),
    };

    installEditorComposition(ui as any, { stash: new EditorStash() });
    installEditorComposition(ui as any, { stash: new EditorStash() });

    const editor = currentFactory({} as any, theme, {} as any);
    const statusLines = editor.render(80).filter((line: string) => line.includes("stash empty"));

    expect(statusLines).toHaveLength(1);
  });

  it("keeps the appended status line width-safe", () => {
    const stash = new EditorStash();
    stash.save("x".repeat(100));
    const decorated = decorateEditor(createEditor(["abc"]), createUi() as any, stash);

    for (const width of [10, 20, 80]) {
      for (const line of decorated.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("stash shortcuts call the command-tested stash operations", () => {
    const stash = new EditorStash();
    const ui = createUi("saved text");
    const editor = decorateEditor(createEditor(), ui as any, stash);

    editor.handleInput(editorCompositionShortcuts.save);
    expect(stash.get()).toBe("saved text");

    editor.handleInput(editorCompositionShortcuts.clear);
    expect(ui.text).toBe("");

    editor.handleInput(editorCompositionShortcuts.restore);
    expect(ui.text).toBe("saved text");
  });

  it("matches encoded terminal shortcuts for stash operations", () => {
    const stash = new EditorStash();
    const ui = createUi("saved text");
    const editor = decorateEditor(createEditor(), ui as any, stash);

    editor.handleInput("\x1b[115;5u");
    expect(stash.get()).toBe("saved text");

    editor.handleInput("\x1b[27;5;107~");
    expect(ui.text).toBe("");

    editor.handleInput("\x1b[114;5u");
    expect(ui.text).toBe("saved text");
  });

  it("passes through unhandled input to the previous editor", () => {
    const base = createEditor();
    const originalHandleInput = base.handleInput;
    const editor = decorateEditor(base, createUi() as any, new EditorStash());

    editor.handleInput("a");

    expect(originalHandleInput).toHaveBeenCalledWith("a");
  });

  it("replaces top and bottom borders when getBorderContext returns a context", () => {
    const borderLines = ["────────────────────────────────────────", "content line", "────────────────────────────────────────"];
    const editor = createEditor(borderLines);
    const ctx: BorderContext = {
      modelName: "test-model",
      thinkingLevel: "off",
      cwd: "/tmp/test",
      gitBranch: null,
      gitDirty: false,
      contextPercent: 10,
      contextWindow: 128000,
    };
    const decorated = decorateEditor(editor, createUi() as any, new EditorStash(), () => ctx);
    const lines = decorated.render(40);

    // Top border should contain model name (stripped of ANSI)
    const topPlain = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
    expect(topPlain).toContain("test-model");

    // Bottom border should be a solid line
    const bottomPlain = lines[lines.length - 2].replace(/\x1b\[[0-9;]*m/g, "");
    expect(bottomPlain).toContain("─");

    // Status line is still appended
    expect(lines[lines.length - 1]).toContain("stash empty");
  });

  it("does not replace borders when getBorderContext returns undefined", () => {
    const borderLines = ["original-top", "content", "original-bottom"];
    const editor = createEditor(borderLines);
    const decorated = decorateEditor(editor, createUi() as any, new EditorStash(), () => undefined);
    const lines = decorated.render(80);

    expect(lines[0]).toBe("original-top");
    expect(lines[lines.length - 2]).toBe("original-bottom");
  });

  it("does not crash the render loop when getBorderContext throws (e.g. stale ctx after /reload)", () => {
    const borderLines = ["original-top", "content", "original-bottom"];
    const editor = createEditor(borderLines);
    const staleGetBorderContext = () => {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    };
    const decorated = decorateEditor(editor, createUi() as any, new EditorStash(), staleGetBorderContext);

    expect(() => decorated.render(80)).not.toThrow();

    const lines = decorated.render(80);
    expect(lines[0]).toBe("original-top");
    expect(lines[lines.length - 2]).toBe("original-bottom");
  });

  it("does not replace borders when editor has fewer than 2 lines", () => {
    const editor = createEditor(["single-line"]);
    const ctx: BorderContext = {
      modelName: "test-model",
      thinkingLevel: "off",
      cwd: "/tmp",
      gitBranch: null,
      gitDirty: false,
      contextPercent: 0,
      contextWindow: 0,
    };
    const decorated = decorateEditor(editor, createUi() as any, new EditorStash(), () => ctx);
    const lines = decorated.render(80);

    expect(lines[0]).toBe("single-line");
  });

  it("keeps border lines width-safe when getBorderContext is provided", () => {
    const borderLines = ["────────────────────────────────────────", "content", "────────────────────────────────────────"];
    const ctx: BorderContext = {
      modelName: "test-model",
      thinkingLevel: "medium",
      cwd: "/home/user/projects/myapp",
      gitBranch: "main",
      gitDirty: true,
      contextPercent: 55,
      contextWindow: 200000,
    };
    const editor = createEditor(borderLines);
    const decorated = decorateEditor(editor, createUi() as any, new EditorStash(), () => ctx);

    for (const width of [20, 40, 80]) {
      for (const line of decorated.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("installEditorComposition passes getBorderContext to decorateEditor", () => {
    const setEditorComponent = vi.fn();
    const existingEditor = createEditor(["────────────────────────────────────────", "content", "────────────────────────────────────────"]);
    const previousFactory = vi.fn(() => existingEditor);
    const ctx: BorderContext = {
      modelName: "composed-model",
      thinkingLevel: "off",
      cwd: "/tmp",
      gitBranch: null,
      gitDirty: false,
      contextPercent: 5,
      contextWindow: 100000,
    };
    const ui = {
      ...createUi(),
      getEditorComponent: vi.fn(() => previousFactory),
      setEditorComponent,
    };

    installEditorComposition(ui as any, {
      stash: new EditorStash(),
      getBorderContext: () => ctx,
    });

    const factory = setEditorComponent.mock.calls[0][0];
    const decorated = factory({} as any, theme, {} as any);
    const lines = decorated.render(40);

    const topPlain = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
    expect(topPlain).toContain("composed-model");
  });

  it("preserves top scroll indicator instead of replacing with custom border", () => {
    const scrollIndicator = "\u2500".repeat(40);
    const scrollLine = "\u2500\u2500\u2500 \u2191 5 more " + "\u2500".repeat(24);
    const editor = createEditor([scrollLine.slice(0, 40), "content", scrollIndicator]);
    const ctx: BorderContext = {
      modelName: "test-model", thinkingLevel: "off", cwd: "/tmp",
      gitBranch: null, gitDirty: false, contextPercent: 0, contextWindow: 0,
    };
    const decorated = decorateEditor(editor, createUi() as any, new EditorStash(), () => ctx);
    const lines = decorated.render(40);
    // Top should still contain the scroll arrow, not be replaced with model info
    expect(lines[0]).toContain("\u2191");
    expect(lines[0]).not.toContain("test-model");
  });

  it("preserves bottom scroll indicator instead of replacing with custom border", () => {
    const scrollIndicator = "\u2500".repeat(40);
    const scrollLine = "\u2500\u2500\u2500 \u2193 3 more " + "\u2500".repeat(24);
    const editor = createEditor([scrollIndicator, "content", scrollLine.slice(0, 40)]);
    const ctx: BorderContext = {
      modelName: "test-model", thinkingLevel: "off", cwd: "/tmp",
      gitBranch: null, gitDirty: false, contextPercent: 0, contextWindow: 0,
    };
    const decorated = decorateEditor(editor, createUi() as any, new EditorStash(), () => ctx);
    const lines = decorated.render(40);
    // Bottom border (before stash line) should still contain the scroll arrow
    const bottomBorder = lines[lines.length - 2];
    expect(bottomBorder).toContain("\u2193");
  });

  it("replaces correct bottom border line when autocomplete lines are present", () => {
    const bottomBorder = "\u2500".repeat(40);
    const editor = createEditor([
      "\u2500".repeat(40),  // top border
      "content",             // content
      bottomBorder,          // bottom border
      "autocomplete-item-1", // autocomplete line (no ─)
      "autocomplete-item-2", // autocomplete line (no ─)
    ]);
    const ctx: BorderContext = {
      modelName: "m", thinkingLevel: "off", cwd: "/",
      gitBranch: null, gitDirty: false, contextPercent: 0, contextWindow: 0,
    };
    const decorated = decorateEditor(editor, createUi() as any, new EditorStash(), () => ctx);
    const lines = decorated.render(40);
    // Bottom border (line index 2) should be replaced
    const replaced = lines[2].replace(/\x1b\[[0-9;]*m/g, "");
    expect(replaced).toBe(bottomBorder);
    // Autocomplete lines should be untouched
    expect(lines[3]).toBe("autocomplete-item-1");
    expect(lines[4]).toBe("autocomplete-item-2");
    // Stash line is last
    expect(lines[lines.length - 1]).toContain("stash empty");
  });

  it("colorBorder uses oh-my-pi blue instead of double-wrapping theme borderColor", () => {
    const setEditorComponent = vi.fn();
    const existingEditor = createEditor(["line1", "line2"]);
    const previousFactory = vi.fn(() => existingEditor);
    const ui = {
      ...createUi(),
      getEditorComponent: vi.fn(() => previousFactory),
      setEditorComponent,
    };

    installEditorComposition(ui as any, { stash: new EditorStash() });

    const factory = setEditorComponent.mock.calls[0][0];
    const decorated = factory({} as any, theme, {} as any);

    // borderColor should use fg24 with #178fb9, not theme.borderColor wrapping
    const colored = decorated.borderColor!("test");
    expect(colored).toContain("\x1b[38;2;23;143;185m"); // RGB for #178fb9
    expect(colored).not.toContain("<border>");
  });
});
