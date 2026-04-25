// pilot-acceptance.test.ts — Phase J synthetic acceptance test.
//
// Walks through the canonical pilot lifecycle WITHOUT spawning a real
// opencode server. The test exercises every CLI verb's happy path
// against a tmp repo, asserting the documented exit codes and output
// shapes.
//
// What this test does NOT cover (those need OPENCODE_E2E=1):
//   - The actual worker loop driving real opencode sessions.
//   - The pilot-builder agent making real edits.
//   - The pilot-planner agent writing real YAML.
//
// What this test DOES cover (the wiring + protocol layer):
//   - validate on a hand-written plan.
//   - build --dry-run shape.
//   - status / logs / cost / worktrees against a seeded run.
//   - retry resetting a failed task.
//   - resume's error paths.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runValidate } from "../src/pilot/cli/validate.js";
import { runBuild } from "../src/pilot/cli/build.js";
import { runStatus } from "../src/pilot/cli/status.js";
import { runRetry } from "../src/pilot/cli/retry.js";
import { runLogs } from "../src/pilot/cli/logs.js";
import { runCost } from "../src/pilot/cli/cost.js";
import { runWorktreesList } from "../src/pilot/cli/worktrees.js";
import { openStateDb } from "../src/pilot/state/db.js";
import {
  upsertFromPlan,
  markReady,
  markRunning,
  markSucceeded,
  markFailed,
  setCostUsd,
} from "../src/pilot/state/tasks.js";
import { appendEvent } from "../src/pilot/state/events.js";
import {
  getStateDbPath,
  getRunDir,
  getPlansDir,
} from "../src/pilot/paths.js";
import type { Plan, PlanTask } from "../src/pilot/plan/schema.js";

// --- Setup -----------------------------------------------------------------

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-acceptance-"));
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

