// pilot-cli-build.test.ts — tests for src/pilot/cli/build.ts.
//
// `pilot build` orchestrates many subsystems; e2e is gated by
// OPENCODE_E2E=1. Unit tests cover:
//   - --dry-run prints the plan summary and exits 0.
//   - validation failure short-circuits with exit 2.
//   - --filter rejects unknown task ids.
//   - --workers > 1 emits the clamp warning.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  runBuild,
  deriveBranchPrefix,
  startStreamingLogger,
  printSummary,
} from "../src/pilot/cli/build.js";
import { openStateDb } from "../src/pilot/state/db.js";
import { appendEvent } from "../src/pilot/state/events.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-cli-build-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-b", "main", "--quiet", dir], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", dir, "config", "user.email", "t@e.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "T"]);
  execFileSync("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
  // An initial commit so HEAD resolves.
  fs.writeFileSync(path.join(dir, "README.md"), "x");
  execFileSync("git", ["-C", dir, "add", "README.md"]);
  execFileSync("git", ["-C", dir, "commit", "-m", "init", "--quiet"]);
}

const VALID_PLAN = `
name: build cli test
tasks:
  - id: T1
    title: t
    prompt: do
    touches: [src/a.ts]
    verify: ["true"]
  - id: T2
    title: u
    prompt: do
    touches: [src/b.ts]
    verify: ["true"]
    depends_on: [T1]
`.trimStart();

function setupRepoWithPlan(): {
  repo: string;
  pilotBase: string;
  planPath: string;
} {
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  gitInit(repo);
  const pilotBase = path.join(tmp, "pilot-base");
  // Drop the plan file at the plans dir.
  const plansDir = path.join(pilotBase, "repo", "pilot", "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  const planPath = path.join(plansDir, "test-plan.yaml");
  fs.writeFileSync(planPath, VALID_PLAN);
  return { repo, pilotBase, planPath };
}

async function withRepoEnv<T>(
  setup: ReturnType<typeof setupRepoWithPlan>,
  fn: () => Promise<T>,
): Promise<T> {
  const prevCwd = process.cwd();
  const prevEnv = process.env.GLORIOUS_PILOT_DIR;
  process.env.GLORIOUS_PILOT_DIR = setup.pilotBase;
  process.chdir(setup.repo);
  try {
    return await fn();
  } finally {
    process.chdir(prevCwd);
    if (prevEnv === undefined) delete process.env.GLORIOUS_PILOT_DIR;
    else process.env.GLORIOUS_PILOT_DIR = prevEnv;
  }
}

async function captured(
  fn: () => Promise<number>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => {
    err.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  let code: number;
  try {
    code = await fn();
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
  return { stdout: out.join(""), stderr: err.join(""), code };
}

// --- --dry-run ------------------------------------------------------------

describe("runBuild — --dry-run", () => {
  test("exits 0 and prints plan name + tasks", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() => runBuild({ plan: setup.planPath, dryRun: true })),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/--dry-run/);
    expect(r.stdout).toMatch(/build cli test/);
    expect(r.stdout).toMatch(/T1: t/);
    expect(r.stdout).toMatch(/T2: u/);
  });

  test("auto-finds the newest plan when --plan is omitted", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() => runBuild({ dryRun: true })),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/build cli test/);
  });
});

// --- Validation failure ---------------------------------------------------

describe("runBuild — validation", () => {
  test("schema-invalid plan: exit 2", async () => {
    const setup = setupRepoWithPlan();
    const bad = path.join(path.dirname(setup.planPath), "bad.yaml");
    fs.writeFileSync(
      bad,
      `name: bad\ntasks:\n  - id: lowercase\n    title: t\n    prompt: p\n`,
    );
    const r = await withRepoEnv(setup, () =>
      captured(() => runBuild({ plan: bad, dryRun: true })),
    );
    expect(r.code).toBe(2);
  });

  test("missing plan file (via --plan): exit 2", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runBuild({
          plan: path.join(tmp, "nope.yaml"),
          dryRun: true,
        }),
      ),
    );
    // Exit 2 — same exit code as schema-invalid plan, because a missing
    // plan is a resolution-surface problem (user fixes the path). This
    // replaced the v0.1 exit-1 behavior, which was reached via runValidate
    // throwing "cannot stat ...". Now the three-step resolver catches
    // non-existent paths up front and short-circuits with exit 2 + a
    // clear stderr message listing the tried paths.
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/cannot find plan/);
  });
});

