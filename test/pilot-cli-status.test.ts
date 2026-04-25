// pilot-cli-status.test.ts — tests for src/pilot/cli/status.ts.
//
// Build a state DB at the canonical path with seeded run + task data,
// then exercise both text and --json rendering.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runStatus } from "../src/pilot/cli/status.js";
import { openStateDb } from "../src/pilot/state/db.js";
import { upsertFromPlan, markReady, markRunning, markSucceeded, markFailed, setCostUsd } from "../src/pilot/state/tasks.js";
import { getStateDbPath, getRunDir } from "../src/pilot/paths.js";
import type { Plan, PlanTask } from "../src/pilot/plan/schema.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-cli-status-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-b", "main", "--quiet", dir], {
    stdio: "ignore",
  });
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
    name: "status test plan",
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

async function setupSeededRun(args: {
  runId: string;
  status?: "running" | "completed" | "failed";
}): Promise<{ repo: string; pilotBase: string; dbPath: string }> {
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  gitInit(repo);
  const pilotBase = path.join(tmp, "pilot-base");
  process.env.GLORIOUS_PILOT_DIR = pilotBase;

  const prevCwd = process.cwd();
  process.chdir(repo);
  try {
    // Pre-create the runDir (paths helper does this).
    await getRunDir(repo, args.runId);
    const dbPath = await getStateDbPath(repo, args.runId);
    const opened = openStateDb(dbPath);
    try {
      // Seed run + tasks.
      const plan = makePlan(["T1", "T2", "T3"]);
      opened.db.run(
        `INSERT INTO runs (id, plan_path, plan_slug, started_at, status) VALUES (?, ?, ?, ?, ?)`,
        [
          args.runId,
          "/tmp/test-plan.yaml",
          "test-slug",
          1_700_000_000_000,
          args.status ?? "running",
        ],
      );
      upsertFromPlan(opened.db, args.runId, plan);

      // T1 succeeded (with cost), T2 failed, T3 still pending.
      markReady(opened.db, args.runId, "T1");
      markRunning(opened.db, {
        runId: args.runId,
        taskId: "T1",
        sessionId: "ses_1",
        branch: "pilot/test-slug/T1",
        worktreePath: "/wt/0",
      });
      setCostUsd(opened.db, args.runId, "T1", 0.42);
      markSucceeded(opened.db, args.runId, "T1");

      markReady(opened.db, args.runId, "T2");
      markRunning(opened.db, {
        runId: args.runId,
        taskId: "T2",
        sessionId: "ses_2",
        branch: "pilot/test-slug/T2",
        worktreePath: "/wt/0",
      });
      setCostUsd(opened.db, args.runId, "T2", 1.10);
      markFailed(opened.db, args.runId, "T2", "verify failed: bun test exit 1");
    } finally {
      opened.close();
    }
    return { repo, pilotBase, dbPath };
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

async function withRepo(
  setup: { repo: string; pilotBase: string },
  fn: () => Promise<number>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const prevCwd = process.cwd();
  const prevEnv = process.env.GLORIOUS_PILOT_DIR;
  process.env.GLORIOUS_PILOT_DIR = setup.pilotBase;
  process.chdir(setup.repo);
  try {
    return await captured(fn);
  } finally {
    process.chdir(prevCwd);
    if (prevEnv === undefined) delete process.env.GLORIOUS_PILOT_DIR;
    else process.env.GLORIOUS_PILOT_DIR = prevEnv;
  }
}

// --- Tests -----------------------------------------------------------------

describe("runStatus — text mode", () => {
  test("prints run + task summary including counts and per-task lines", async () => {
    const setup = await setupSeededRun({
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
    });
    const r = await withRepo(setup, () => runStatus({ runId: "01ARZ3NDEKTSV4RRFFQ69G5FA1" }));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Run 01ARZ3NDEKTSV4RRFFQ69G5FA1/);
    expect(r.stdout).toMatch(/succeeded=1/);
    expect(r.stdout).toMatch(/failed=1/);
    expect(r.stdout).toMatch(/pending=1/);
    expect(r.stdout).toMatch(/T1.*succeeded.*\$0\.42/);
    expect(r.stdout).toMatch(/T2.*failed.*\$1\.10/);
    expect(r.stdout).toMatch(/last_error: verify failed/);
    expect(r.stdout).toMatch(/T3.*pending/);
  });

  test("auto-discovers latest run when --run is omitted", async () => {
    const setup = await setupSeededRun({
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
    });
    const r = await withRepo(setup, () => runStatus({}));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/01ARZ3NDEKTSV4RRFFQ69G5FA2/);
  });
});

describe("runStatus — JSON mode", () => {
  test("--json emits parseable output with run + tasks + counts", async () => {
    const setup = await setupSeededRun({
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
    });
    const r = await withRepo(setup, () =>
      runStatus({ runId: "01ARZ3NDEKTSV4RRFFQ69G5FA3", json: true }),
    );
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout);
    expect(obj.run.id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FA3");
    expect(obj.run.plan_slug).toBe("test-slug");
    expect(Array.isArray(obj.tasks)).toBe(true);
    expect(obj.tasks).toHaveLength(3);
    expect(obj.counts.succeeded).toBe(1);
    expect(obj.counts.failed).toBe(1);
  });
});

describe("runStatus — error paths", () => {
  test("exit 1 when no runs exist", async () => {
    const repo = path.join(tmp, "empty-repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    const r = await withRepo({ repo, pilotBase: path.join(tmp, "empty-base") }, () =>
      runStatus({}),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no runs found|no runs with a state\.db/);
  });

  test("exit 1 when explicit --run id has no state.db", async () => {
    const repo = path.join(tmp, "noid-repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    const r = await withRepo(
      { repo, pilotBase: path.join(tmp, "noid-base") },
      () => runStatus({ runId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ" }),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no state\.db/);
  });
});
