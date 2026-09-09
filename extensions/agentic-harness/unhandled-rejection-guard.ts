import { appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Global safety net for floating promise rejections.
 *
 * pi (the host) registers an `uncaughtException` handler that restores the
 * terminal and exits. With Node's default `--unhandled-rejections=throw`, any
 * unhandled promise rejection is promoted to `uncaughtException`, so a single
 * fire-and-forget promise from an extension or dependency (e.g. vscode-jsonrpc
 * `sendNotification` writing to a destroyed LSP server stdin after the server
 * crashed) kills the whole session with a raw terminal.
 *
 * This handler swallows only transport/stream rejections that are expected
 * once an external process has died (stream destroyed, EPIPE, connection
 * closed). Everything else is re-thrown so real bugs still surface through
 * pi's crash path (terminal restore + exit).
 */
const DEBUG_LOG_PATH = join(homedir(), ".pi", "agent", "pi-debug.log");

let installed = false;

const BENIGN_ERROR_CODES = new Set([
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
  "EPIPE",
  "ECONNRESET",
]);

function isBenignRejection(reason: unknown): boolean {
  if (reason instanceof Error) {
    const code = (reason as NodeJS.ErrnoException).code;
    if (code !== undefined && BENIGN_ERROR_CODES.has(code)) return true;
    return /connection closed|connection is disposed|connection disposed/i.test(reason.message);
  }
  return false;
}

function appendDebugLog(line: string): void {
  try {
    appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`, "utf-8");
  } catch {
    // Logging must never throw; it runs inside an uncaught-rejection path.
  }
}

export function installUnhandledRejectionGuard(): void {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason: unknown) => {
    if (isBenignRejection(reason)) {
      const detail = reason instanceof Error ? `${reason.message}${reason.stack ? `\n${reason.stack.split("\n").slice(0, 6).join("\n")}` : ""}` : String(reason);
      appendDebugLog(`unhandledRejection swallowed (transport/stream): ${detail}`);
      return;
    }
    // Not a known-benign rejection: re-throw so pi's uncaughtException
    // handler (terminal restore + exit) runs as usual.
    throw reason;
  });
}