// --- --filter -------------------------------------------------------------

describe("runBuild — --filter", () => {
  test("--filter with unknown id exits 2 with stderr", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runBuild({ plan: setup.planPath, filter: "GHOST", dryRun: true }),
      ),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/GHOST.*doesn't match/);
  });

  test("--filter with valid id passes through dry-run", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runBuild({ plan: setup.planPath, filter: "T1", dryRun: true }),
      ),
    );
    expect(r.code).toBe(0);
  });
});

// --- --workers ------------------------------------------------------------

describe("runBuild — --workers", () => {
  test("--workers > 1 logs a clamp warning to stderr", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runBuild({ plan: setup.planPath, dryRun: true, workers: 4 }),
      ),
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/--workers=4/);
    expect(r.stderr).toMatch(/clamping/i);
  });
});

// --- Positional plan arg + three-step resolution --------------------------

describe("runBuild — positional plan arg", () => {
  test("absolute path via positional resolves and dry-runs", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runBuild({ planPositional: setup.planPath, dryRun: true }),
      ),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/build cli test/);
  });

  test("bare filename resolves against plans dir", async () => {
    const setup = setupRepoWithPlan();
    // plan filename is "test-plan.yaml" — pass bare name.
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runBuild({ planPositional: "test-plan.yaml", dryRun: true }),
      ),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/build cli test/);
  });

  test("bare stem (no extension) resolves against plans dir with .yaml appended", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() => runBuild({ planPositional: "test-plan", dryRun: true })),
    );
    expect(r.code).toBe(0);
  });

  test("cwd-relative path resolves when plan lives in cwd", async () => {
    const setup = setupRepoWithPlan();
    // Copy the plan into cwd so a cwd-relative path hits.
    const copyPath = path.join(setup.repo, "local-plan.yaml");
    fs.writeFileSync(copyPath, fs.readFileSync(setup.planPath, "utf8"));
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runBuild({ planPositional: "local-plan.yaml", dryRun: true }),
      ),
    );
    expect(r.code).toBe(0);
  });

  test("positional path that doesn't match any location: exit 2 with tried paths in stderr", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runBuild({ planPositional: "does-not-exist.yaml", dryRun: true }),
      ),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/cannot find plan/);
    expect(r.stderr).toMatch(/Tried:/);
  });

  test("--plan wins over positional when both are supplied", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runBuild({
          plan: setup.planPath,
          planPositional: "does-not-exist.yaml",
          dryRun: true,
        }),
      ),
    );
    expect(r.code).toBe(0);
  });
});

// --- Interactive picker seam ----------------------------------------------

describe("runBuild — interactive picker seam", () => {
  test("readPlanSelection stub returning a path is respected when TTY", async () => {
    const setup = setupRepoWithPlan();
    // Force isTTY true so the TTY branch is taken. Restore after.
    const prevIsTTY = (process.stdin as NodeJS.ReadStream).isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    try {
      const r = await withRepoEnv(setup, () =>
        captured(() =>
          runBuild({
            dryRun: true,
            readPlanSelection: async () => setup.planPath,
          }),
        ),
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/build cli test/);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: prevIsTTY,
        configurable: true,
      });
    }
  });

  test("readPlanSelection returning undefined (Ctrl-C) exits 130", async () => {
    const setup = setupRepoWithPlan();
    const prevIsTTY = (process.stdin as NodeJS.ReadStream).isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    try {
      const r = await withRepoEnv(setup, () =>
        captured(() =>
          runBuild({
            dryRun: true,
            readPlanSelection: async () => undefined,
          }),
        ),
      );
      expect(r.code).toBe(130);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: prevIsTTY,
        configurable: true,
      });
    }
  });

  test("no args, non-TTY: falls back to newest in plans dir", async () => {
    const setup = setupRepoWithPlan();
    // bun test is typically non-TTY; don't force. If it were TTY the
    // test would need readPlanSelection to get past the picker.
    const prevIsTTY = (process.stdin as NodeJS.ReadStream).isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    try {
      const r = await withRepoEnv(setup, () =>
        captured(() => runBuild({ dryRun: true })),
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/build cli test/);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: prevIsTTY,
        configurable: true,
      });
    }
  });
});

