// pilot-cli-admin.test.ts — tests for resume/retry/logs/worktrees/cost.
//
// One file because they share a "seed an existing run" fixture. Real
// state DB; mocked-where-needed for resume (the actual worker run is
// E2E and gated separately).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runRetry } from "../src/pilot/cli/retry.js";
import { runLogs } from "../src/pilot/cli/logs.js";
import {
  runWorktreesList,
  runWorktreesPrune,
} from "../src/pilot/cli/worktrees.js";
import { runCost } from "../src/pilot/cli/cost.js";
import { runResume } from "../src/pilot/cli/resume.js";
import { openStateDb } from "../src/pilot/state/db.js";
import {
  upsertFromPlan,
  markReady,
  markRunning,
  markSucceeded,
  markFailed,
  setCostUsd,
  getTask,
} from "../src/pilot/state/tasks.js";
import { appendEvent } from "../src/pilot/state/events.js";
import { getStateDbPath, getRunDir } from "../src/pilot/paths.js";
import type { Plan, PlanTask } from "../src/pilot/plan/schema.js";

// --- Fixtures --------------------------------------------------------------

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-cli-admin-"));
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
  fs.writeFileSync(path.join(dir, "README.md"), "x");
  execFileSync("git", ["-C", dir, "add", "README.md"]);
  execFileSync("git", ["-C", dir, "commit", "-m", "init", "--quiet"]);
}

function makePlan(ids: string[]): Plan {
  const tasks: PlanTask[] = ids.map((id) => ({
    id,
    title: `task ${id}`,
    prompt: "p",
    touches: [],
    verify: [],
    depends_on: [],
  }));
  return {
    name: "admin test plan",
    defaults: {
      model: "anthropic/claude-sonnet-4-6",
      agent: "pilot-builder",
      max_turns: 50,
      max_cost_usd: 5,
      verify_after_each: [],
    },
    milestones: [],
    tasks,
  };
}

