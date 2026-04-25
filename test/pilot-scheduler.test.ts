// pilot-scheduler.test.ts — coverage for src/pilot/scheduler/ready-set.ts.
//
// In-memory SQLite per test. Build small plans, exercise next() /
// cascadeFail() / isComplete(), and verify the DB state reflects
// what the scheduler claims.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { openStateDb } from "../src/pilot/state/db.js";
import { createRun } from "../src/pilot/state/runs.js";
import {
  upsertFromPlan,
  markReady,
  markRunning,
  markSucceeded,
  markFailed,
  getTask,
} from "../src/pilot/state/tasks.js";
import { makeScheduler } from "../src/pilot/scheduler/ready-set.js";
import type { Plan, PlanTask } from "../src/pilot/plan/schema.js";

// --- Fixtures --------------------------------------------------------------

let opened: ReturnType<typeof openStateDb>;
beforeEach(() => {
  opened = openStateDb(":memory:");
});
afterEach(() => opened.close());

function makePlan(
  specs: Array<{ id: string; depends_on?: string[] }>,
): Plan {
  const tasks: PlanTask[] = specs.map((s) => ({
    id: s.id,
    title: `task ${s.id}`,
    prompt: "do",
    touches: [],
    verify: [],
    depends_on: s.depends_on ?? [],
  }));
  return {
    name: "sched test",
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

function seed(specs: Parameters<typeof makePlan>[0]): {
  runId: string;
  plan: Plan;
} {
  const plan = makePlan(specs);
  const runId = createRun(opened.db, {
    plan,
    planPath: "/p",
    slug: "s",
  });
  upsertFromPlan(opened.db, runId, plan);
  return { runId, plan };
}

function runToSucceeded(runId: string, taskId: string): void {
  // The scheduler's next() may have already marked this task `ready`;
  // tolerate either pending or ready as a starting point.
  const cur = getTask(opened.db, runId, taskId);
  if (cur?.status === "pending") {
    markReady(opened.db, runId, taskId);
  }
  markRunning(opened.db, {
    runId,
    taskId,
    sessionId: "ses_test",
    branch: "b",
    worktreePath: "/w",
  });
  markSucceeded(opened.db, runId, taskId);
}

// --- next() — simple cases -------------------------------------------------

describe("scheduler.next()", () => {
  test("returns the only pending root", () => {
    const { runId, plan } = seed([{ id: "T1" }]);
    const sch = makeScheduler({ db: opened.db, runId, plan });
    const picked = sch.next();
    expect(picked).not.toBeNull();
    expect(picked!.task.id).toBe("T1");
    expect(picked!.row.status).toBe("ready"); // marked ready
  });

  test("returns null when nothing is pending", () => {
    const { runId, plan } = seed([{ id: "T1" }]);
    runToSucceeded(runId, "T1");
    const sch = makeScheduler({ db: opened.db, runId, plan });
    expect(sch.next()).toBeNull();
  });

  test("respects declaration order among multiple ready roots (deterministic tiebreak)", () => {
    const { runId, plan } = seed([{ id: "Z" }, { id: "A" }]);
    const sch = makeScheduler({ db: opened.db, runId, plan });
    expect(sch.next()!.task.id).toBe("Z");
  });

  test("does NOT return a task whose deps are not yet succeeded", () => {
    const { runId, plan } = seed([
      { id: "T1" },
      { id: "T2", depends_on: ["T1"] },
    ]);
    const sch = makeScheduler({ db: opened.db, runId, plan });
    // T1 is the only ready one initially.
    const first = sch.next();
    expect(first!.task.id).toBe("T1");

    // T1 now in `ready` status; T2 still blocked because T1 is not
    // succeeded. next() must NOT return T2.
    const second = sch.next();
    // First call returned T1 and marked it ready. A second call before
    // T1 reaches `succeeded` should not pick T1 again (not pending) or
    // T2 (deps unsatisfied).
    expect(second).toBeNull();
  });

  test("returns dependent task once the dep succeeds", () => {
    const { runId, plan } = seed([
      { id: "T1" },
      { id: "T2", depends_on: ["T1"] },
    ]);
    const sch = makeScheduler({ db: opened.db, runId, plan });
    sch.next(); // marks T1 ready
    runToSucceeded(runId, "T1");
    const next = sch.next();
    expect(next!.task.id).toBe("T2");
  });
});

// --- next() — diamond ------------------------------------------------------

describe("scheduler.next() — diamond DAG", () => {
  test("after T1 succeeds, T2 + T3 become eligible (in declaration order)", () => {
    const { runId, plan } = seed([
      { id: "T1" },
      { id: "T2", depends_on: ["T1"] },
      { id: "T3", depends_on: ["T1"] },
      { id: "T4", depends_on: ["T2", "T3"] },
    ]);
    const sch = makeScheduler({ db: opened.db, runId, plan });
    sch.next(); // pick T1
    runToSucceeded(runId, "T1");

    expect(sch.next()!.task.id).toBe("T2");
    runToSucceeded(runId, "T2");

    expect(sch.next()!.task.id).toBe("T3");
    runToSucceeded(runId, "T3");

    // T4 now ready (both deps succeeded).
    expect(sch.next()!.task.id).toBe("T4");
  });

  test("T4 is NOT ready until BOTH T2 and T3 succeed", () => {
    const { runId, plan } = seed([
      { id: "T1" },
      { id: "T2", depends_on: ["T1"] },
      { id: "T3", depends_on: ["T1"] },
      { id: "T4", depends_on: ["T2", "T3"] },
    ]);
    const sch = makeScheduler({ db: opened.db, runId, plan });
    runToSucceeded(runId, "T1");
    runToSucceeded(runId, "T2");
    // T3 still pending; T4 should NOT pop yet.
    sch.next(); // returns T3
    // Even after walking, T4 should still be "no, deps unsatisfied".
    expect(sch.next()).toBeNull();
  });
});

// --- cascadeFail -----------------------------------------------------------

describe("scheduler.cascadeFail", () => {
  test("blocks direct dependents of a failed task", () => {
    const { runId, plan } = seed([
      { id: "T1" },
      { id: "T2", depends_on: ["T1"] },
      { id: "T3", depends_on: ["T1"] },
    ]);
    const sch = makeScheduler({ db: opened.db, runId, plan });

    markReady(opened.db, runId, "T1");
    markRunning(opened.db, {
      runId,
      taskId: "T1",
      sessionId: "x",
      branch: "x",
      worktreePath: "/x",
    });
    markFailed(opened.db, runId, "T1", "boom");

    const blocked = sch.cascadeFail("T1");
    expect(new Set(blocked)).toEqual(new Set(["T2", "T3"]));
    expect(getTask(opened.db, runId, "T2")?.status).toBe("blocked");
    expect(getTask(opened.db, runId, "T3")?.status).toBe("blocked");
    // T2 / T3 last_error mentions T1.
    expect(getTask(opened.db, runId, "T2")?.last_error).toMatch(/T1/);
  });

  test("blocks transitive dependents (cascade through chain)", () => {
    const { runId, plan } = seed([
      { id: "T1" },
      { id: "T2", depends_on: ["T1"] },
      { id: "T3", depends_on: ["T2"] },
      { id: "T4", depends_on: ["T3"] },
    ]);
    const sch = makeScheduler({ db: opened.db, runId, plan });

    markReady(opened.db, runId, "T1");
    markRunning(opened.db, {
      runId,
      taskId: "T1",
      sessionId: "x",
      branch: "x",
      worktreePath: "/x",
    });
    markFailed(opened.db, runId, "T1", "boom");

    const blocked = sch.cascadeFail("T1");
    expect(new Set(blocked)).toEqual(new Set(["T2", "T3", "T4"]));
  });

  test("custom reason is honored", () => {
    const { runId, plan } = seed([
      { id: "T1" },
      { id: "T2", depends_on: ["T1"] },
    ]);
    const sch = makeScheduler({ db: opened.db, runId, plan });

    markReady(opened.db, runId, "T1");
    markRunning(opened.db, {
      runId,
      taskId: "T1",
      sessionId: "x",
      branch: "x",
      worktreePath: "/x",
    });
    markFailed(opened.db, runId, "T1", "boom");

    sch.cascadeFail("T1", "custom reason here");
    expect(getTask(opened.db, runId, "T2")?.last_error).toBe(
      "custom reason here",
    );
  });

  test("does NOT touch already-terminal dependents (succeeded / aborted)", () => {
    const { runId, plan } = seed([
      { id: "T1" },
      { id: "T2", depends_on: ["T1"] }, // mark succeeded artificially
      { id: "T3", depends_on: ["T1"] },
    ]);
    const sch = makeScheduler({ db: opened.db, runId, plan });

    // Pretend T2 already succeeded (test setup; not realistic
    // dependency-wise, but tests the guard).
    markReady(opened.db, runId, "T2");
    markRunning(opened.db, {
      runId,
      taskId: "T2",
      sessionId: "x",
      branch: "x",
      worktreePath: "/x",
    });
    markSucceeded(opened.db, runId, "T2");

    markReady(opened.db, runId, "T1");
    markRunning(opened.db, {
      runId,
      taskId: "T1",
      sessionId: "x",
      branch: "x",
      worktreePath: "/x",
    });
    markFailed(opened.db, runId, "T1", "boom");

    const blocked = sch.cascadeFail("T1");
    expect(blocked).toEqual(["T3"]);
    expect(getTask(opened.db, runId, "T2")?.status).toBe("succeeded");
  });

  test("disconnected components are unaffected", () => {
    const { runId, plan } = seed([
      { id: "A1" },
      { id: "B1" },
      { id: "A2", depends_on: ["A1"] },
      { id: "B2", depends_on: ["B1"] },
    ]);
    const sch = makeScheduler({ db: opened.db, runId, plan });

    markReady(opened.db, runId, "A1");
    markRunning(opened.db, {
      runId,
      taskId: "A1",
      sessionId: "x",
      branch: "x",
      worktreePath: "/x",
    });
    markFailed(opened.db, runId, "A1", "boom");

    sch.cascadeFail("A1");
    expect(getTask(opened.db, runId, "A2")?.status).toBe("blocked");
    expect(getTask(opened.db, runId, "B1")?.status).toBe("pending");
    expect(getTask(opened.db, runId, "B2")?.status).toBe("pending");
  });

  test("cascadeFail with no dependents returns empty list", () => {
    const { runId, plan } = seed([{ id: "T1" }]);
    const sch = makeScheduler({ db: opened.db, runId, plan });

    markReady(opened.db, runId, "T1");
    markRunning(opened.db, {
      runId,
      taskId: "T1",
      sessionId: "x",
      branch: "x",
      worktreePath: "/x",
    });
    markFailed(opened.db, runId, "T1", "boom");

    expect(sch.cascadeFail("T1")).toEqual([]);
  });
});

// --- isComplete ------------------------------------------------------------

describe("scheduler.isComplete", () => {
  test("false when any task is pending", () => {
    const { runId, plan } = seed([{ id: "T1" }]);
    const sch = makeScheduler({ db: opened.db, runId, plan });
    expect(sch.isComplete()).toBe(false);
  });

  test("true when every task is in a terminal status", () => {
    const { runId, plan } = seed([{ id: "T1" }, { id: "T2" }]);
    const sch = makeScheduler({ db: opened.db, runId, plan });
    runToSucceeded(runId, "T1");
    runToSucceeded(runId, "T2");
    expect(sch.isComplete()).toBe(true);
  });

  test("true when failed + cascaded blocked = terminal", () => {
    const { runId, plan } = seed([
      { id: "T1" },
      { id: "T2", depends_on: ["T1"] },
    ]);
    const sch = makeScheduler({ db: opened.db, runId, plan });
    markReady(opened.db, runId, "T1");
    markRunning(opened.db, {
      runId,
      taskId: "T1",
      sessionId: "x",
      branch: "x",
      worktreePath: "/x",
    });
    markFailed(opened.db, runId, "T1", "boom");
    sch.cascadeFail("T1");
    expect(sch.isComplete()).toBe(true);
  });

  test("false when a task is currently `running`", () => {
    const { runId, plan } = seed([{ id: "T1" }]);
    const sch = makeScheduler({ db: opened.db, runId, plan });
    markReady(opened.db, runId, "T1");
    markRunning(opened.db, {
      runId,
      taskId: "T1",
      sessionId: "x",
      branch: "x",
      worktreePath: "/x",
    });
    expect(sch.isComplete()).toBe(false);
  });
});

// --- planTask --------------------------------------------------------------

describe("scheduler.planTask", () => {
  test("returns the static plan task by id", () => {
    const { runId, plan } = seed([{ id: "T1" }, { id: "T2" }]);
    const sch = makeScheduler({ db: opened.db, runId, plan });
    expect(sch.planTask("T1")?.id).toBe("T1");
  });

  test("returns null for unknown id", () => {
    const { runId, plan } = seed([{ id: "T1" }]);
    const sch = makeScheduler({ db: opened.db, runId, plan });
    expect(sch.planTask("ZZ")).toBeNull();
  });
});
