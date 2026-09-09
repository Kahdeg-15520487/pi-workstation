import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export type EditorTextUi = {
  getEditorText: () => string;
  setEditorText: (text: string) => void;
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
};

export class EditorStash {
  private text: string | null = null;

  save(text: string): void {
    this.text = text;
  }

  get(): string | null {
    return this.text;
  }

  hasValue(): boolean {
    return this.text !== null;
  }

  getLength(): number {
    return this.text?.length ?? 0;
  }

  clear(): void {
    this.text = null;
  }
}

export const defaultEditorStash = new EditorStash();

function formatLength(text: string): string {
  const chars = text.length;
  const lines = text.length === 0 ? 0 : text.split("\n").length;
  return `${chars} char${chars === 1 ? "" : "s"}, ${lines} line${lines === 1 ? "" : "s"}`;
}

export function saveEditorToStash(ui: EditorTextUi, stash: EditorStash = defaultEditorStash): string {
  const text = ui.getEditorText();
  stash.save(text);
  return text;
}

export function clearEditorText(ui: EditorTextUi): void {
  ui.setEditorText("");
}

export function restoreEditorFromStash(ui: EditorTextUi, stash: EditorStash = defaultEditorStash): boolean {
  const text = stash.get();
  if (text === null) return false;
  ui.setEditorText(text);
  return true;
}

function asEditorUi(ctx: ExtensionCommandContext): EditorTextUi {
  return ctx.ui as EditorTextUi;
}

export function registerEditorStashCommands(pi: ExtensionAPI, stash: EditorStash = defaultEditorStash): void {
  pi.registerCommand("stash-save", {
    description: "Save the current editor text into a session-scoped stash slot",
    handler: async (_args, ctx) => {
      const ui = asEditorUi(ctx);
      const text = saveEditorToStash(ui, stash);
      ui.notify?.(`Saved editor stash (${formatLength(text)}).`, "info");
    },
  });

  pi.registerCommand("stash-clear", {
    description: "Clear the current editor text without modifying the saved stash",
    handler: async (_args, ctx) => {
      const ui = asEditorUi(ctx);
      clearEditorText(ui);
      ui.notify?.("Editor cleared. Use /stash-restore to restore the saved stash.", "info");
    },
  });

  pi.registerCommand("stash-restore", {
    description: "Restore the saved editor stash into the editor",
    handler: async (_args, ctx) => {
      const ui = asEditorUi(ctx);
      if (!restoreEditorFromStash(ui, stash)) {
        ui.notify?.("No editor stash saved yet.", "warning");
        return;
      }
      ui.notify?.(`Restored editor stash (${formatLength(stash.get() ?? "")}).`, "info");
    },
  });
}
