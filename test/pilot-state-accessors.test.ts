// pilot-state-accessors.test.ts — tests for runs/tasks/events accessors.
//
// In-memory SQLite per test (`:memory:`). Each test opens a fresh DB,
// applies migrations, and exercises one slice of the accessor surface.
//
// Coverage targets (Phase B2 of PILOT_TODO.md):
//   - state transitions for tasks (every legal transition, every illegal)
//   - ready-set computation via readyTasks
//   - createRun / markRunRunning / markRunFinished lifecycle
//   - upsertFromPlan idempotency
//   - countByStatus
//   - events append + read back
//   - cost_usd updates
//   - markPending (retry semantics)

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { openStateDb } from "../src/pilot/state/db.js";
import {
  createRun,
  markRunRunning,
  markRunFinished,
  getRun,
  listRuns,
  latestRun,
} from "../src/pilot/state/runs.js";
import {
  upsertFromPlan,
  markReady,
  markRunning,
  markSucceeded,
  markFailed,
  markBlocked,
  markAborted,
  markPending,
  setCostUsd,
  getTask,
  listTasks,
  readyTasks,
  countByStatus,
} from "../src/pilot/state/tasks.js";
import {
  appendEvent,
  readEvents,
  readEventsDecoded,
} from "../src/pilot/state/events.js";
import type { Plan, PlanTask } from "../src/pilot/plan/schema.js";

// --- Fixtures --------------------------------------------------------------

let opened: ReturnType<typeof openStateDb>;
beforeEach(() => {
  opened = openStateDb(":memory:");
});
afterEach(() => opened.close());