async function seedRun(args: {
  runId: string;
  status?: "running" | "completed" | "failed";
  planPath?: string;
}): Promise<{ repo: string; pilotBase: string; planPath: string }> {
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  gitInit(repo);
  const pilotBase = path.join(tmp, "pilot-base");
  process.env.GLORIOUS_PILOT_DIR = pilotBase;

  const planPath =
    args.planPath ?? path.join(tmp, "plan.yaml");
  fs.writeFileSync(
    planPath,
    `
name: admin test plan
tasks:
  - id: T1
    title: task T1
    prompt: p
  - id: T2
    title: task T2
    prompt: p
  - id: T3
    title: task T3
    prompt: p
`.trim(),
  );

  const prevCwd = process.cwd();
  process.chdir(repo);
  try {
    await getRunDir(repo, args.runId);
    const dbPath = await getStateDbPath(repo, args.runId);
    const opened = openStateDb(dbPath);
    try {
      const plan = makePlan(["T1", "T2", "T3"]);
      opened.db.run(
        `INSERT INTO runs (id, plan_path, plan_slug, started_at, status) VALUES (?, ?, ?, ?, ?)`,
        [
          args.runId,
          planPath,
          "admin-slug",
          1_700_000_000_000,
          args.status ?? "failed",
        ],
      );
      upsertFromPlan(opened.db, args.runId, plan);

      // T1 succeeded, T2 failed, T3 pending.
      markReady(opened.db, args.runId, "T1");
      markRunning(opened.db, {
        runId: args.runId,
        taskId: "T1",
        sessionId: "s1",
        branch: "pilot/admin-slug/T1",
        worktreePath: path.join(pilotBase, "repo", "pilot", "worktrees", args.runId, "00"),
      });
      setCostUsd(opened.db, args.runId, "T1", 0.50);
      markSucceeded(opened.db, args.runId, "T1");

      markReady(opened.db, args.runId, "T2");
      markRunning(opened.db, {
        runId: args.runId,
        taskId: "T2",
        sessionId: "s2",
        branch: "pilot/admin-slug/T2",
        worktreePath: path.join(pilotBase, "repo", "pilot", "worktrees", args.runId, "00"),
      });
      setCostUsd(opened.db, args.runId, "T2", 1.50);
      markFailed(opened.db, args.runId, "T2", "verify failed: bun test exit 1");

      // Add a couple of events for T2 (used by logs test).
      appendEvent(opened.db, {
        runId: args.runId,
        taskId: "T2",
        kind: "task.started",
        payload: {},
      });
      appendEvent(opened.db, {
        runId: args.runId,
        taskId: "T2",
        kind: "task.verify.failed",
        payload: { command: "bun test", exitCode: 1, timedOut: false, aborted: false },
      });
      appendEvent(opened.db, {
        runId: args.runId,
        taskId: "T2",
        kind: "task.failed",
        payload: { phase: "verify", attempts: 3 },
      });
    } finally {
      opened.close();
    }
    return { repo, pilotBase, planPath };
  } finally {
    process.chdir(prevCwd);
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

async function withRepo<T>(
  setup: { repo: string; pilotBase: string },
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

// --- runRetry --------------------------------------------------------------

describe("runRetry", () => {
  test("resets a failed task to pending; preserves attempts and cost", async () => {
    const setup = await seedRun({ runId: "01ARZ3NDEKTSV4RRFFQ69G5FA1" });
    const r = await withRepo(setup, () =>
      captured(() =>
        runRetry({
          taskId: "T2",
          runId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
        }),
      ),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/T2 reset to pending/);

    // Verify DB state.
    const dbPath = await withRepo(setup, () =>
      getStateDbPath(setup.repo, "01ARZ3NDEKTSV4RRFFQ69G5FA1"),
    );
    const opened = openStateDb(dbPath);
    try {
      const t = getTask(opened.db, "01ARZ3NDEKTSV4RRFFQ69G5FA1", "T2");
      expect(t?.status).toBe("pending");
      expect(t?.attempts).toBe(1); // preserved
      expect(t?.cost_usd).toBe(1.50); // preserved
      expect(t?.session_id).toBeNull();
      expect(t?.last_error).toBeNull();
    } finally {
      opened.close();
    }
  });

  test("exit 1 when task id doesn't exist", async () => {
    const setup = await seedRun({ runId: "01ARZ3NDEKTSV4RRFFQ69G5FA2" });
    const r = await withRepo(setup, () =>
      captured(() =>
        runRetry({
          taskId: "GHOST",
          runId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
        }),
      ),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/GHOST.*not found/);
  });
});

// --- runLogs ---------------------------------------------------------------

describe("runLogs", () => {
  test("text mode prints task header + events", async () => {
    const setup = await seedRun({ runId: "01ARZ3NDEKTSV4RRFFQ69G5FA3" });
    const r = await withRepo(setup, () =>
      captured(() =>
        runLogs({
          taskId: "T2",
          runId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
        }),
      ),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Task T2/);
    expect(r.stdout).toMatch(/session: s2/);
    expect(r.stdout).toMatch(/branch:.*pilot\/admin-slug\/T2/);
    expect(r.stdout).toMatch(/jsonl:/);
    expect(r.stdout).toMatch(/task\.started/);
    expect(r.stdout).toMatch(/task\.verify\.failed.*exit 1.*bun test/);
    expect(r.stdout).toMatch(/task\.failed/);
  });

  test("--json emits parseable array", async () => {
    const setup = await seedRun({ runId: "01ARZ3NDEKTSV4RRFFQ69G5FA4" });
    const r = await withRepo(setup, () =>
      captured(() =>
        runLogs({
          taskId: "T2",
          runId: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
          json: true,
        }),
      ),
    );
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(3);
  });

  test("exit 1 on unknown task id", async () => {
    const setup = await seedRun({ runId: "01ARZ3NDEKTSV4RRFFQ69G5FA5" });
    const r = await withRepo(setup, () =>
      captured(() =>
        runLogs({
          taskId: "GHOST",
          runId: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
        }),
      ),
    );
    expect(r.code).toBe(1);
  });
});

// --- runCost ---------------------------------------------------------------

describe("runCost", () => {
  test("text mode prints per-task lines + total", async () => {
    const setup = await seedRun({ runId: "01ARZ3NDEKTSV4RRFFQ69G5FA6" });
    const r = await withRepo(setup, () =>
      captured(() =>
        runCost({ runId: "01ARZ3NDEKTSV4RRFFQ69G5FA6" }),
      ),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/T1.*succeeded.*\$0\.50/);
    expect(r.stdout).toMatch(/T2.*failed.*\$1\.50/);
    expect(r.stdout).toMatch(/total.*\$2\.00/);
  });

  test("--json emits structured object with total + tasks array", async () => {
    const setup = await seedRun({ runId: "01ARZ3NDEKTSV4RRFFQ69G5FA7" });
    const r = await withRepo(setup, () =>
      captured(() =>
        runCost({ runId: "01ARZ3NDEKTSV4RRFFQ69G5FA7", json: true }),
      ),
    );
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.runId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FA7");
    expect(parsed.total).toBeCloseTo(2.0, 2);
    expect(parsed.tasks).toHaveLength(3);
  });
});

// --- runWorktrees list -----------------------------------------------------

describe("runWorktreesList", () => {
  test("reports 'no pilot worktrees' when none exist on disk", async () => {
    // The seeded run has no actual `git worktree add` calls, just DB
    // entries. So git's worktree list will only contain the main one.
    const setup = await seedRun({ runId: "01ARZ3NDEKTSV4RRFFQ69G5FA8" });
    const r = await withRepo(setup, () =>
      captured(() =>
        runWorktreesList({ runId: "01ARZ3NDEKTSV4RRFFQ69G5FA8" }),
      ),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no pilot worktrees/);
  });
});

// --- runWorktrees prune ----------------------------------------------------

describe("runWorktreesPrune", () => {
  test("conservative default: nothing to prune when run is failed", async () => {
    // Seeded run has run.status='failed', so the conservative default
    // skips pruning.
    const setup = await seedRun({
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
      status: "failed",
    });
    const r = await withRepo(setup, () =>
      captured(() =>
        runWorktreesPrune({
          runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          dryRun: true,
        }),
      ),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/nothing to prune/);
  });

  test("--all enumerates every task's worktree path", async () => {
    const setup = await seedRun({
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
      status: "failed",
    });
    const r = await withRepo(setup, () =>
      captured(() =>
        runWorktreesPrune({
          runId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
          all: true,
          dryRun: true,
        }),
      ),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Would remove/);
  });
});

// --- runResume — error paths ----------------------------------------------

describe("runResume — error paths", () => {
  test("exit 1 when no runs found", async () => {
    const repo = path.join(tmp, "empty-repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    const r = await withRepo(
      { repo, pilotBase: path.join(tmp, "empty-base") },
      () => captured(() => runResume({})),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no runs/);
  });

  test("exit 1 when plan path is broken", async () => {
    // Seed a run pointing at a nonexistent plan path.
    const setup = await seedRun({
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
      planPath: path.join(tmp, "this-does-not-exist.yaml"),
    });
    // Delete the plan to ensure load fails.
    fs.rmSync(setup.planPath, { force: true });
    const r = await withRepo(setup, () =>
      captured(() =>
        runResume({ runId: "01ARZ3NDEKTSV4RRFFQ69G5FAB" }),
      ),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/cannot reload plan/);
  });
});