// --- Streaming logger (unit test via exported helper) ----------------------

describe("startStreamingLogger", () => {
  test("emits task.started / task.succeeded / run.progress lines", () => {
    const lines: string[] = [];
    const stderrWriter = (s: string) => lines.push(s);

    // Fake subscriber that captures the registered callback so the test
    // can fire synthetic events.
    let cb: ((e: {
      runId: string;
      taskId: string | null;
      kind: string;
      payload: unknown;
      ts: number;
    }) => void) | null = null;
    const subscribe = (handler: typeof cb) => {
      cb = handler;
      return () => {
        cb = null;
      };
    };

    const teardown = startStreamingLogger({
      stderrWriter,
      runId: "RUN1",
      totalTasks: 3,
      subscribe: subscribe as Parameters<
        typeof startStreamingLogger
      >[0]["subscribe"],
      clock: () => 1700000000000,
    });

    // Fire: task T1 starts, passes verify, succeeds.
    cb!({
      runId: "RUN1",
      taskId: "T1",
      kind: "task.started",
      payload: null,
      ts: 1700000000000,
    });
    cb!({
      runId: "RUN1",
      taskId: "T1",
      kind: "task.verify.passed",
      payload: null,
      ts: 1700000010000,
    });
    cb!({
      runId: "RUN1",
      taskId: "T1",
      kind: "task.succeeded",
      payload: null,
      ts: 1700000015000,
    });

    const out = lines.join("");
    expect(out).toMatch(/task\.started T1/);
    expect(out).toMatch(/task\.verify\.passed T1/);
    expect(out).toMatch(/task\.succeeded T1/);
    expect(out).toMatch(/run\.progress 1\/3 succeeded/);

    teardown();
  });

  test("filters events from other runs", () => {
    const lines: string[] = [];
    let cb:
      | ((e: {
          runId: string;
          taskId: string | null;
          kind: string;
          payload: unknown;
          ts: number;
        }) => void)
      | null = null;
    const subscribe = (handler: typeof cb) => {
      cb = handler;
      return () => {
        cb = null;
      };
    };
    const teardown = startStreamingLogger({
      stderrWriter: (s: string) => lines.push(s),
      runId: "RUN1",
      totalTasks: 2,
      subscribe: subscribe as Parameters<
        typeof startStreamingLogger
      >[0]["subscribe"],
      clock: () => 1700000000000,
    });
    cb!({
      runId: "OTHER_RUN",
      taskId: "T1",
      kind: "task.started",
      payload: null,
      ts: 1700000000000,
    });
    expect(lines.join("")).toBe("");
    teardown();
  });

  test("suppresses chatty kinds (task.session.created etc.)", () => {
    const lines: string[] = [];
    let cb:
      | ((e: {
          runId: string;
          taskId: string | null;
          kind: string;
          payload: unknown;
          ts: number;
        }) => void)
      | null = null;
    const subscribe = (handler: typeof cb) => {
      cb = handler;
      return () => {
        cb = null;
      };
    };
    const teardown = startStreamingLogger({
      stderrWriter: (s: string) => lines.push(s),
      runId: "RUN1",
      totalTasks: 1,
      subscribe: subscribe as Parameters<
        typeof startStreamingLogger
      >[0]["subscribe"],
      clock: () => 1700000000000,
    });
    cb!({
      runId: "RUN1",
      taskId: "T1",
      kind: "task.session.created",
      payload: null,
      ts: 1700000000000,
    });
    cb!({
      runId: "RUN1",
      taskId: "T1",
      kind: "task.attempt",
      payload: null,
      ts: 1700000000001,
    });
    expect(lines.join("")).toBe("");
    teardown();
  });

  test("prints phase and reason on task.failed", () => {
    const lines: string[] = [];
    let cb:
      | ((e: {
          runId: string;
          taskId: string | null;
          kind: string;
          payload: unknown;
          ts: number;
        }) => void)
      | null = null;
    const subscribe = (handler: typeof cb) => {
      cb = handler;
      return () => {
        cb = null;
      };
    };
    const teardown = startStreamingLogger({
      stderrWriter: (s: string) => lines.push(s),
      runId: "RUN1",
      totalTasks: 1,
      subscribe: subscribe as Parameters<
        typeof startStreamingLogger
      >[0]["subscribe"],
      clock: () => 1700000000000,
    });
    cb!({
      runId: "RUN1",
      taskId: "T1",
      kind: "task.started",
      payload: null,
      ts: 1700000000000,
    });
    cb!({
      runId: "RUN1",
      taskId: "T1",
      kind: "task.failed",
      payload: {
        phase: "waitForIdle.stall",
        reason: "stalled after 300000ms (0 events, last none)",
      },
      ts: 1700000300000,
    });

    const out = lines.join("");
    // Original header line still present.
    expect(out).toMatch(/task\.failed T1 in \d+s/);
    // New continuation line with phase + reason.
    expect(out).toMatch(
      /→ waitForIdle\.stall: stalled after 300000ms \(0 events, last none\)/,
    );
    teardown();
  });

  test("de-noises blocked cascade", () => {
    const lines: string[] = [];
    let cb:
      | ((e: {
          runId: string;
          taskId: string | null;
          kind: string;
          payload: unknown;
          ts: number;
        }) => void)
      | null = null;
    const subscribe = (handler: typeof cb) => {
      cb = handler;
      return () => {
        cb = null;
      };
    };
    const teardown = startStreamingLogger({
      stderrWriter: (s: string) => lines.push(s),
      runId: "RUN1",
      totalTasks: 6,
      subscribe: subscribe as Parameters<
        typeof startStreamingLogger
      >[0]["subscribe"],
      clock: () => 1700000000000,
    });

    // Fire 5 blocked events — none should appear as individual lines.
    for (let i = 0; i < 5; i++) {
      cb!({
        runId: "RUN1",
        taskId: `T${i + 2}`,
        kind: "task.blocked",
        payload: {
          reason: "dependency \"T1\" failed",
        },
        ts: 1700000000000 + i,
      });
    }
    // Pre-finished: no blocked lines at all, and no summary.
    expect(lines.join("")).not.toMatch(/task\.blocked/);
    expect(lines.join("")).not.toMatch(/blocked:/);

    // run.finished triggers the summary flush.
    cb!({
      runId: "RUN1",
      taskId: null,
      kind: "run.finished",
      payload: null,
      ts: 1700000100000,
    });

    const out = lines.join("");
    // Still no per-event blocked lines.
    expect(out).not.toMatch(/task\.blocked/);
    // One summary line with count + first-reason.
    expect(out).toMatch(
      /blocked: 5 task\(s\) waiting on failed dependency \(dependency "T1" failed\)/,
    );

    teardown();
  });

  test("tolerates task.failed without phase/reason", () => {
    const lines: string[] = [];
    let cb:
      | ((e: {
          runId: string;
          taskId: string | null;
          kind: string;
          payload: unknown;
          ts: number;
        }) => void)
      | null = null;
    const subscribe = (handler: typeof cb) => {
      cb = handler;
      return () => {
        cb = null;
      };
    };
    const teardown = startStreamingLogger({
      stderrWriter: (s: string) => lines.push(s),
      runId: "RUN1",
      totalTasks: 1,
      subscribe: subscribe as Parameters<
        typeof startStreamingLogger
      >[0]["subscribe"],
      clock: () => 1700000000000,
    });
    cb!({
      runId: "RUN1",
      taskId: "T1",
      kind: "task.started",
      payload: null,
      ts: 1700000000000,
    });
    cb!({
      runId: "RUN1",
      taskId: "T1",
      kind: "task.failed",
      payload: null, // no phase/reason — legacy payload shape
      ts: 1700000010000,
    });

    const out = lines.join("");
    // Base line prints.
    expect(out).toMatch(/task\.failed T1 in \d+s/);
    // No continuation line.
    expect(out).not.toMatch(/→/);
    teardown();
  });
});

