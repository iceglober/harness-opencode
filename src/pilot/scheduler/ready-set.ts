/**
 * Pilot DAG scheduler.
 *
 * Drives the worker's task selection. The scheduler is stateless
 * itself — it queries the SQLite state DB on every call. This means:
 *
 *   - Multiple workers (v0.3) can hit the same scheduler concurrently
 *     without coordinating; the DB is the source of truth.
 *   - `pilot resume` (Phase G6) loads the scheduler against an existing
 *     run and the right tasks pop out automatically.
 *
 * Two responsibilities:
 *
 *   1. **Pick the next ready task.** A task is "ready" when its DB
 *      status is `pending` AND every task it depends_on has DB status
 *      `succeeded`. The scheduler also marks newly-ready tasks as
 *      `ready` in the DB so `pilot status` reflects them between
 *      worker iterations.
 *
 *   2. **Cascade-fail downstream tasks.** When a task fails, every
 *      task that transitively depends on it is marked `blocked` with
 *      a reason pointing back at the originating failure. The worker
 *      calls `cascadeFail(failedTaskId)` after `markFailed`.
 *
 * Tiebreaks: among multiple ready tasks, pick the one declared
 * earliest in the plan (matches the topo sort from `dag.ts`). v0.1
 * runs them serially; v0.3 will pick a batch up to `workerCount`.
 *
 * Ship-checklist alignment: Phase E2 of `PILOT_TODO.md`.
 */

import type { Database } from "bun:sqlite";
import type { Plan, PlanTask } from "../plan/schema.js";
import type { TaskRow } from "../state/types.js";
import {
  markBlocked,
  markReady,
  getTask,
  countByStatus,
} from "../state/tasks.js";

// --- Public types ----------------------------------------------------------

export type Scheduler = {
  /**
   * Pick the next task to run. Returns the matching `PlanTask` plus the
   * current row (post-mark-ready), or null if no task is ready right
   * now (either everything is in progress, or the run is done).
   *
   * Side effect: marks the picked task as `ready` in the DB.
   *
   * Calling this DOES NOT mark the task as `running` — the worker is
   * responsible for that after acquiring a worktree slot, because the
   * worker also needs to record session_id / branch / worktree_path in
   * the same `markRunning` call.
   */
  next(): { task: PlanTask; row: TaskRow } | null;

  /**
   * Mark every transitive dependent of `failedTaskId` as `blocked`.
   * Idempotent: tasks already in `blocked` / `failed` / `aborted` /
   * `succeeded` are left alone.
   *
   * Returns the list of task IDs newly transitioned to blocked (for
   * the worker's event log).
   */
  cascadeFail(failedTaskId: string, reason?: string): string[];

  /**
   * `true` when no tasks are runnable any longer (either every task
   * has reached a terminal state, OR the only non-terminal tasks are
   * blocked on failed deps).
   */
  isComplete(): boolean;

  /**
   * Lookup helper used by tests and the worker's status logging.
   * Returns the static plan task (not the DB row) — combines
   * with `getTask(db, runId, id)` when the row's needed too.
   */
  planTask(taskId: string): PlanTask | null;
};

// --- Constructor -----------------------------------------------------------

/**
 * Build a scheduler over a (db, runId, plan) triple. The plan is
 * passed in (rather than re-derived from the DB) because pilot's
 * canonical source of truth for plan content is the YAML file —
 * the DB only stores task IDs and runtime state.
 */
export function makeScheduler(args: {
  db: Database;
  runId: string;
  plan: Plan;
}): Scheduler {
  const { db, runId, plan } = args;

  // Index plan tasks by id for O(1) lookups during dep traversal.
  const planById = new Map<string, PlanTask>();
  for (const t of plan.tasks) planById.set(t.id, t);

  // Build a reverse adjacency: dep → array of dependents. Used by
  // cascadeFail to walk forward from a failed task.
  const dependentsOf = new Map<string, string[]>();
  for (const t of plan.tasks) {
    for (const dep of t.depends_on) {
      const list = dependentsOf.get(dep);
      if (list) list.push(t.id);
      else dependentsOf.set(dep, [t.id]);
    }
  }

  return {
    next(): { task: PlanTask; row: TaskRow } | null {
      // Walk plan tasks in declaration order; the first one that is
      // pending + all-deps-succeeded wins.
      for (const task of plan.tasks) {
        const row = getTask(db, runId, task.id);
        if (!row) continue; // shouldn't happen if upsertFromPlan ran
        if (row.status !== "pending") continue;
        if (!depsSatisfied(db, runId, task)) continue;

        // Mark ready (the first time we observe it as runnable). The
        // call is a no-op if it's somehow already ready.
        try {
          markReady(db, runId, task.id);
        } catch {
          // ready or running already — fetch latest and return.
        }
        const finalRow = getTask(db, runId, task.id) ?? row;
        return { task, row: finalRow };
      }
      return null;
    },

    cascadeFail(failedTaskId: string, reason?: string): string[] {
      const newlyBlocked: string[] = [];
      const stack = [...(dependentsOf.get(failedTaskId) ?? [])];
      const seen = new Set<string>();
      const reasonText =
        reason ??
        `dependency ${JSON.stringify(failedTaskId)} failed`;

      while (stack.length > 0) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);

        const row = getTask(db, runId, id);
        if (!row) continue;
        if (
          row.status === "succeeded" ||
          row.status === "failed" ||
          row.status === "aborted" ||
          row.status === "blocked"
        ) {
          // Don't transition out of a terminal status.
          continue;
        }
        try {
          markBlocked(db, runId, id, reasonText);
          newlyBlocked.push(id);
        } catch {
          // Tasks in `running` can't be markBlocked'd — that's the
          // worker's racy edge. Skip and let the worker handle it on
          // its own task-completion path.
          continue;
        }
        for (const dep of dependentsOf.get(id) ?? []) {
          if (!seen.has(dep)) stack.push(dep);
        }
      }

      return newlyBlocked;
    },

    isComplete(): boolean {
      // Complete when no task is in pending/ready/running.
      const counts = countByStatus(db, runId);
      const inFlight =
        counts.pending + counts.ready + counts.running;
      return inFlight === 0;
    },

    planTask(taskId: string): PlanTask | null {
      return planById.get(taskId) ?? null;
    },
  };
}

// --- Internals -------------------------------------------------------------

/**
 * True iff every dep in `task.depends_on` has DB status `succeeded`.
 * Empty depends_on → trivially true.
 *
 * Implementation note: we issue one query per dep. For tiny plans
 * (the pilot v0.1 expectation) this is ~5 queries per `next()` call;
 * acceptable. If plans grow large, switch to a single `SELECT
 * task_id, status FROM tasks WHERE run_id=? AND task_id IN (...)`.
 */
function depsSatisfied(
  db: Database,
  runId: string,
  task: PlanTask,
): boolean {
  for (const dep of task.depends_on) {
    const r = getTask(db, runId, dep);
    if (!r) return false;
    if (r.status !== "succeeded") return false;
  }
  return true;
}
