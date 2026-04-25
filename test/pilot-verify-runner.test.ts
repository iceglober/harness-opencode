// pilot-verify-runner.test.ts — tests for src/pilot/verify/runner.ts.
//
// Real bash subprocesses (pilot's verify commands ARE shell commands;
// mocking would defeat the purpose). Each test cwd's into a tmp dir to
// avoid touching the working tree.
//
// Coverage targets (Phase D4 of PILOT_TODO.md):
//   - pass single command
//   - fail single command (non-zero exit)
//   - multiple commands, all pass
//   - multiple commands, one fails (short-circuits, returns failing result)
//   - timeout (slow command exceeds timeoutMs)
//   - abort via signal
//   - output capture (stdout, stderr, interleaved)
//   - onLine streaming callback
//   - output truncation cap
//   - cwd is honored

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  runVerify,
  runOne,
} from "../src/pilot/verify/runner.js";

// --- Fixtures --------------------------------------------------------------

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-runner-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- runOne — happy + failure ----------------------------------------------

describe("runOne — basic exit codes", () => {
  test("returns ok=true on exit 0", async () => {
    const r = await runOne("true", { cwd: tmp });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.exitCode).toBe(0);
    expect(r.command).toBe("true");
  });

  test("returns ok=false on non-zero exit, with the exit code", async () => {
    const r = await runOne("exit 7", { cwd: tmp });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.exitCode).toBe(7);
    expect(r.timedOut).toBe(false);
    expect(r.aborted).toBe(false);
  });

  test("captures stdout", async () => {
    const r = await runOne("echo hello-from-runner", { cwd: tmp });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("hello-from-runner");
  });

  test("captures stderr", async () => {
    const r = await runOne("echo to-stderr 1>&2; exit 0", { cwd: tmp });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("to-stderr");
  });

  test("captures both stdout and stderr", async () => {
    const r = await runOne(
      "echo on-out; echo on-err 1>&2; exit 1",
      { cwd: tmp },
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain("on-out");
    expect(r.output).toContain("on-err");
  });

  test("durationMs is plausible", async () => {
    const r = await runOne("sleep 0.05", { cwd: tmp });
    expect(r.durationMs).toBeGreaterThanOrEqual(40);
  });
});

// --- runOne — input validation ---------------------------------------------

describe("runOne — input validation", () => {
  test("throws on empty command", async () => {
    await expect(runOne("", { cwd: tmp })).rejects.toThrow(/non-empty/);
  });

  test("throws on missing cwd", async () => {
    // @ts-expect-error testing bad input
    await expect(runOne("true", {})).rejects.toThrow(/cwd/);
  });
});

// --- runOne — cwd, env -----------------------------------------------------

describe("runOne — cwd / env", () => {
  test("commands execute in the provided cwd", async () => {
    fs.writeFileSync(path.join(tmp, "marker.txt"), "");
    const r = await runOne("ls marker.txt", { cwd: tmp });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("marker.txt");
  });

  test("env overrides take precedence over process.env", async () => {
    const r = await runOne(
      'echo "$PILOT_TEST_VAR"',
      { cwd: tmp, env: { ...process.env, PILOT_TEST_VAR: "from-runner" } },
    );
    expect(r.output).toContain("from-runner");
  });
});

// --- runOne — timeout / abort ----------------------------------------------

