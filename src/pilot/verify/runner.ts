/**
 * Verify-command runner.
 *
 * Each task carries a `verify` list of shell commands. After the agent
 * reports done, the worker runs every command in order via `bash -c`.
 * The first command that fails (non-zero exit, signal kill, or
 * timeout) short-circuits the whole verify pass and the worker enters
 * the fix loop.
 *
 * Why `bash -c` and not `execFile`-style argv:
 *   - Verify commands routinely use shell features (pipes, redirection,
 *     `&&`-chaining, env-var interpolation). Forcing argv would require
 *     plan authors to wrap everything in a script file or inline `bash
 *     -c` themselves.
 *   - The schema layer (`schema.ts`) already validates each entry is a
 *     non-empty string. Treating it as a shell command is the natural
 *     interpretation.
 *
 * Risk: a malicious `pilot.yaml` can shell-inject. That risk is
 * inherent — pilot plans run as arbitrary instructions to a
 * code-editing agent; the verify field is no more dangerous than
 * the prompt itself. We don't try to sandbox at this layer.
 *
 * Output handling:
 *   - stdout and stderr are interleaved into a single `output` string,
 *     ordered by arrival (best-effort — we use Node's chunk events,
 *     which are not guaranteed to interleave perfectly between fds,
 *     but they're close enough for verify failure reporting).
 *   - Output is buffered in memory AND streamed line-by-line to an
 *     optional `onLine` callback (Phase E1's worker pipes this to the
 *     per-worker JSONL log).
 *   - Output is truncated to a configurable byte cap (default 256KB)
 *     to prevent a runaway test from blowing memory. Truncation is
 *     marked with a sentinel line.
 *
 * Ship-checklist alignment: Phase D4 of `PILOT_TODO.md`.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

// --- Constants -------------------------------------------------------------

/**
 * Default per-command timeout. 5 minutes is generous enough for most
 * test suites (`bun test` on a medium repo, `cargo test` on small),
 * not so long that a hung process burns the worker's wall time.
 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Default output cap. 256 KB is enough to capture a typical
 * test-failure dump without hoarding memory across many failed
 * verify attempts.
 */
const DEFAULT_OUTPUT_CAP_BYTES = 256 * 1024;

const TRUNCATION_NOTICE = "\n[pilot] verify output truncated\n";

// --- Public types ----------------------------------------------------------

export type RunVerifyOptions = {
  /** Working directory for the commands (the task's worktree path). */
  cwd: string;

  /**
   * Per-command timeout. Default 5min. The runner kills the process
   * tree when this expires (SIGTERM, then SIGKILL after 2s grace).
   */
  timeoutMs?: number;

  /**
   * Maximum captured output per command. Default 256KB. Excess is
   * dropped with a truncation notice appended to the buffer.
   */
  outputCapBytes?: number;

  /**
   * Optional line streaming callback. Called once per output line
   * (split on `\n`) for both stdout and stderr. Used by the worker
   * to write to a JSONL log without buffering.
   */
  onLine?: (args: {
    stream: "stdout" | "stderr";
    line: string;
    command: string;
  }) => void;

  /**
   * Optional abort signal — when aborted, the in-flight command is
   * killed and the runner returns a fail result.
   */
  abortSignal?: AbortSignal;

  /**
   * Optional environment overrides. Defaults to inheriting
   * process.env. Use to set CI-specific vars, test secrets, etc.
   */
  env?: NodeJS.ProcessEnv;
};

export type CommandFailure = {
  ok: false;
  command: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  /** True if the failure was caused by a timeout (signal forced). */
  timedOut: boolean;
  /** True if aborted via `abortSignal`. */
  aborted: boolean;
  /** Captured output (may be truncated). */
  output: string;
  /** Time the command ran, in milliseconds. */
  durationMs: number;
};

export type CommandSuccess = {
  ok: true;
  command: string;
  exitCode: 0;
  output: string;
  durationMs: number;
};

export type CommandResult = CommandSuccess | CommandFailure;

export type RunVerifyResult =
  | { ok: true; results: CommandSuccess[] }
  | {
      ok: false;
      results: CommandResult[]; // includes the failing command at the end
      failure: CommandFailure;
    };

// --- Public API ------------------------------------------------------------

/**
 * Run the given verify commands in order. Stops at the first failure
 * and returns a `RunVerifyResult`. On total success, runs every
 * command and returns `ok: true`.
 *
 * Empty `commands` array short-circuits to `ok: true` with an empty
 * results list — it's the worker's responsibility to decide what
 * "no verify" means semantically.
 */