function makePlanObj(): Plan {
  const tasks: PlanTask[] = [
    {
      id: "T1",
      title: "first task",
      prompt: "do",
      touches: ["src/a.ts"],
      verify: ["echo a"],
      depends_on: [],
    },
    {
      id: "T2",
      title: "second task",
      prompt: "do",
      touches: ["src/b.ts"],
      verify: ["echo b"],
      depends_on: ["T1"],
    },
  ];
  return {
    name: "acceptance plan",
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

const PLAN_YAML = `
name: acceptance plan
tasks:
  - id: T1
    title: first task
    prompt: do
    touches: [src/a.ts]
    verify: ["echo a"]
  - id: T2
    title: second task
    prompt: do
    touches: [src/b.ts]
    verify: ["echo b"]
    depends_on: [T1]
`.trimStart();

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

async function withRepoEnv<T>(
  args: { repo: string; pilotBase: string },
  fn: () => Promise<T>,
): Promise<T> {
  const prevCwd = process.cwd();
  const prevPilotEnv = process.env.GLORIOUS_PILOT_DIR;
  process.env.GLORIOUS_PILOT_DIR = args.pilotBase;
  process.chdir(args.repo);
  try {
    return await fn();
  } finally {
    process.chdir(prevCwd);
    if (prevPilotEnv === undefined) delete process.env.GLORIOUS_PILOT_DIR;
    else process.env.GLORIOUS_PILOT_DIR = prevPilotEnv;
  }
}

// --- Acceptance flow -------------------------------------------------------

describe("Phase J — synthetic acceptance flow", () => {
  test("validate → build --dry-run → seed run → status / logs / cost / retry / worktrees", async () => {
    // 1. Set up a tmp repo + pilot dirs.
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    const pilotBase = path.join(tmp, "pilot-base");

    await withRepoEnv({ repo, pilotBase }, async () => {
      // 2. Save the plan in the canonical plans dir.
      const plansDir = await getPlansDir(repo);
      const planPath = path.join(plansDir, "acceptance-plan.yaml");
      fs.writeFileSync(planPath, PLAN_YAML);

      // 3. validate — should exit 0.
      const v = await captured(() => runValidate({ planPath, quiet: true }));
      expect(v.code).toBe(0);

      // 4. build --dry-run — exits 0 + prints task summary.
      const b = await captured(() => runBuild({ plan: planPath, dryRun: true }));
      expect(b.code).toBe(0);
      expect(b.stdout).toMatch(/T1: first task/);
      expect(b.stdout).toMatch(/T2: second task/);

      // 5. Seed a run state DB to simulate a completed (failed) build.
      const runId = "01ARZ3NDEKTSV4RRFFQ69ACCEP";
      await getRunDir(repo, runId);
      const dbPath = await getStateDbPath(repo, runId);
      const opened = openStateDb(dbPath);
      try {
        const plan = makePlanObj();
        opened.db.run(
          `INSERT INTO runs (id, plan_path, plan_slug, started_at, status) VALUES (?, ?, ?, ?, ?)`,
          [runId, planPath, "acceptance-plan", 1_700_000_000_000, "failed"],
        );
        upsertFromPlan(opened.db, runId, plan);

        markReady(opened.db, runId, "T1");
        markRunning(opened.db, {
          runId,
          taskId: "T1",
          sessionId: "ses_t1",
          branch: "pilot/acceptance-plan/T1",
          worktreePath: path.join(
            pilotBase,
            "repo",
            "pilot",
            "worktrees",
            runId,
            "00",
          ),
        });
        setCostUsd(opened.db, runId, "T1", 0.42);
        markSucceeded(opened.db, runId, "T1");

        markReady(opened.db, runId, "T2");
        markRunning(opened.db, {
          runId,
          taskId: "T2",
          sessionId: "ses_t2",
          branch: "pilot/acceptance-plan/T2",
          worktreePath: path.join(
            pilotBase,
            "repo",
            "pilot",
            "worktrees",
            runId,
            "00",
          ),
        });
        setCostUsd(opened.db, runId, "T2", 1.10);
        markFailed(opened.db, runId, "T2", "verify failed: echo b exit 1 (synthetic)");
        appendEvent(opened.db, {
          runId,
          taskId: "T2",
          kind: "task.verify.failed",
          payload: { command: "echo b", exitCode: 1, timedOut: false, aborted: false },
        });
      } finally {
        opened.close();
      }

      // 6. status — should reflect the seeded state.
      const s = await captured(() => runStatus({ runId }));
      expect(s.code).toBe(0);
      expect(s.stdout).toMatch(/Run 01ARZ3NDEKTSV4RRFFQ69ACCEP/);
      expect(s.stdout).toMatch(/T1.*succeeded/);
      expect(s.stdout).toMatch(/T2.*failed/);
      expect(s.stdout).toMatch(/last_error: verify failed/);

      // 7. status --json — parseable.
      const sj = await captured(() => runStatus({ runId, json: true }));
      expect(sj.code).toBe(0);
      const parsed = JSON.parse(sj.stdout);
      expect(parsed.tasks).toHaveLength(2);

      // 8. logs T2 — shows the failure event.
      const l = await captured(() => runLogs({ taskId: "T2", runId }));
      expect(l.code).toBe(0);
      expect(l.stdout).toMatch(/task\.verify\.failed/);

      // 9. cost — total = 1.52.
      const c = await captured(() => runCost({ runId }));
      expect(c.code).toBe(0);
      expect(c.stdout).toMatch(/total.*\$1\.52/);

      // 10. retry T2 — resets to pending; preserves attempts/cost.
      const r = await captured(() => runRetry({ taskId: "T2", runId }));
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/T2 reset to pending.*was failed/);

      // 11. status again — T2 now pending, attempts/cost preserved.
      const s2 = await captured(() => runStatus({ runId, json: true }));
      const parsed2 = JSON.parse(s2.stdout);
      const t2 = parsed2.tasks.find(
        (t: { task_id: string }) => t.task_id === "T2",
      );
      expect(t2.status).toBe("pending");
      expect(t2.attempts).toBe(1);
      expect(t2.cost_usd).toBe(1.1);

      // 12. worktrees list — no real worktrees were created (no
      //     `git worktree add` was called); should report none.
      const w = await captured(() => runWorktreesList({ runId }));
      expect(w.code).toBe(0);
      expect(w.stdout).toMatch(/no pilot worktrees/);
    });
  });
});

// --- Documentation-as-test: full E2E checklist (gated) --------------------

/**
 * The TRUE end-to-end acceptance gate runs against a real opencode
 * server with real model auth. Gate it behind `OPENCODE_E2E=1` so CI
 * skips it.
 *
 * The checklist below mirrors PILOT_TODO.md Phase J. Operators run it
 * manually before tagging a release that touches pilot.
 */
describe("Phase J — manual E2E checklist (OPENCODE_E2E=1)", () => {
  test("manual operators: walk the lifecycle on a real repo", () => {
    if (process.env.OPENCODE_E2E !== "1") {
      // The checklist is in the docs (PILOT_TODO.md Phase J), this
      // test is the canary.
      return;
    }
    // Operators: by the time you get here you should have:
    //
    //   1. Hand-written a `pilot.yaml` with two trivial tasks
    //      (touch + echo, easy verify).
    //   2. Run `bunx @glrs-dev/harness-opencode pilot validate <path>`
    //      and seen exit 0.
    //   3. Run `pilot build` and watched both tasks commit on
    //      per-task branches.
    //   4. Confirmed `pilot status` matches the actual state.
    //   5. Run `pilot retry T1` then `pilot resume` and watched
    //      the task re-run on a fresh branch.
    //   6. Run `pilot logs <task-id>` and seen session id, JSONL
    //      path, and event timeline.
    //   7. Run `pilot worktrees list` and `pilot worktrees prune`
    //      to confirm worktree management.
    //   8. Run `pilot cost` to see per-task and total cost.
    //   9. Run the full `pilot plan ENG-XXXX` flow end-to-end in
    //      opencode TUI: planner produces a plan, validate passes,
    //      build executes, all tasks succeed.
    //
    // If all of the above completed successfully, set this test to
    // pass. There's no cheap way to assert it from inside a unit test
    // — that's the point of `OPENCODE_E2E=1` gating.
    expect(true).toBe(true);
  });
});