describe("runOne — timeout", () => {
  test("kills a long-running command after timeoutMs", async () => {
    const r = await runOne("sleep 5", { cwd: tmp, timeoutMs: 200 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.timedOut).toBe(true);
    // Should not have waited the full 5s.
    expect(r.durationMs).toBeLessThan(2_500);
  });
});

describe("runOne — abort", () => {
  test("returns aborted=true when abortSignal aborts mid-run", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const r = await runOne("sleep 5", {
      cwd: tmp,
      timeoutMs: 60_000,
      abortSignal: ctrl.signal,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.aborted).toBe(true);
  });

  test("pre-aborted signal kills before run completes", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await runOne("sleep 5", {
      cwd: tmp,
      timeoutMs: 60_000,
      abortSignal: ctrl.signal,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.aborted).toBe(true);
  });
});

// --- runOne — output streaming ---------------------------------------------

describe("runOne — onLine streaming", () => {
  test("delivers each line of stdout to onLine", async () => {
    const lines: Array<{ stream: string; line: string }> = [];
    const r = await runOne(
      "printf 'a\\nb\\nc\\n'",
      {
        cwd: tmp,
        onLine: ({ stream, line }) => lines.push({ stream, line }),
      },
    );
    expect(r.ok).toBe(true);
    expect(lines.map((l) => l.line)).toEqual(["a", "b", "c"]);
    expect(lines.every((l) => l.stream === "stdout")).toBe(true);
  });

  test("flushes a trailing line without a final newline", async () => {
    const lines: string[] = [];
    await runOne("printf 'no-newline-end'", {
      cwd: tmp,
      onLine: ({ line }) => lines.push(line),
    });
    expect(lines).toEqual(["no-newline-end"]);
  });

  test("tags stderr lines with stream='stderr'", async () => {
    const seen: Array<{ stream: string; line: string }> = [];
    await runOne("echo x 1>&2", {
      cwd: tmp,
      onLine: ({ stream, line }) => seen.push({ stream, line }),
    });
    expect(seen.find((s) => s.stream === "stderr" && s.line === "x")).toBeDefined();
  });
});

// --- runOne — truncation ---------------------------------------------------

describe("runOne — output cap / truncation", () => {
  test("truncates output that exceeds outputCapBytes; appends sentinel", async () => {
    // Generate 4KB of output; cap at 1KB.
    const r = await runOne(
      "printf '%4096s' x",
      { cwd: tmp, outputCapBytes: 1024 },
    );
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/truncated/);
    expect(r.output.length).toBeLessThanOrEqual(1024 + 200); // cap + sentinel
  });

  test("does NOT truncate output below the cap", async () => {
    const r = await runOne("echo ok", { cwd: tmp, outputCapBytes: 1024 });
    expect(r.output).not.toMatch(/truncated/);
    expect(r.output).toContain("ok");
  });
});

// --- runVerify — multi-command ---------------------------------------------

describe("runVerify — multi-command", () => {
  test("runs every command in order on success", async () => {
    const r = await runVerify(
      ["echo first", "echo second", "echo third"],
      { cwd: tmp },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.results.map((x) => x.command)).toEqual([
      "echo first",
      "echo second",
      "echo third",
    ]);
    expect(r.results.every((x) => x.ok)).toBe(true);
  });

  test("short-circuits at the first failure; returns the failing command", async () => {
    const r = await runVerify(
      ["echo a", "exit 7", "echo never"],
      { cwd: tmp },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.command).toBe("exit 7");
    expect(r.failure.exitCode).toBe(7);
    // results includes the partial run up to and including the failure.
    expect(r.results.length).toBe(2);
    expect(r.results[0]!.command).toBe("echo a");
    expect(r.results[1]).toBe(r.failure);
  });

  test("empty commands list returns ok with empty results", async () => {
    const r = await runVerify([], { cwd: tmp });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.results).toEqual([]);
  });

  test("propagates timeout to a single command", async () => {
    const r = await runVerify(
      ["echo fast", "sleep 5", "echo never"],
      { cwd: tmp, timeoutMs: 200 },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.command).toBe("sleep 5");
    expect(r.failure.timedOut).toBe(true);
  });

  test("propagates abort to a single command", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const r = await runVerify(
      ["sleep 5"],
      { cwd: tmp, timeoutMs: 60_000, abortSignal: ctrl.signal },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.aborted).toBe(true);
  });

  test("onLine fires across all commands with the right `command` tag", async () => {
    const seen: string[] = [];
    await runVerify(
      ["echo a", "echo b"],
      {
        cwd: tmp,
        onLine: ({ command, line }) => seen.push(`${command}|${line}`),
      },
    );
    expect(seen).toContain("echo a|a");
    expect(seen).toContain("echo b|b");
  });
});