export async function runVerify(
  commands: ReadonlyArray<string>,
  options: RunVerifyOptions,
): Promise<RunVerifyResult> {
  const results: CommandResult[] = [];
  for (const command of commands) {
    const result = await runOne(command, options);
    results.push(result);
    if (!result.ok) {
      return { ok: false, results, failure: result };
    }
  }
  return {
    ok: true,
    results: results as CommandSuccess[],
  };
}

/**
 * Run a single shell command via `bash -c`. Exposed for callers that
 * need granular control (e.g. a future `pilot doctor` that runs
 * single environment checks). The worker uses `runVerify` instead.
 */
export async function runOne(
  command: string,
  options: RunVerifyOptions,
): Promise<CommandResult> {
  if (typeof command !== "string" || command.length === 0) {
    throw new TypeError(`runOne: command must be a non-empty string`);
  }
  if (typeof options.cwd !== "string" || options.cwd.length === 0) {
    throw new TypeError(`runOne: options.cwd is required and must be non-empty`);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputCap = options.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES;

  const startedAt = Date.now();
  const buffer: string[] = [];
  let bufferBytes = 0;
  let truncated = false;

  // Per-stream line splitters. Output arrives in chunks that may not
  // align with line boundaries; we buffer the trailing partial line
  // and flush it on close.
  const streamState: Record<"stdout" | "stderr", { partial: string }> = {
    stdout: { partial: "" },
    stderr: { partial: "" },
  };

  const child: ChildProcess = spawn("bash", ["-c", command], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let timedOut = false;
  let aborted = false;

  // Timeout handling — SIGTERM then SIGKILL.
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, timeoutMs);

  // Abort handling.
  const onAbort = (): void => {
    aborted = true;
    killTree(child);
  };
  if (options.abortSignal) {
    if (options.abortSignal.aborted) {
      onAbort();
    } else {
      options.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const handleChunk = (
    stream: "stdout" | "stderr",
    chunk: Buffer | string,
  ): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (!truncated) {
      const remaining = outputCap - bufferBytes;
      if (remaining <= 0) {
        truncated = true;
        buffer.push(TRUNCATION_NOTICE);
      } else if (text.length > remaining) {
        buffer.push(text.slice(0, remaining));
        bufferBytes = outputCap;
        truncated = true;
        buffer.push(TRUNCATION_NOTICE);
      } else {
        buffer.push(text);
        bufferBytes += text.length;
      }
    }

    if (options.onLine) {
      const state = streamState[stream];
      const combined = state.partial + text;
      const lines = combined.split("\n");
      state.partial = lines.pop()!; // keep trailing partial
      for (const line of lines) {
        options.onLine({ stream, line, command });
      }
    }
  };

  child.stdout?.on("data", (c) => handleChunk("stdout", c));
  child.stderr?.on("data", (c) => handleChunk("stderr", c));

  // Wait for exit.
  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    let resolved = false;
    const finalize = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      if (resolved) return;
      resolved = true;
      resolve({ code, signal });
    };
    child.on("error", (err) => {
      // Spawn-time errors (e.g. ENOENT for bash itself) — surface as
      // exit -1 with the message as output.
      if (!truncated) {
        buffer.push(`\n[pilot] runner spawn error: ${err.message}\n`);
      }
      finalize(-1, null);
    });
    child.on("exit", (c, s) => finalize(c, s));
  });

  clearTimeout(timeoutHandle);
  if (options.abortSignal) {
    options.abortSignal.removeEventListener("abort", onAbort);
  }

  // Flush any trailing partial lines.
  if (options.onLine) {
    for (const stream of ["stdout", "stderr"] as const) {
      const partial = streamState[stream].partial;
      if (partial.length > 0) {
        options.onLine({ stream, line: partial, command });
      }
    }
  }

  const output = buffer.join("");
  const durationMs = Date.now() - startedAt;

  if (code === 0 && !timedOut && !aborted) {
    return {
      ok: true,
      command,
      exitCode: 0,
      output,
      durationMs,
    };
  }
  return {
    ok: false,
    command,
    exitCode: code ?? -1,
    signal,
    timedOut,
    aborted,
    output,
    durationMs,
  };
}

// --- Internals -------------------------------------------------------------

/**
 * Kill the child and any descendants. Send SIGTERM first; if the
 * process is still alive after 2s, send SIGKILL. The 2s grace lets
 * test frameworks finish writing failure output.
 *
 * NB: the child was spawned with `bash -c <command>`, so the bash
 * process is the parent of any test runner, server, etc. We send the
 * signal to bash; on Linux/macOS, bash forwards SIGTERM to its job
 * group, which propagates to descendants.
 */
function killTree(child: ChildProcess): void {
  if (!child.pid || child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Already dead.
    return;
  }
  setTimeout(() => {
    if (!child.killed && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // best effort
      }
    }
  }, 2_000).unref();
}
