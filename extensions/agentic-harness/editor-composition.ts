import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, type EditorComponent, type EditorTheme, type TUI } from "@mariozechner/pi-tui";
import {
  clearEditorText,
  defaultEditorStash,
  type EditorStash,
  type EditorTextUi,
  restoreEditorFromStash,
  saveEditorToStash,
} from "./editor-stash.js";
import { buildTopBorder, buildBottomBorder, fg24, type BorderContext } from "./editor-border.js";

export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: unknown) => EditorComponent;

export type EditorCompositionUi = Partial<EditorTextUi> & {
  getEditorComponent?: () => EditorFactory | undefined;
  setEditorComponent?: (factory: EditorFactory | undefined) => void;
};

export interface EditorCompositionOptions {
  stash?: EditorStash;
  getBorderContext?: () => BorderContext | undefined;
}

const SHORTCUT_SAVE = "\x13"; // Ctrl+S
const SHORTCUT_RESTORE = "\x12"; // Ctrl+R
const SHORTCUT_CLEAR = "\x0b"; // Ctrl+K
const SHORTCUT_SAVE_KEY = "ctrl+s";
const SHORTCUT_RESTORE_KEY = "ctrl+r";
const SHORTCUT_CLEAR_KEY = "ctrl+k";
const DECORATED_EDITOR_SYMBOL = Symbol.for("pi-workstation.editor-composition.decorated-editor");
const BASE_FACTORY_SYMBOL = Symbol.for("pi-workstation.editor-composition.base-factory");

function renderStatusLine(width: number, stash: EditorStash): string {
  const state = stash.hasValue() ? `stash ${stash.getLength()}c` : "stash empty";
  return truncateToWidth(`╰─ ${state}  ^S save  ^R restore  ^K clear`, Math.max(0, width));
}

function colorBorder(editor: EditorComponent, theme: EditorTheme): void {
  editor.borderColor = (text: string) => fg24("#178fb9", text);
}

export function decorateEditor(
  editor: EditorComponent,
  ui: EditorTextUi,
  stash: EditorStash = defaultEditorStash,
  getBorderContext?: () => BorderContext | undefined,
): EditorComponent {
  const decoratedEditor = editor as EditorComponent & Record<symbol, unknown>;
  if (decoratedEditor[DECORATED_EDITOR_SYMBOL]) return editor;

  const originalRender = editor.render.bind(editor);
  editor.render = (width: number) => {
    let lines = originalRender(width);

    if (getBorderContext && lines.length >= 2) {
      let ctx: BorderContext | undefined;
      try {
        ctx = getBorderContext();
      } catch {
        // getBorderContext can throw if it closes over a session ctx that
        // became stale (e.g. after /reload, fork, or switchSession) while
        // this editor instance persists across the replacement. Skip the
        // border refresh for this frame instead of crashing the render loop.
        ctx = undefined;
      }
      if (ctx) {
        const borderColor = editor.borderColor ?? ((t: string) => t);
        lines = [...lines];

        // Replace top border — skip if scroll indicator is showing
        const topPlain = lines[0]!.replace(/\x1b\[[0-9;]*m/g, "");
        const isScrolledTop = topPlain.includes("\u2191"); // ↑
        if (!isScrolledTop) {
          lines[0] = buildTopBorder(ctx, width, borderColor);
        }

        // Replace bottom border — find the actual border line (starts with ─)
        // Autocomplete lines are appended after the bottom border, so don't
        // blindly replace lines[lines.length - 1].
        let bottomIdx = -1;
        for (let i = lines.length - 1; i >= 1; i--) {
          const stripped = lines[i]!.replace(/\x1b\[[0-9;]*m/g, "").trimStart();
          if (stripped.startsWith("\u2500")) { // ─
            bottomIdx = i;
            break;
          }
        }
        if (bottomIdx >= 0) {
          const bottomPlain = lines[bottomIdx]!.replace(/\x1b\[[0-9;]*m/g, "");
          const isScrolledBottom = bottomPlain.includes("\u2193"); // ↓
          if (!isScrolledBottom) {
            lines[bottomIdx] = buildBottomBorder(width, borderColor);
          }
        }
      }
    }

    return [...lines, renderStatusLine(width, stash)];
  };

  const originalHandleInput = editor.handleInput.bind(editor);
  editor.handleInput = (data: string) => {
    if (matchesKey(data, SHORTCUT_SAVE_KEY)) {
      const text = saveEditorToStash(ui, stash);
      ui.notify?.(`Saved editor stash (${text.length} char${text.length === 1 ? "" : "s"}).`, "info");
      return;
    }
    if (matchesKey(data, SHORTCUT_RESTORE_KEY)) {
      if (!restoreEditorFromStash(ui, stash)) {
        ui.notify?.("No editor stash saved yet.", "warning");
      } else {
        ui.notify?.("Restored editor stash.", "info");
      }
      return;
    }
    if (matchesKey(data, SHORTCUT_CLEAR_KEY)) {
      clearEditorText(ui);
      ui.notify?.("Editor cleared. Use Ctrl+R or /stash-restore to restore stash.", "info");
      return;
    }
    originalHandleInput(data);
  };

  decoratedEditor[DECORATED_EDITOR_SYMBOL] = true;
  return editor;
}

export function installEditorComposition(ui: EditorCompositionUi, options: EditorCompositionOptions = {}): void {
  if (typeof ui.setEditorComponent !== "function") return;
  if (typeof ui.getEditorText !== "function" || typeof ui.setEditorText !== "function") return;

  const editorUi = ui as EditorTextUi;
  const stash = options.stash ?? defaultEditorStash;
  const currentFactory = ui.getEditorComponent?.() as (EditorFactory & Record<symbol, unknown>) | undefined;
  const previousFactory = (currentFactory?.[BASE_FACTORY_SYMBOL] as EditorFactory | undefined) ?? currentFactory;

  const composedFactory = ((tui, theme, keybindings) => {
    const editor = previousFactory
      ? previousFactory(tui, theme, keybindings)
      : new CustomEditor(tui, theme, keybindings as any);
    colorBorder(editor, theme);
    return decorateEditor(editor, editorUi, stash, options.getBorderContext);
  }) as EditorFactory & Record<symbol, unknown>;
  composedFactory[BASE_FACTORY_SYMBOL] = previousFactory;
  ui.setEditorComponent(composedFactory);
}

export const editorCompositionShortcuts = {
  save: SHORTCUT_SAVE,
  restore: SHORTCUT_RESTORE,
  clear: SHORTCUT_CLEAR,
} as const;
