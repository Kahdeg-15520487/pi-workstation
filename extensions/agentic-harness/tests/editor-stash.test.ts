import { describe, expect, it, vi } from "vitest";
import {
  clearEditorText,
  EditorStash,
  registerEditorStashCommands,
  restoreEditorFromStash,
  saveEditorToStash,
} from "../editor-stash.js";

function createUi(initialText = "") {
  let text = initialText;
  return {
    getEditorText: vi.fn(() => text),
    setEditorText: vi.fn((next: string) => { text = next; }),
    notify: vi.fn(),
    get text() { return text; },
  };
}

describe("EditorStash", () => {
  it("saves and restores empty text as a valid stash value", () => {
    const stash = new EditorStash();
    const ui = createUi("");

    expect(saveEditorToStash(ui, stash)).toBe("");
    expect(stash.hasValue()).toBe(true);
    expect(restoreEditorFromStash(ui, stash)).toBe(true);
    expect(ui.setEditorText).toHaveBeenCalledWith("");
  });

  it("overwrites the previous stash value", () => {
    const stash = new EditorStash();
    const ui = createUi("first");

    saveEditorToStash(ui, stash);
    ui.setEditorText("second");
    saveEditorToStash(ui, stash);
    ui.setEditorText("changed");

    expect(restoreEditorFromStash(ui, stash)).toBe(true);
    expect(ui.text).toBe("second");
  });

  it("restore without a stash does not modify editor text", () => {
    const stash = new EditorStash();
    const ui = createUi("keep me");

    expect(restoreEditorFromStash(ui, stash)).toBe(false);
    expect(ui.setEditorText).not.toHaveBeenCalled();
    expect(ui.text).toBe("keep me");
  });

  it("clears editor text without clearing the stash", () => {
    const stash = new EditorStash();
    const ui = createUi("saved text");

    saveEditorToStash(ui, stash);
    clearEditorText(ui);

    expect(ui.text).toBe("");
    expect(stash.get()).toBe("saved text");
  });

  it("preserves long multiline text exactly", () => {
    const longText = [
      "first line",
      "second line with unicode ",
      "x".repeat(5_000),
      "last line",
    ].join("\n");
    const stash = new EditorStash();
    const ui = createUi(longText);

    saveEditorToStash(ui, stash);
    ui.setEditorText("different");

    expect(restoreEditorFromStash(ui, stash)).toBe(true);
    expect(ui.text).toBe(longText);
  });

  it("registers save, clear, and restore commands", async () => {
    const commands = new Map<string, any>();
    const stash = new EditorStash();
    registerEditorStashCommands({ registerCommand: (name: string, def: any) => commands.set(name, def) } as any, stash);

    expect(commands.has("stash-save")).toBe(true);
    expect(commands.has("stash-clear")).toBe(true);
    expect(commands.has("stash-restore")).toBe(true);

    const ui = createUi("command text");
    await commands.get("stash-save").handler("", { ui });
    expect(stash.get()).toBe("command text");
    expect(ui.notify).toHaveBeenLastCalledWith("Saved editor stash (12 chars, 1 line).", "info");

    await commands.get("stash-clear").handler("", { ui });
    expect(ui.text).toBe("");

    await commands.get("stash-restore").handler("", { ui });
    expect(ui.text).toBe("command text");
  });

  it("warns when restoring without a stash", async () => {
    const commands = new Map<string, any>();
    registerEditorStashCommands({ registerCommand: (name: string, def: any) => commands.set(name, def) } as any, new EditorStash());

    const ui = createUi("existing");
    await commands.get("stash-restore").handler("", { ui });

    expect(ui.text).toBe("existing");
    expect(ui.notify).toHaveBeenLastCalledWith("No editor stash saved yet.", "warning");
  });
});