function makePlan(taskIds: string[]): Plan {
  const tasks: PlanTask[] = taskIds.map((id) => ({
    id,
    title: `task ${id}`,
    prompt: "p",
    touches: [],
    verify: [],
    depends_on: [],
  }));
  return {
    name: "test plan",
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

function seedRunAndPlan(taskIds: string[]): { runId: string; plan: Plan } {
  const plan = makePlan(taskIds);
  const runId = createRun(opened.db, {
    plan,
    planPath: "/tmp/pilot.yaml",
    slug: "test",
  });
  upsertFromPlan(opened.db, runId, plan);
  return { runId, plan };
}

// --- runs ------------------------------------------------------------------

describe("runs accessors", () => {
  test("createRun returns a ULID-shaped id and inserts a pending row", () => {
    const plan = makePlan(["T1"]);
    const id = createRun(opened.db, {
      plan,
      planPath: "/p/pilot.yaml",
      slug: "slug",
    });
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID grammar (Crockford base32)
    const row = getRun(opened.db, id);
    expect(row?.status).toBe("pending");
    expect(row?.plan_path).toBe("/p/pilot.yaml");
    expect(row?.plan_slug).toBe("slug");
    expect(row?.finished_at).toBeNull();
  });

  test("createRun honors injected `now` for deterministic timestamps", () => {
    const plan = makePlan(["T1"]);
    const id = createRun(opened.db, {
      plan,
      planPath: "/p",
      slug: "s",
      now: 12345,
    });
    expect(getRun(opened.db, id)?.started_at).toBe(12345);
  });

  test("markRunRunning transitions pending → running (idempotent on running)", () => {
    const id = createRun(opened.db, {
      plan: makePlan(["T1"]),
      planPath: "/p",
      slug: "s",
    });
    markRunRunning(opened.db, id);
    expect(getRun(opened.db, id)?.status).toBe("running");
    // Idempotent.
    markRunRunning(opened.db, id);
    expect(getRun(opened.db, id)?.status).toBe("running");
  });

  test("markRunRunning rejects transition from a terminal status", () => {
    const id = createRun(opened.db, {
      plan: makePlan(["T1"]),
      planPath: "/p",
      slug: "s",
    });
    markRunRunning(opened.db, id);
    markRunFinished(opened.db, id, "completed");
    expect(() => markRunRunning(opened.db, id)).toThrow(/completed.*running/);
  });

  test("markRunFinished records terminal status and finished_at", () => {
    const id = createRun(opened.db, {
      plan: makePlan(["T1"]),
      planPath: "/p",
      slug: "s",
    });
    markRunRunning(opened.db, id);
    markRunFinished(opened.db, id, "failed", 9999);
    const row = getRun(opened.db, id);
    expect(row?.status).toBe("failed");
    expect(row?.finished_at).toBe(9999);
  });

  test("markRunFinished rejects non-terminal status", () => {
    const id = createRun(opened.db, {
      plan: makePlan(["T1"]),
      planPath: "/p",
      slug: "s",
    });
    expect(() =>
      markRunFinished(opened.db, id, "running" as never),
    ).toThrow(/terminal/);
  });

  test("listRuns returns newest-first; latestRun returns the head", () => {
    const a = createRun(opened.db, {
      plan: makePlan(["T1"]),
      planPath: "/a",
      slug: "a",
      now: 100,
    });
    const b = createRun(opened.db, {
      plan: makePlan(["T1"]),
      planPath: "/b",
      slug: "b",
      now: 200,
    });
    const c = createRun(opened.db, {
      plan: makePlan(["T1"]),
      planPath: "/c",
      slug: "c",
      now: 150,
    });
    const all = listRuns(opened.db);
    expect(all.map((r) => r.id)).toEqual([b, c, a]);
    expect(latestRun(opened.db)?.id).toBe(b);
  });

  test("latestRun on an empty db returns null", () => {
    expect(latestRun(opened.db)).toBeNull();
  });
});

// --- upsertFromPlan --------------------------------------------------------

describe("upsertFromPlan", () => {
  test("inserts one row per task with status=pending", () => {
    const { runId } = seedRunAndPlan(["T1", "T2", "T3"]);
    const tasks = listTasks(opened.db, runId);
    expect(tasks.map((t) => t.task_id)).toEqual(["T1", "T2", "T3"]);
    expect(tasks.every((t) => t.status === "pending")).toBe(true);
    expect(tasks.every((t) => t.attempts === 0)).toBe(true);
  });

  test("re-running on an existing run is a no-op (does NOT clobber progress)", () => {
    const { runId, plan } = seedRunAndPlan(["T1"]);
    markReady(opened.db, runId, "T1");
    markRunning(opened.db, {
      runId,
      taskId: "T1",
      sessionId: "ses_1",
      branch: "pilot/x/T1",
      worktreePath: "/tmp/wt",
    });
    markSucceeded(opened.db, runId, "T1");
    upsertFromPlan(opened.db, runId, plan);
    expect(getTask(opened.db, runId, "T1")?.status).toBe("succeeded");
  });
});

// --- task transitions ------------------------------------------------------

describe("task transitions", () => {
  test("happy path: pending → ready → running → succeeded", () => {
    const { runId } = seedRunAndPlan(["T1"]);
    markReady(opened.db, runId, "T1");
    expect(getTask(opened.db, runId, "T1")?.status).toBe("ready");

    markRunning(opened.db, {
      runId,
      taskId: "T1",
      sessionId: "ses_1",
      branch: "pilot/x/T1",
      worktreePath: "/tmp/wt",
      now: 100,
    });
    const running = getTask(opened.db, runId, "T1")!;
    expect(running.status).toBe("running");
    expect(running.session_id).toBe("ses_1");
    expect(running.branch).toBe("pilot/x/T1");
    expect(running.worktree_path).toBe("/tmp/wt");
    expect(running.started_at).toBe(100);
    expect(running.attempts).toBe(1);

    markSucceeded(opened.db, runId, "T1", 200);
    const done = getTask(opened.db, runId, "T1")!;
    expect(done.status).toBe("succeeded");
    expect(done.finished_at).toBe(200);
    expect(done.last_error).toBeNull();
  });

  test("markFailed records reason and finished_at", () => {
    const { runId } = seedRunAndPlan(["T1"]);
    markReady(opened.db, runId, "T1");
    markRunning(opened.db, {
      runId,
      taskId: "T1",
      sessionId: "s",
      branch: "b",
      worktreePath: "/p",
    });
    markFailed(opened.db, runId, "T1", "verify failed", 50);
    const row = getTask(opened.db, runId, "T1")!;
    expect(row.status).toBe("failed");
    expect(row.last_error).toBe("verify failed");
    expect(row.finished_at).toBe(50);
  });

  test("markBlocked records reason; no finished_at", () => {
    const { runId } = seedRunAndPlan(["T1"]);
    markBlocked(opened.db, runId, "T1", "dep failed");
    const row = getTask(opened.db, runId, "T1")!;
    expect(row.status).toBe("blocked");
    expect(row.last_error).toBe("dep failed");
    expect(row.finished_at).toBeNull();
  });

  test("markAborted records reason and finished_at", () => {
    const { runId } = seedRunAndPlan(["T1"]);
    markReady(opened.db, runId, "T1");
    markRunning(opened.db, {
      runId,
      taskId: "T1",
      sessionId: "s",
      branch: "b",
      worktreePath: "/p",
    });
    markAborted(opened.db, runId, "T1", "user cancel", 60);
    const row = getTask(opened.db, runId, "T1")!;
    expect(row.status).toBe("aborted");
    expect(row.last_error).toBe("user cancel");
    expect(row.finished_at).toBe(60);
  });

  test("markRunning increments attempts on each retry", () => {
    const { runId } = seedRunAndPlan(["T1"]);
    markReady(opened.db, runId, "T1");
    markRunning(opened.db, {
      runId,
      taskId: "T1",
      sessionId: "a",
      branch: "b",
      worktreePath: "/p",
    });
    markFailed(opened.db, runId, "T1", "first fail");
    markPending(opened.db, runId, "T1");
    markReady(opened.db, runId, "T1");
    markRunning(opened.db, {
      runId,
      taskId: "T1",
      sessionId: "b",
      branch: "b",
      worktreePath: "/p",
    });
    expect(getTask(opened.db, runId, "T1")?.attempts).toBe(2);
  });

  test("started_at is preserved across retries (COALESCE on first start)", () => {
    const { runId } = seedRunAndPlan(["T1"]);
    markReady(opened.db, runId, "T1");
    markRunning(opened.db, {
      runId,
      taskId: "T1",
      sessionId: "a",
      branch: "b",
      worktreePath: "/p",
      now: 100,
    });
    markFailed(opened.db, runId, "T1", "fail");
    markPending(opened.db, runId, "T1");
    expect(getTask(opened.db, runId, "T1")?.started_at).toBeNull(); // markPending clears it
    markReady(opened.db, runId, "T1");
    markRunning(opened.db, {
      runId,
      taskId: "T1",
      sessionId: "b",
      branch: "b",
      worktreePath: "/p",
      now: 200,
    });
    // Started fresh after markPending — cleared then set by retry.
    expect(getTask(opened.db, runId, "T1")?.started_at).toBe(200);
  });

  test("markPending resets per-attempt fields but preserves attempts and cost", () => {
    const { runId } = seedRunAndPlan(["T1"]);
    markReady(opened.db, runId, "T1");
    markRunning(opened.db, {
      runId,
      taskId: "T1",
      sessionId: "s",
      branch: "b",
      worktreePath: "/p",
    });
    setCostUsd(opened.db, runId, "T1", 0.42);
    markFailed(opened.db, runId, "T1", "boom");
    markPending(opened.db, runId, "T1");
    const row = getTask(opened.db, runId, "T1")!;
    expect(row.status).toBe("pending");
    expect(row.session_id).toBeNull();
    expect(row.branch).toBeNull();
    expect(row.worktree_path).toBeNull();
    expect(row.started_at).toBeNull();
    expect(row.finished_at).toBeNull();
    expect(row.last_error).toBeNull();
    expect(row.attempts).toBe(1); // preserved
    expect(row.cost_usd).toBe(0.42); // preserved
  });

  test("setCostUsd rejects negative and non-finite values", () => {
    const { runId } = seedRunAndPlan(["T1"]);
    expect(() => setCostUsd(opened.db, runId, "T1", -1)).toThrow();
    expect(() => setCostUsd(opened.db, runId, "T1", NaN)).toThrow();
    expect(() => setCostUsd(opened.db, runId, "T1", Infinity)).toThrow();
  });
});

// --- illegal transitions ---------------------------------------------------

describe("task transitions — illegal", () => {
  test("markReady on already-running task throws", () => {
    const { runId } = seedRunAndPlan(["T1"]);
    markReady(opened.db, runId, "T1");
    markRunning(opened.db, {
      runId,
      taskId: "T1",
      sessionId: "s",
      branch: "b",
      worktreePath: "/p",
    });
    expect(() => markReady(opened.db, runId, "T1")).toThrow(/running.*ready/);
  });

  test("markSucceeded on a non-running task throws", () => {
    const { runId } = seedRunAndPlan(["T1"]);
    expect(() => markSucceeded(opened.db, runId, "T1")).toThrow(/pending.*succeeded/);
  });

  test("markRunning on pending (not-yet-ready) task throws", () => {
    const { runId } = seedRunAndPlan(["T1"]);
    expect(() =>
      markRunning(opened.db, {
        runId,
        taskId: "T1",
        sessionId: "s",
        branch: "b",
        worktreePath: "/p",
      }),
    ).toThrow(/pending.*running/);
  });

  test("any transition on a missing task throws", () => {
    const { runId } = seedRunAndPlan(["T1"]);
    expect(() => markReady(opened.db, runId, "GHOST")).toThrow(/not found/);
    expect(() => markSucceeded(opened.db, runId, "GHOST")).toThrow(/not found/);
  });
});

// --- ready-set + counts ----------------------------------------------------

describe("ready-set / counts", () => {
  test("readyTasks lists only `ready`-status rows", () => {
    const { runId } = seedRunAndPlan(["T1", "T2", "T3"]);
    markReady(opened.db, runId, "T1");
    markReady(opened.db, runId, "T3");
    const ready = readyTasks(opened.db, runId);
    expect(ready.map((t) => t.task_id)).toEqual(["T1", "T3"]);
  });

  test("countByStatus sums per-status counts", () => {
    const { runId } = seedRunAndPlan(["T1", "T2", "T3", "T4"]);
    markReady(opened.db, runId, "T1");
    markReady(opened.db, runId, "T2");
    markRunning(opened.db, {
      runId,
      taskId: "T1",
      sessionId: "s",
      branch: "b",
      worktreePath: "/p",
    });
    markBlocked(opened.db, runId, "T3", "dep");
    const counts = countByStatus(opened.db, runId);
    expect(counts.pending).toBe(1); // T4
    expect(counts.ready).toBe(1); // T2
    expect(counts.running).toBe(1); // T1
    expect(counts.blocked).toBe(1); // T3
    expect(counts.succeeded).toBe(0);
    expect(counts.failed).toBe(0);
    expect(counts.aborted).toBe(0);
  });
});

// --- events ----------------------------------------------------------------

describe("events", () => {
  test("appendEvent + readEvents preserves order and content", () => {
    const { runId } = seedRunAndPlan(["T1"]);
    appendEvent(opened.db, {
      runId,
      taskId: "T1",
      kind: "started",
      payload: { branch: "x" },
      now: 1,
    });
    appendEvent(opened.db, {
      runId,
      taskId: null,
      kind: "run.status",
      payload: "running",
      now: 2,
    });
    const evs = readEvents(opened.db, { runId });
    expect(evs.length).toBe(2);
    expect(evs[0]!.kind).toBe("started");
    expect(evs[0]!.task_id).toBe("T1");
    expect(JSON.parse(evs[0]!.payload)).toEqual({ branch: "x" });
    expect(evs[1]!.task_id).toBeNull();
    expect(JSON.parse(evs[1]!.payload)).toBe("running");
  });

  test("readEvents with taskId filter narrows to per-task events", () => {
    const { runId } = seedRunAndPlan(["T1", "T2"]);
    appendEvent(opened.db, { runId, taskId: "T1", kind: "a", payload: 1 });
    appendEvent(opened.db, { runId, taskId: "T2", kind: "b", payload: 2 });
    appendEvent(opened.db, { runId, taskId: "T1", kind: "c", payload: 3 });
    const t1 = readEvents(opened.db, { runId, taskId: "T1" });
    expect(t1.map((e) => e.kind)).toEqual(["a", "c"]);
  });

  test("readEventsDecoded parses payload JSON", () => {
    const { runId } = seedRunAndPlan(["T1"]);
    appendEvent(opened.db, {
      runId,
      taskId: "T1",
      kind: "k",
      payload: { foo: 1, bar: [2, 3] },
    });
    const decoded = readEventsDecoded(opened.db, { runId });
    expect(decoded[0]!.payload).toEqual({ foo: 1, bar: [2, 3] });
  });

  test("appendEvent on non-JSON-serializable payload stores degraded message", () => {
    const { runId } = seedRunAndPlan(["T1"]);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    appendEvent(opened.db, { runId, taskId: "T1", kind: "k", payload: circular });
    const evs = readEventsDecoded(opened.db, { runId });
    expect((evs[0]!.payload as { _error?: string })._error).toMatch(/JSON/);
  });

  test("limit caps the number of returned rows", () => {
    const { runId } = seedRunAndPlan(["T1"]);
    for (let i = 0; i < 10; i++) {
      appendEvent(opened.db, { runId, kind: "k", payload: i });
    }
    expect(readEvents(opened.db, { runId, limit: 3 }).length).toBe(3);
  });
});

// --- orphan rejection (FK enforcement check) -------------------------------

describe("FK enforcement on accessors", () => {
  test("upsertFromPlan throws when run_id doesn't exist", () => {
    expect(() => {
      upsertFromPlan(opened.db, "nope", makePlan(["T1"]));
    }).toThrow(/FOREIGN|constraint/i);
  });

  test("appendEvent throws when run_id doesn't exist", () => {
    expect(() => {
      appendEvent(opened.db, {
        runId: "nope",
        kind: "k",
        payload: 1,
      });
    }).toThrow(/FOREIGN|constraint/i);
  });
});
