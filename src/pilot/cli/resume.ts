/**
 * `pilot resume [--run <id>]` — continue a partially-completed run.
 *
 * Discovers the latest run with a state.db (or the explicit `--run`),
 * re-loads the plan from `runs.plan_path`, and re-enters the worker
 * lifecycle via `executeRun`. The scheduler naturally skips already-
 * succeeded tasks (`pending → ready → running → succeeded`), so the
 * worker just picks up where it left off.
 *
 * What we DO touch on resume:
 *   - Re-mark the run as `running` (it may have been left as `failed` /
 *     `aborted` from the prior session).
 *   - Re-emit a `run.resumed` event for audit.
 *
 * What we do NOT touch:
 *   - Already-succeeded task rows (their attempts/cost/branch are
 *     preserved).
 *   - Already-failed task rows (resume is NOT a retry; use
 *     `pilot retry <task>` to reset a specific failure).
 *
 * If you want to run failed tasks: `pilot retry <id>` first, then
 * `pilot resume`.
 */

import { command, option, optional, string } from "cmd-ts";
import { discoverRun } from "./discover.js";
import { openStateDb } from "../state/db.js";
import { getRun, markRunRunning } from "../state/runs.js";
import { appendEvent } from "../state/events.js";
import { loadPlan } from "../plan/load.js";
import { executeRun } from "./build.js";
import { getRunDir } from "../paths.js";

export const resumeCmd = command({
  name: "resume",
  description: "Continue a partially-completed pilot run.",
  args: {
    run: option({
      long: "run",
      type: optional(string),
      description: "Run ID. Defaults to the newest run.",
    }),
  },
  handler: async ({ run }) => {
    const code = await runResume({ runId: run });
    process.exit(code);
  },
});

export async function runResume(opts: {
  runId?: string | undefined;
}): Promise<number> {
  let discovered;
  try {
    discovered = await discoverRun({
      cwd: process.cwd(),
      runId: opts.runId,
    });
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  const opened = openStateDb(discovered.dbPath);
  const cleanup: Array<() => Promise<void> | void> = [
    () => opened.close(),
  ];

  const run = getRun(opened.db, discovered.runId);
  if (run === null) {
    process.stderr.write(
      `pilot resume: run ${discovered.runId} missing from DB\n`,
    );
    await runCleanup(cleanup);
    return 1;
  }

  // Reload the plan.
  const loaded = await loadPlan(run.plan_path);
  if (!loaded.ok) {
    process.stderr.write(
      `pilot resume: cannot reload plan at ${run.plan_path} (${loaded.kind})\n`,
    );
    for (const e of loaded.errors) {
      process.stderr.write(`  ${e.path}: ${e.message}\n`);
    }
    await runCleanup(cleanup);
    return 1;
  }

  // Re-mark running. Allowed transitions:
  //   pending → running (the normal case)
  //   running → running (idempotent, e.g. previous build was killed
  //                       before markRunFinished landed)
  //   completed/failed/aborted → running (re-marking is needed; we
  //                       use a direct UPDATE to skip the state-machine
  //                       guard that markRunRunning enforces).
  if (run.status === "pending") {
    markRunRunning(opened.db, discovered.runId);
  } else if (run.status === "running") {
    // already running; no-op
  } else {
    // completed/failed/aborted: reopen via direct update + clear finished_at.
    opened.db.run(
      `UPDATE runs SET status='running', finished_at=NULL WHERE id=?`,
      [discovered.runId],
    );
  }

  appendEvent(opened.db, {
    runId: discovered.runId,
    kind: "run.resumed",
    payload: { previousStatus: run.status },
  });

  // Hand off to executeRun.
  const runDir = await getRunDir(process.cwd(), discovered.runId);
  return executeRun({
    db: opened,
    runId: discovered.runId,
    plan: loaded.plan,
    planPath: run.plan_path,
    runDir,
    branchPrefix: loaded.plan.branch_prefix ?? `pilot/${run.plan_slug}`,
    cleanup,
  });
}

async function runCleanup(
  cleanup: Array<() => Promise<void> | void>,
): Promise<void> {
  while (cleanup.length > 0) {
    const fn = cleanup.pop()!;
    try {
      await fn();
    } catch {
      // ignore
    }
  }
}