// --- Branch naming (regression guard for cross-run worktree collision) ----

describe("deriveBranchPrefix — runId scoping", () => {
  test("default prefix includes runId segment", () => {
    const prefix = deriveBranchPrefix(
      undefined,
      "rule-engine",
      "01KQ490FASZ71YZYY0SMKC3B6Q",
    );
    expect(prefix).toBe(
      "pilot/rule-engine/01KQ490FASZ71YZYY0SMKC3B6Q",
    );
  });

  test("user-supplied plan.branch_prefix still gets runId appended", () => {
    const prefix = deriveBranchPrefix(
      "my-custom/prefix",
      "ignored-slug",
      "01KQ490FASZ71YZYY0SMKC3B6Q",
    );
    expect(prefix).toBe(
      "my-custom/prefix/01KQ490FASZ71YZYY0SMKC3B6Q",
    );
  });

  test("two different runIds produce non-colliding prefixes (the whole point)", () => {
    const run1 = deriveBranchPrefix(undefined, "slug", "01AAAAAAAAAAAAAAAAAAAAAAAA");
    const run2 = deriveBranchPrefix(undefined, "slug", "01BBBBBBBBBBBBBBBBBBBBBBBB");
    expect(run1).not.toBe(run2);
    // And — structurally — neither is a prefix of the other, so a per-task
    // branch under run1 cannot be re-bound by a task under run2.
    const task1 = `${run1}/T1-AUDIT`;
    const task2 = `${run2}/T1-AUDIT`;
    expect(task1).not.toBe(task2);
  });

  test("runId is the LAST segment before the task id (so <prefix>/<taskId> always contains the runId)", () => {
    const prefix = deriveBranchPrefix(undefined, "slug", "01RUNID");
    const taskBranch = `${prefix}/T1`;
    // The runId must appear BEFORE the taskId segment, not after — the
    // pool constructs `<branchPrefix>/<taskId>`, so runId must be in the
    // prefix, not appended to the full name.
    const segs = taskBranch.split("/");
    expect(segs).toEqual(["pilot", "slug", "01RUNID", "T1"]);
  });
});

