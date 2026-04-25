/**
 * `pilot retry <task-id> [--run <id>]` — reset one task and re-run it.
 *
 * Marks the named task `pending`, clears its session/branch/worktree
 * fields and `last_error`. Preserves `attempts` (cumulative) and
 * `cost_usd`. The next `pilot resume` (or this command's optional
 * `--run-now` flag) re-runs the task on a fresh branch.
 *
 * Doesn't touch dependent tasks. If the retried task was the cause of
 * cascade-fails downstream, the operator can also retry those, OR run
 * `pilot resume` after retry — the worker re-evaluates dep status when
 * picking the next ready task.
 *
 * v0.1: the existing branch + worktree directory for the task are
 * preserved (the `markPending` helper just clears the DB pointers; it
 * doesn't delete files). The next `prepare()` will reset the worktree
 * cleanly. The branch stays — git worktree handles -B reset.
 */

import { command, option, optional, positional, string, flag } from "cmd-ts";
import { discoverRun } from "./discover.js";
import { openStateDb } from "../state/db.js";
import { markPending, getTask } from "../state/tasks.js";
import { appendEvent } from "../state/events.js";
import { runResume } from "./resume.js";

export const retryCmd = command({
  name: "retry",
  description: "Reset a single task to pending. Optionally also re-run it.",
  args: {
    taskId: positional({
      type: string,
      displayName: "task-id",
      description: "Task id to reset (e.g. T1).",
    }),
    run: option({
      long: "run",
      type: optional(string),
      description: "Run ID. Defaults to the newest run.",
    }),
    runNow: flag({
      long: "run-now",
      description:
        "After resetting, immediately run `pilot resume` on the same DB.",
    }),
  },
  handler: async ({ taskId, run, runNow }) => {
    const code = await runRetry({ taskId, runId: run, runNow });
    process.exit(code);
  },
});

export async function runRetry(opts: {
  taskId: string;
  runId?: string | undefined;
  runNow?: boolean;
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
  try {
    const task = getTask(opened.db, discovered.runId, opts.taskId);
    if (task === null) {
      process.stderr.write(
        `pilot retry: task ${JSON.stringify(opts.taskId)} not found in run ${discovered.runId}\n`,
      );
      return 1;
    }
    const previousStatus = task.status;
    try {
      markPending(opened.db, discovered.runId, opts.taskId);
    } catch (err) {
      process.stderr.write(
        `pilot retry: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
    appendEvent(opened.db, {
      runId: discovered.runId,
      taskId: opts.taskId,
      kind: "task.retry",
      payload: { previousStatus },
    });
    process.stdout.write(
      `pilot retry: ${opts.taskId} reset to pending (was ${previousStatus})\n`,
    );
  } finally {
    opened.close();
  }

  if (opts.runNow) {
    return runResume({ runId: discovered.runId });
  }
  return 0;
}
