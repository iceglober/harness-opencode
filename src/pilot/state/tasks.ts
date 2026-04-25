/**
 * Task-level state accessors.
 *
 * Drives the worker's state machine. The accessors here are NOT pure —
 * each mutates the DB and any caller invariants live alongside the
 * mutation (e.g. `markRunning` requires the task be `ready`).
 *
 * Ship-checklist alignment: Phase B2 of `PILOT_TODO.md`.
 */

import type { Database } from "bun:sqlite";
import type { Plan } from "../plan/schema.js";
import type { TaskRow, TaskStatus } from "./types.js";

// --- Initial population ----------------------------------------------------

/**
 * Insert one row per task in the plan, all in `pending` status, attempts=0.
 * Idempotent within a run: existing rows for the same `(run_id, task_id)`
 * are left untouched (use `markPending` to reset for retry).
 *
 * `INSERT OR IGNORE` is the lever — first call inserts; subsequent calls
 * are no-ops. The intentional asymmetry is: we never want re-running
 * `Tasks.upsertFromPlan` to clobber a task's progress (e.g. if a worker
 * died after partial state was persisted, then `pilot resume` re-loaded
 * the plan).
 */
export function upsertFromPlan(
  db: Database,
  runId: string,
  plan: Plan,
): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO tasks (run_id, task_id, status) VALUES (?, ?, 'pending')`,
  );
  const tx = db.transaction(() => {
    for (const t of plan.tasks) {
      stmt.run(runId, t.id);
    }
  });
  tx();
}

// --- Status transitions ----------------------------------------------------

/**
 * Move a task from `pending` to `ready`. Called by the scheduler when
 * all of a task's dependencies have reached `succeeded`.
 *
 * Throws if the task isn't found or isn't currently `pending`. The
 * scheduler should compute "newly ready" tasks before calling this; we
 * don't silently coerce other statuses (a `ready` task being re-marked
 * ready is suspicious and worth surfacing).
 */
export function markReady(db: Database, runId: string, taskId: string): void {
  requireStatus(db, runId, taskId, ["pending"], "ready");
  db.run(
    "UPDATE tasks SET status='ready' WHERE run_id=? AND task_id=?",
    [runId, taskId],
  );
}

/**
 * Move a task from `ready` to `running`. Records the worker context:
 * branch name, worktree path, session id, attempt number.
 *
 * `attempts` is INCREMENTED here (not just set), so retries naturally
 * accumulate the count without the caller having to read-modify-write.
 *
 * `session_id` is nullable in the schema but the worker passes a real
 * value when calling this — null is reserved for the schema-default
 * "before any session was created" case.
 */
export function markRunning(
  db: Database,
  args: {
    runId: string;
    taskId: string;
    sessionId: string;
    branch: string;
    worktreePath: string;
    now?: number;
  },
): void {
  requireStatus(db, args.runId, args.taskId, ["ready"], "running");
  const now = args.now ?? Date.now();
  db.run(
    `UPDATE tasks
     SET status='running',
         attempts = attempts + 1,
         session_id = ?,
         branch = ?,
         worktree_path = ?,
         started_at = COALESCE(started_at, ?)
     WHERE run_id=? AND task_id=?`,
    [args.sessionId, args.branch, args.worktreePath, now, args.runId, args.taskId],
  );
}

/**
 * Mark a task `succeeded`. Stamps `finished_at`. Clears `last_error`.
 */
export function markSucceeded(
  db: Database,
  runId: string,
  taskId: string,
  now: number = Date.now(),
): void {
  requireStatus(db, runId, taskId, ["running"], "succeeded");
  db.run(
    `UPDATE tasks
     SET status='succeeded', finished_at=?, last_error=NULL
     WHERE run_id=? AND task_id=?`,
    [now, runId, taskId],
  );
}

/**
 * Mark a task `failed`. Stamps `finished_at` and stores the last
 * failure reason for `pilot status` / `pilot logs` rendering.
 */
export function markFailed(
  db: Database,
  runId: string,
  taskId: string,
  reason: string,
  now: number = Date.now(),
): void {
  requireStatus(db, runId, taskId, ["running", "ready"], "failed");
  db.run(
    `UPDATE tasks
     SET status='failed', finished_at=?, last_error=?
     WHERE run_id=? AND task_id=?`,
    [now, reason, runId, taskId],
  );
}

/**
 * Mark a task `blocked` — a transitive dependency failed; this task
 * will not run. No `finished_at` stamp because the task never started.
 */
export function markBlocked(
  db: Database,
  runId: string,
  taskId: string,
  reason: string,
): void {
  requireStatus(db, runId, taskId, ["pending", "ready"], "blocked");
  db.run(
    `UPDATE tasks
     SET status='blocked', last_error=?
     WHERE run_id=? AND task_id=?`,
    [reason, runId, taskId],
  );
}

/**
 * Mark a task `aborted` — explicit cancellation while running.
 */
export function markAborted(
  db: Database,
  runId: string,
  taskId: string,
  reason: string,
  now: number = Date.now(),
): void {
  requireStatus(db, runId, taskId, ["running", "ready"], "aborted");
  db.run(
    `UPDATE tasks
     SET status='aborted', finished_at=?, last_error=?
     WHERE run_id=? AND task_id=?`,
    [now, reason, runId, taskId],
  );
}

/**
 * Reset a task back to `pending` for `pilot retry`. Clears branch,
 * worktree_path, session_id, error, and finished_at; preserves
 * `attempts` (cumulative across retries) and `cost_usd`.
 */
export function markPending(
  db: Database,
  runId: string,
  taskId: string,
): void {
  // Allow retry from any status — `pilot retry T1` should work whether
  // T1 was failed, blocked, or even succeeded (re-run happy task).
  const cur = getTask(db, runId, taskId);
  if (!cur) {
    throw new Error(
      `markPending: task ${JSON.stringify(taskId)} not found in run ${JSON.stringify(runId)}`,
    );
  }
  db.run(
    `UPDATE tasks
     SET status='pending',
         session_id=NULL,
         branch=NULL,
         worktree_path=NULL,
         started_at=NULL,
         finished_at=NULL,
         last_error=NULL
     WHERE run_id=? AND task_id=?`,
    [runId, taskId],
  );
}

/**
 * Update cost_usd for a task. The worker calls this periodically as
 * sessions report their running cost. Replaces (not adds) — the
 * value is the absolute current cost of the session.
 */
export function setCostUsd(
  db: Database,
  runId: string,
  taskId: string,
  costUsd: number,
): void {
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new RangeError(`setCostUsd: invalid cost ${costUsd}`);
  }
  db.run(
    "UPDATE tasks SET cost_usd=? WHERE run_id=? AND task_id=?",
    [costUsd, runId, taskId],
  );
}

// --- Reads -----------------------------------------------------------------

/** Read one task row. Returns null if not found. */
export function getTask(
  db: Database,
  runId: string,
  taskId: string,
): TaskRow | null {
  return db
    .query("SELECT * FROM tasks WHERE run_id=? AND task_id=?")
    .get(runId, taskId) as TaskRow | null;
}

/** All tasks for a run, ordered by task_id (deterministic for tests). */
export function listTasks(db: Database, runId: string): TaskRow[] {
  return db
    .query("SELECT * FROM tasks WHERE run_id=? ORDER BY task_id")
    .all(runId) as TaskRow[];
}

/** Tasks currently in `ready` status, ordered by task_id. */
export function readyTasks(db: Database, runId: string): TaskRow[] {
  return db
    .query("SELECT * FROM tasks WHERE run_id=? AND status='ready' ORDER BY task_id")
    .all(runId) as TaskRow[];
}

/** Counts by status — for `pilot status` summary tile. */
export function countByStatus(
  db: Database,
  runId: string,
): Record<TaskStatus, number> {
  const rows = db
    .query("SELECT status, COUNT(*) as n FROM tasks WHERE run_id=? GROUP BY status")
    .all(runId) as Array<{ status: TaskStatus; n: number }>;
  const out: Record<TaskStatus, number> = {
    pending: 0,
    ready: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    blocked: 0,
    aborted: 0,
  };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

// --- Internals -------------------------------------------------------------

/**
 * Throw if the current task status is NOT one of `expected`. Used by
 * the transition functions to enforce state-machine invariants.
 *
 * `intended` is the destination status, included only for the error
 * message ("cannot move T1 from succeeded to ready").
 */
function requireStatus(
  db: Database,
  runId: string,
  taskId: string,
  expected: ReadonlyArray<TaskStatus>,
  intended: TaskStatus,
): void {
  const row = getTask(db, runId, taskId);
  if (!row) {
    throw new Error(
      `task ${JSON.stringify(taskId)} not found in run ${JSON.stringify(runId)}`,
    );
  }
  if (!expected.includes(row.status)) {
    throw new Error(
      `cannot move task ${JSON.stringify(taskId)} from ${row.status} to ${intended} ` +
        `(expected one of: ${expected.join(", ")})`,
    );
  }
}
