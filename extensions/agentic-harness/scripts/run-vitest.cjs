#!/usr/bin/env node
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const tmpDir = join(process.cwd(), "node_modules", ".tmp");
mkdirSync(tmpDir, { recursive: true });

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(command, ["vitest", "run", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: { ...process.env, TMPDIR: tmpDir, TEMP: tmpDir, TMP: tmpDir },
  stdio: "inherit",
  shell: true,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