// --- printSummary — failure block ----------------------------------------
//
// When a run has failed or aborted tasks, the stdout summary renders a
// per-task block with phase / reason / session / worktree / elapsed /
// attempts. Successful runs render identically to pre-v0.2 (no empty
// "Failed tasks (0):" heading). Both verified here against an in-memory
// state DB with pre-inserted rows + events.

describe("printSummary — failure block", () => {
  /**
   * Capture process.stdout.write calls for the duration of `fn`, then
   * restore. Returns the accumulated output as a string.
   */
  function captureStdout(fn: () => void): string {
    const orig = process.stdout.write.bind(process.stdout);
    const chunks: string[] = [];
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (
      s: string,
    ) => {
      chunks.push(s);
      return true;
    };
    try {
      fn();
    } finally {
      (process.stdout as unknown as { write: typeof orig }).write = orig;
    }
    return chunks.join("");
  }

  test("renders per-failed-task block with phase / reason / session / worktree", () => {
    const opened = openStateDb(":memory:");
    try {
      const runId = "01TESTRUN";
      // Seed a minimal run row + two task rows (one failed, one aborted).
      opened.db.run(
        `INSERT INTO runs (id, plan_path, plan_slug, started_at, status)
         VALUES (?, ?, ?, ?, 'failed')`,
        [runId, "/plan.yaml", "test", 1_700_000_000_000],
      );
      opened.db.run(
        `INSERT INTO tasks (run_id, task_id, status, attempts, session_id,
                            branch, worktree_path, started_at, finished_at,
                            cost_usd, last_error)
         VALUES (?, 'T1-STALL', 'failed', 1, 'ses_abc123',
                 'pilot/test/T1-STALL', '/tmp/wt/00',
                 1700000000000, 1700000306000,
                 0, 'stalled after 300000ms (0 events, last none)')`,
        [runId],
      );
      opened.db.run(
        `INSERT INTO tasks (run_id, task_id, status, attempts, session_id,
                            branch, worktree_path, started_at, finished_at,
                            cost_usd, last_error)
         VALUES (?, 'T3-PREPFAIL', 'failed', 0, NULL,
                 NULL, NULL,
                 1700000306000, 1700000306000,
                 0, 'worktree prepare failed: slot 0 is preserved')`,
        [runId],
      );

      // Write matching task.failed events so resolveFailureDetail can
      // pull phase from the payload. T1 gets the rich post-v0.2 shape;
      // T3 gets the pre-v0.2 shape (phase only, no reason) to verify
      // the fallback-to-last_error path.
      appendEvent(opened.db, {
        runId,
        taskId: "T1-STALL",
        kind: "task.failed",
        payload: {
          phase: "waitForIdle.stall",
          reason: "stalled after 300000ms (0 events, last none)",
          stallMs: 300000,
          eventCount: 0,
          lastEventTs: null,
        },
      });
      appendEvent(opened.db, {
        runId,
        taskId: "T3-PREPFAIL",
        kind: "task.failed",
        payload: { phase: "prepare" }, // no reason — test falls back to last_error
      });

      const output = captureStdout(() => {
        printSummary({
          planPath: "/plan.yaml",
          runId,
          runDir: "/runs/01TESTRUN",
          counts: {
            pending: 0,
            ready: 0,
            running: 0,
            succeeded: 0,
            failed: 2,
            aborted: 0,
            blocked: 0,
          },
          finalStatus: "failed",
          db: opened.db,
        });
      });

      // Counts line still present (back-compat).
      expect(output).toMatch(/Run 01TESTRUN failed/);
      expect(output).toMatch(/succeeded=0 failed=2/);
      // Failed tasks block heading.
      expect(output).toMatch(/Failed tasks \(2\):/);
      // T1 block — phase + reason from the event payload.
      expect(output).toMatch(/T1-STALL/);
      expect(output).toMatch(/phase: {4}waitForIdle\.stall/);
      expect(output).toMatch(
        /reason: {3}stalled after 300000ms \(0 events, last none\)/,
      );
      expect(output).toMatch(/session: {2}ses_abc123/);
      expect(output).toMatch(/worktree: \/tmp\/wt\/00/);
      expect(output).toMatch(/elapsed: {2}306s {3}attempts: 1/);
      // T3 block — phase from event, reason falls back to last_error.
      expect(output).toMatch(/T3-PREPFAIL/);
      expect(output).toMatch(/phase: {4}prepare/);
      expect(output).toMatch(/reason: {3}worktree prepare failed/);
      // T3 placeholders for session + worktree (both null).
      expect(output).toMatch(/session: {2}\(none — failed before session\.create\)/);
      expect(output).toMatch(/worktree: \(none\)/);
      expect(output).toMatch(/elapsed: {2}0s {3}attempts: 0/);

      // Follow-up commands follow the block (order check).
      const taskBlockIdx = output.indexOf("Failed tasks");
      const statusIdx = output.indexOf("pilot status --run");
      expect(taskBlockIdx).toBeGreaterThan(-1);
      expect(statusIdx).toBeGreaterThan(taskBlockIdx);
    } finally {
      opened.close();
    }
  });

  test("skips the failure block on successful runs", () => {
    const opened = openStateDb(":memory:");
    try {
      const runId = "01CLEANRUN";
      opened.db.run(
        `INSERT INTO runs (id, plan_path, plan_slug, started_at, status)
         VALUES (?, ?, ?, ?, 'completed')`,
        [runId, "/plan.yaml", "test", 1_700_000_000_000],
      );
      opened.db.run(
        `INSERT INTO tasks (run_id, task_id, status, attempts, session_id,
                            branch, worktree_path, started_at, finished_at,
                            cost_usd, last_error)
         VALUES (?, 'T1', 'succeeded', 1, 'ses_ok', 'pilot/test/T1',
                 '/tmp/wt/00', 1700000000000, 1700000010000, 0, NULL)`,
        [runId],
      );

      const output = captureStdout(() => {
        printSummary({
          planPath: "/plan.yaml",
          runId,
          runDir: "/runs/01CLEANRUN",
          counts: {
            pending: 0,
            ready: 0,
            running: 0,
            succeeded: 1,
            failed: 0,
            aborted: 0,
            blocked: 0,
          },
          finalStatus: "completed",
          db: opened.db,
        });
      });

      expect(output).toMatch(/Run 01CLEANRUN completed/);
      expect(output).not.toMatch(/Failed tasks/);
      // Follow-ups still present.
      expect(output).toMatch(/pilot status --run/);
      expect(output).toMatch(/pilot logs --run/);
    } finally {
      opened.close();
    }
  });
});
