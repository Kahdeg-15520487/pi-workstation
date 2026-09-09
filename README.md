# pi-workstation

Extension suite for the [pi coding agent](https://github.com/badlogic/pi-mono): progress tracking, workspace memory, and readable tool output. All code is plain TypeScript/Markdown in this repository.

## Extensions

| Extension | Purpose |
|---|---|
| `extensions/agentic-harness/` | Progress tracking tools, powerline footer, `webfetch`, `ask_user_question`, custom compaction, skills |
| `extensions/workspace-memory/` | Structured memory save/recall per workspace |
| `extensions/pi-code-previews/` | Shiki-highlighted previews for tool call results |

## Tools (LLM-callable)

| Tool | Purpose |
|---|---|
| `todoread` / `todowrite` | Session todo list; drives footer progress |
| `harness_milestone` | Durable milestones (create/update/set_status/load/render) |
| `harness_plan` / `harness_todo` | Durable plan and todo state |
| `ask_user_question` | Ask the user single or batched questions |
| `webfetch` | Fetch URL -> Markdown, 15-min cache, raw/includeScripts/maxLength |
| `memory_save` | Save a structured workspace memory |

## Commands

| Command | Purpose |
|---|---|
| `/init`, `/setup` | Write `quietStartup: true` to `~/.pi/agent/settings.json` |
| `/welcome` | Toggle welcome banner |
| `/stash-save`, `/stash-restore`, `/stash-clear` | Save/restore/clear editor buffer (keys: Ctrl-S/R/K) |
| `/memory list\|show\|save\|delete\|search\|stats` | Manage workspace memories |
| `/code-preview-health`, `/code-preview-settings` | Preview renderer status and settings |

## Configuration

| Setting | Values |
|---|---|
| `quietStartup` (settings.json) | `true` hides default startup listing |
| `PI_AGENTIC_FOOTER_PRESET` | `default` \| `compact` \| `minimal` |
| `PI_AGENTIC_FOOTER_GLYPHS` | `plain` \| `nerd` |
| `PI_AGENTIC_MODEL_DISPLAY_NAME` | Override footer model name |
| `PI_AGENTIC_MICROCOMPACTION` | `1` = compact old tool results in context |
| `.pi/agentic-ui.json` | Project-local footer overrides |

Env vars take precedence over `.pi/agentic-ui.json`; per-session defaults are `plain` glyphs and `default` preset.

## Layout

```text
extensions/
  agentic-harness/     # progress tools, footer UI, webfetch, ask_user_question, compaction, skills
  workspace-memory/    # save/recall workspace memory
  pi-code-previews/    # syntax-highlighted tool-call previews (shiki)
```

## Development

```bash
npm --prefix extensions/agentic-harness test && npm --prefix extensions/agentic-harness run build
npm --prefix extensions/workspace-memory test && npm --prefix extensions/workspace-memory run build
npm --prefix extensions/pi-code-previews test && npm --prefix extensions/pi-code-previews run check
```

No root `npm test`; run extension-level commands. `pi-code-previews` uses `check` (typecheck + lint + format) instead of `build`.

## License

MIT — see [package.json](package.json).
