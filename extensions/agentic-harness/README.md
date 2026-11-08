# Pi Agentic Harness

An extension for the [pi coding agent](https://github.com/earendil-works/pi) focused on progress tracking, structured state, and editor/powerline UI chrome.

## Features

- **Structured progress tracking** — `todoread` / `todowrite` session todos plus durable `harness_milestone` / `harness_plan` / `harness_todo` state. The footer shows live todo progress and restores state across sessions via structured replay events.
- **Powerline footer** (`WorkstationFooter`) — logo, path, git status, model, context/cache usage, todo progress, active tools. Presets `default|compact|minimal`, glyphs `plain|nerd`; per-project `.pi/agentic-ui.json` overrides plus `PI_AGENTIC_FOOTER_PRESET` / `PI_AGENTIC_FOOTER_GLYPHS` / `PI_AGENTIC_MODEL_DISPLAY_NAME` env vars.
- **`ask_user_question` tool** — the agent asks focused single or batched questions (with optional choices) whenever it needs clarification.
- **`webfetch` tool** — URL → Markdown (Turndown + GFM), 15-minute cache, `raw` / `includeScripts` / `maxLength`.
- **Custom compaction** — detailed 9-section summary via `session_before_compact`; opt-in microcompaction via `PI_AGENTIC_MICROCOMPACTION=1`.
- **Editor composition** — border + status line with Ctrl-S stash / Ctrl-R restore / Ctrl-K clear shortcuts, plus `/stash-save` / `/stash-restore` / `/stash-clear` commands.
- **`/welcome`** — toggle the welcome header banner.
- **OpenCode Go usage + key rotation** — `/opencode-usage` shows quota windows and per-model spend; `/opencode-key` shows both `auth.json` subscriptions and rotates the active one. Auto-failover (default on) swaps to the standby key on 429/quota errors and switches back once the preferred key's quota recovers.
- **`/init` / `/setup`** — write `quietStartup: true` to `~/.pi/agent/settings.json`.
- **Bundled skills** (discovered via `resources_discover`): `agentic-brainstorming`, `agentic-karpathy`, `agentic-rob-pike`, `agentic-simplify`, `agentic-systematic-debugging`.
- **Unhandled-rejection guard** — swallows benign stream/transport rejections that would otherwise crash pi.

## How It Works

1. **`before_agent_start`** injects a deterministic Progress Tracking rules block (todoread/todowrite non-negotiables) into the system prompt.
2. **`tool_result`** tracks `harness_milestone` / `harness_plan` / `harness_todo` run identity for the footer.
3. **`session_start`** restores todo + structured harness state from session replay entries, installs the footer and editor composition.
4. **`session_before_compact`** runs the custom compaction prompt; **`message_end` / `tool_execution_*`** feed cache stats and active-tool state into the footer and working indicator.

## Installation

```bash
pi install git:github.com/Kahdeg-15520487/pi-workstation
```

## Usage

```text
/init                recommended settings (quietStartup)
/welcome             toggle welcome banner
/stash-save          stash editor buffer
/opencode-usage      OpenCode Go quota + per-model spend (7d)
/opencode-key        show both auth.json subscriptions
/opencode-key rotate switch to the other subscription
/opencode-key auto off   disable automatic failover/recovery
/code-preview-*      (from the bundled pi-code-previews extension)
```

The `todoread` / `todowrite` / `harness_*` tools are LLM-callable and drive the footer progress indicator.

## OpenCode Go key rotation

pi-ai reads only the credential's `key` field, so the rotation swaps `key` and `key2` in `~/.pi/agent/auth.json` (atomically, mode 0600) and records the result in `~/.pi/agent/opencode-key-rotation.json`. AuthStorage reloads on the auth.json revision change, so the next request uses the new subscription without a restart.

- Manual: `/opencode-key rotate` (also resets the preferred subscription to the newly active one).
- Automatic: on HTTP 429/402 or a quota/rate-limit assistant error while `opencode-go` is the current provider. When failed over, a throttled background probe (10 min, also on session start) checks `key2`; once every window is OK and rolling usage is below 90%, it swaps back.
- Editing `auth.json` by hand (for example `/login opencode-go`) resets failover state; the new `key` is authoritative.
- Rotation requires both `key` and `key2` to be present and different.

## Footer glyph settings

Defaults to plain glyphs (Windows terminals without a Nerd Font show no tofu). Opt in:

```bash
PI_AGENTIC_FOOTER_GLYPHS=nerd pi
```

or set `"agenticHarness": { "footerGlyphs": "nerd" }` in `.pi/settings.json`. Values: `plain` | `nerd`.

## Development

```bash
npm test
npm run build
```

Tests run via vitest (`scripts/run-vitest.cjs`).