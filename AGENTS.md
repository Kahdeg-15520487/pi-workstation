# AGENTS

Guidance for agent sessions working in this repository.

## Repository layout

```
extensions/agentic-harness/   # progress tracking tools, footer UI, webfetch, ask_user_question, compaction, skills
extensions/workspace-memory/  # structured memory save/recall per workspace
extensions/pi-code-previews/  # Shiki-highlighted previews of tool-call results
```

All extensions are plain TypeScript loaded through the `pi.extensions` array in the root
`package.json`. Each extension is an independent npm package with its own tests and scripts.

## Working conventions

- Keep changes minimal and surgical; no premature abstraction.
- Commands, tools, hooks, agents, and skills must stay inspectable — plain TypeScript and
  Markdown only, no generated artifacts.
- Extension-level commands (there is no root test script):
  ```bash
  npm --prefix extensions/agentic-harness test && npm --prefix extensions/agentic-harness run build
  npm --prefix extensions/workspace-memory test && npm --prefix extensions/workspace-memory run build
  npm --prefix extensions/pi-code-previews run check
  ```
- After changing an extension, type `/reload` in the running `pi` session to apply.
