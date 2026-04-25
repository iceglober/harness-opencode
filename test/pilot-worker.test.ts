// pilot-worker.test.ts — coverage for src/pilot/worker/worker.ts.
//
// The worker depends on: state DB (real :memory:), scheduler (real),
// pool + git (real, tmp repo), client + bus (mocked), runVerify
// (real, runs trivial bash). This split keeps tests honest: the
// behaviors most likely to break in real runs (state transitions,
// git operations, shell invocations) are exercised directly; the
// SDK calls are mocked (we test the SDK separately in the spike-S2
// notes).

import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openStateDb } from "../src/pilot/state/db.js";
import { createRun } from "../src/pilot/state/runs.js";
import { upsertFromPlan, getTask } from "../src/pilot/state/tasks.js";
import { readEventsDecoded } from "../src/pilot/state/events.js";
import { makeScheduler } from "../src/pilot/scheduler/ready-set.js";
import { WorktreePool } from "../src/pilot/worktree/pool.js";
import { gitIsAvailable, headSha } from "../src/pilot/worktree/git.js";
import { runWorker } from "../src/pilot/worker/worker.js";
import type { Plan, PlanTask } from "../src/pilot/plan/schema.js";
import type { EventLike, EventHandler } from "../src/pilot/opencode/events.js";

// --- Test fixtures --------------------------------------------------------

let GIT_OK = false;
beforeAll(async () => {
  GIT_OK = await gitIsAvailable();
});

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-worker-test-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-b", "main", "--quiet", dir], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  execFileSync("git", ["-C", dir, "config", "user.email", "t@e.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "T"]);
  execFileSync("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
}
function gitCommitFile(repo: string, name: string, content: string, msg: string): string {
  fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
  fs.writeFileSync(path.join(repo, name), content);
  execFileSync("git", ["-C", repo, "add", name]);
  execFileSync("git", ["-C", repo, "commit", "-m", msg, "--quiet"]);
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

// --- Mock client + bus -----------------------------------------------------

/**
 * Build a mock bus. Tests push events into the bus to drive the worker
 * (e.g. "send a session.idle so waitForIdle resolves").
 */
function makeMockBus() {
  const handlers: Array<{ sessionID: string; handler: EventHandler }> = [];
  let closed = false;

  const bus = {
    on: (sessionID: string, handler: EventHandler) => {
      const sub = { sessionID, handler };
      handlers.push(sub);
      return () => {
        const i = handlers.indexOf(sub);
        if (i !== -1) handlers.splice(i, 1);
      };
    },
    waitForIdle: async (sessionID: string, opts: { stallMs?: number; abortSignal?: AbortSignal } = {}) => {
      // Find the special "idle promise" the test installed for this session.
      // Tests use `pushIdleResult(sessionID, result)` to enqueue.
      return new Promise<{ kind: string; [k: string]: unknown }>((resolve) => {
        const queue = idleQueue.get(sessionID) ?? [];
        const next = queue.shift();
        if (next) {
          // Settle on next microtask so async caller has a chance to register handlers etc.
          queueMicrotask(() => resolve(next));
        } else {
          // Default: stall after timeout (so unhandled tests fail loudly).
          const t = setTimeout(() => {
            resolve({ kind: "stall", stallMs: opts.stallMs ?? 1 });
          }, 50);
          if (opts.abortSignal) {
            opts.abortSignal.addEventListener("abort", () => {
              clearTimeout(t);
              resolve({ kind: "abort", reason: opts.abortSignal!.reason });
            }, { once: true });
          }
        }
      });
    },
    close: async () => { closed = true; },
    getStreamError: () => null,
  };

  // Per-session queue of waitForIdle results.
  const idleQueue = new Map<string, Array<{ kind: string; [k: string]: unknown }>>();
  const pushIdleResult = (sessionID: string, result: { kind: string; [k: string]: unknown }) => {
    const q = idleQueue.get(sessionID) ?? [];
    q.push(result);
    idleQueue.set(sessionID, q);
  };

  // Helper to fan-out a synthetic event to subscribed handlers.
  // Mirrors the real EventBus's session-id extraction: events carry the
  // sessionID either flat (`properties.sessionID` on session.idle, etc.)
  // or nested inside `properties.info.sessionID` (message.updated) /
  // `properties.part.sessionID` (message.part.updated).
  const emitEvent = (event: EventLike) => {
    const p = event.properties as {
      sessionID?: string;
      info?: { sessionID?: string };
      part?: { sessionID?: string };
    };
    const sid =
      p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID ?? null;
    if (sid === null) return;
    for (const h of [...handlers]) {
      if (h.sessionID === sid) h.handler(event);
    }
  };

  return { bus, pushIdleResult, emitEvent, isClosed: () => closed };
}

/**
 * Build a mock OpencodeClient. Records each session.create / promptAsync /
 * abort / get / messages call so tests can assert on them.
 */
function makeMockClient(opts: {
  sessionId?: string;
  cost?: number;
  promptAsyncImpl?: (args: unknown) => void | Promise<void>;
  sessionCreateImpl?: (args: unknown) => { data: { id: string } };
} = {}) {
  const calls: Record<string, unknown[]> = {
    sessionCreate: [],
    promptAsync: [],
    abort: [],
    get: [],
    messages: [],
  };
  const sessionId = opts.sessionId ?? "ses_test_1";
  const cost = opts.cost ?? 0;

  const client = {
    session: {
      create: async (args: unknown) => {
        calls.sessionCreate!.push(args);
        if (opts.sessionCreateImpl) {
          return opts.sessionCreateImpl(args);
        }
        return { data: { id: sessionId } };
      },
      promptAsync: async (args: unknown) => {
        calls.promptAsync!.push(args);
        if (opts.promptAsyncImpl) await opts.promptAsyncImpl(args);
        return { data: undefined };
      },
      abort: async (args: unknown) => {
        calls.abort!.push(args);
        return { data: true };
      },
      get: async (args: unknown) => {
        calls.get!.push(args);
        return { data: { id: sessionId, cost } };
      },
      messages: async (args: unknown) => {
        calls.messages!.push(args);
        return { data: [] };
      },
    },
  };
  return { client, calls };
}

// --- Plan + run setup ------------------------------------------------------

function makePlan(specs: Array<{
  id: string;
  touches?: string[];
  verify?: string[];
  depends_on?: string[];
}>): Plan {
  const tasks: PlanTask[] = specs.map((s) => ({
    id: s.id,
    title: `task ${s.id}`,
    prompt: `do ${s.id}`,
    touches: s.touches ?? [],
    verify: s.verify ?? [],
    depends_on: s.depends_on ?? [],
  }));
  return {
    name: "worker test plan",
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

// --- Happy path -----------------------------------------------------------

describe("runWorker — happy path", () => {
  test("succeeds: prepare → prompt → idle → verify pass → commit", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "src/a.ts", "x", "init");

    const plan = makePlan([
      {
        id: "T1",
        touches: ["src/**"],
        // Verify command also performs the "agent's edit" — bash
        // creates a file inside the worktree's src/ before passing.
        // This sidesteps mocking the agent's actual file edits.
        verify: [`echo new > src/created.ts && true`],
      },
    ]);
    const opened = openStateDb(":memory:");
    try {
      const runId = createRun(opened.db, { plan, planPath: "/p", slug: "s" });
      upsertFromPlan(opened.db, runId, plan);

      const scheduler = makeScheduler({ db: opened.db, runId, plan });
      const pool = new WorktreePool({
        repoPath: repo,
        worktreeDir: async () => path.join(tmp, "wt", "00"),
      });
      const { bus, pushIdleResult } = makeMockBus();
      const { client, calls } = makeMockClient();

      // Pre-stage the idle event for the first prompt.
      pushIdleResult("ses_test_1", { kind: "idle" });

      const result = await runWorker({
        db: opened.db,
        runId,
        plan,
        scheduler,
        pool,
        client: client as never,
        bus: bus as never,
        branchPrefix: "pilot/test",
        base: "main",
        maxAttempts: 3,
        stallMs: 60_000,
      });

      expect(result.aborted).toBe(false);
      expect(result.attempted).toEqual(["T1"]);

      const t1 = getTask(opened.db, runId, "T1")!;
      expect(t1.status).toBe("succeeded");
      expect(t1.session_id).toBe("ses_test_1");
      expect(t1.branch).toBe("pilot/test/T1");

      // Mocked client received exactly one create + one promptAsync.
      expect(calls.sessionCreate).toHaveLength(1);
      expect(calls.promptAsync).toHaveLength(1);

      // Events table records the lifecycle.
      const events = readEventsDecoded(opened.db, { runId });
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain("task.started");
      expect(kinds).toContain("task.session.created");
      expect(kinds).toContain("task.attempt");
      expect(kinds).toContain("task.verify.passed");
      expect(kinds).toContain("task.succeeded");

      // Worktree was committed (head moved).
      const newHead = await headSha(path.join(tmp, "wt", "00"));
      expect(newHead).not.toBe("");
    } finally {
      opened.close();
    }
  });

  test("verify-only task (empty touches, no edits): succeeds without commit", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "src/a.ts", "x", "init");
    const plan = makePlan([
      { id: "T1", touches: [], verify: ["true"] },
    ]);
    const opened = openStateDb(":memory:");
    try {
      const runId = createRun(opened.db, { plan, planPath: "/p", slug: "s" });
      upsertFromPlan(opened.db, runId, plan);
      const { bus, pushIdleResult } = makeMockBus();
      const { client } = makeMockClient();
      pushIdleResult("ses_test_1", { kind: "idle" });

      const result = await runWorker({
        db: opened.db,
        runId,
        plan,
        scheduler: makeScheduler({ db: opened.db, runId, plan }),
        pool: new WorktreePool({
          repoPath: repo,
          worktreeDir: async () => path.join(tmp, "wt", "00"),
        }),
        client: client as never,
        bus: bus as never,
        branchPrefix: "pilot/x",
        base: "main",
        maxAttempts: 1,
        stallMs: 5_000,
      });

      expect(result.aborted).toBe(false);
      expect(getTask(opened.db, runId, "T1")?.status).toBe("succeeded");
      const events = readEventsDecoded(opened.db, { runId });
      const succeeded = events.find((e) => e.kind === "task.succeeded");
      expect(succeeded?.payload).toEqual({ commit: null, changed: [] });
    } finally {
      opened.close();
    }
  });
});

// --- Verify failure → fix loop --------------------------------------------

describe("runWorker — verify failure / fix loop", () => {
  test("fails first attempt, succeeds on second (fix loop reuses session)", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "src/a.ts", "x", "init");

    // The verify command checks for `src/created.ts`. The "agent" (mocked
    // via promptAsync side-effect) creates the file ONLY on the second
    // prompt — first attempt fails verify, second succeeds.
    let attempts = 0;
    const wtPath = path.join(tmp, "wt", "00");

    const plan = makePlan([
      {
        id: "T1",
        touches: ["src/**"],
        verify: [`test -f ${wtPath}/src/created.ts`],
      },
    ]);
    const opened = openStateDb(":memory:");
    try {
      const runId = createRun(opened.db, { plan, planPath: "/p", slug: "s" });
      upsertFromPlan(opened.db, runId, plan);
      const { bus, pushIdleResult } = makeMockBus();
      const { client, calls } = makeMockClient({
        promptAsyncImpl: () => {
          attempts++;
          if (attempts === 2) {
            // Second prompt: simulate the agent creating the file.
            fs.mkdirSync(path.join(wtPath, "src"), { recursive: true });
            fs.writeFileSync(path.join(wtPath, "src/created.ts"), "ok\n");
          }
        },
      });
      pushIdleResult("ses_test_1", { kind: "idle" });
      pushIdleResult("ses_test_1", { kind: "idle" });

      const result = await runWorker({
        db: opened.db,
        runId,
        plan,
        scheduler: makeScheduler({ db: opened.db, runId, plan }),
        pool: new WorktreePool({
          repoPath: repo,
          worktreeDir: async () => wtPath,
        }),
        client: client as never,
        bus: bus as never,
        branchPrefix: "pilot/fix",
        base: "main",
        maxAttempts: 3,
        stallMs: 5_000,
      });

      expect(result.aborted).toBe(false);
      expect(getTask(opened.db, runId, "T1")?.status).toBe("succeeded");
      // session.create called once (fix loop reuses the session).
      expect(calls.sessionCreate).toHaveLength(1);
      // promptAsync called twice (kickoff + fix).
      expect(calls.promptAsync).toHaveLength(2);
    } finally {
      opened.close();
    }
  });

  test("fails after maxAttempts; preserves worktree", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "src/a.ts", "x", "init");

    const wtPath = path.join(tmp, "wt", "00");
    const plan = makePlan([
      { id: "T1", touches: ["src/**"], verify: ["false"] }, // always fails
    ]);
    const opened = openStateDb(":memory:");
    try {
      const runId = createRun(opened.db, { plan, planPath: "/p", slug: "s" });
      upsertFromPlan(opened.db, runId, plan);
      const { bus, pushIdleResult } = makeMockBus();
      const { client } = makeMockClient();
      pushIdleResult("ses_test_1", { kind: "idle" });
      pushIdleResult("ses_test_1", { kind: "idle" });
      pushIdleResult("ses_test_1", { kind: "idle" });
      const pool = new WorktreePool({
        repoPath: repo,
        worktreeDir: async () => wtPath,
      });

      await runWorker({
        db: opened.db,
        runId,
        plan,
        scheduler: makeScheduler({ db: opened.db, runId, plan }),
        pool,
        client: client as never,
        bus: bus as never,
        branchPrefix: "pilot/x",
        base: "main",
        maxAttempts: 3,
        stallMs: 5_000,
      });

      const t = getTask(opened.db, runId, "T1")!;
      expect(t.status).toBe("failed");
      expect(t.last_error).toMatch(/verify failed.*3 attempts/);
      // Worktree preserved.
      expect(pool.inspect()[0]?.preserved).toBe(true);
    } finally {
      opened.close();
    }
  });
});

// --- Touches violation ----------------------------------------------------

describe("runWorker — touches violation", () => {
  test("verify passes but agent edited out-of-scope → marks failed and preserves", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "src/a.ts", "x", "init");

    const wtPath = path.join(tmp, "wt", "00");
    // The verify command itself creates an OUT-OF-SCOPE file (in `docs/`).
    // touches:[src/**] means this is a touches violation.
    const plan = makePlan([
      {
        id: "T1",
        touches: ["src/**"],
        verify: [`mkdir -p ${wtPath}/docs && echo leak > ${wtPath}/docs/leak.md`],
      },
    ]);
    const opened = openStateDb(":memory:");
    try {
      const runId = createRun(opened.db, { plan, planPath: "/p", slug: "s" });
      upsertFromPlan(opened.db, runId, plan);
      const { bus, pushIdleResult } = makeMockBus();
      const { client } = makeMockClient();
      // 3 attempts in case the worker retries (it will, with fix prompts).
      pushIdleResult("ses_test_1", { kind: "idle" });
      pushIdleResult("ses_test_1", { kind: "idle" });
      pushIdleResult("ses_test_1", { kind: "idle" });
      const pool = new WorktreePool({
        repoPath: repo,
        worktreeDir: async () => wtPath,
      });

      await runWorker({
        db: opened.db,
        runId,
        plan,
        scheduler: makeScheduler({ db: opened.db, runId, plan }),
        pool,
        client: client as never,
        bus: bus as never,
        branchPrefix: "pilot/x",
        base: "main",
        maxAttempts: 3,
        stallMs: 5_000,
      });

      const t = getTask(opened.db, runId, "T1")!;
      expect(t.status).toBe("failed");
      expect(t.last_error).toMatch(/touches violation/);
      expect(pool.inspect()[0]?.preserved).toBe(true);
    } finally {
      opened.close();
    }
  });
});

// --- STOP detection ------------------------------------------------------

describe("runWorker — STOP protocol", () => {
  test("agent emits STOP → marks failed with STOP reason; preserves worktree", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "src/a.ts", "x", "init");

    const wtPath = path.join(tmp, "wt", "00");
    const plan = makePlan([
      { id: "T1", touches: ["src/**"], verify: ["true"] },
    ]);
    const opened = openStateDb(":memory:");
    try {
      const runId = createRun(opened.db, { plan, planPath: "/p", slug: "s" });
      upsertFromPlan(opened.db, runId, plan);
      const { bus, pushIdleResult, emitEvent } = makeMockBus();
      const { client } = makeMockClient({
        promptAsyncImpl: () => {
          // Simulate the agent emitting a STOP message before idle.
          // The bus emits the events as if the SSE stream did.
          // (Order matters: the worker subscribes the StopDetector
          // before promptAsync, and the bus's `on` queues the
          // handler. We emit synchronously here so the events go
          // through before the idle is pushed.)
          emitEvent({
            type: "message.updated",
            properties: {
              info: {
                id: "msg_stop",
                sessionID: "ses_test_1",
                role: "assistant",
                time: { created: 1 },
                modelID: "m",
                providerID: "p",
                mode: "x",
                path: { cwd: "/", root: "/" },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                parentID: "",
              },
            },
          });
          emitEvent({
            type: "message.part.updated",
            properties: {
              part: {
                id: "p1",
                messageID: "msg_stop",
                sessionID: "ses_test_1",
                type: "text",
                text: "STOP: tool unavailable",
              },
            },
          });
        },
      });
      // The worker waits for idle after promptAsync; our stop-detect
      // already fired during the synthetic events. Then idle resolves
      // and the worker checks `stopReason !== null` and bails.
      pushIdleResult("ses_test_1", { kind: "idle" });
      const pool = new WorktreePool({
        repoPath: repo,
        worktreeDir: async () => wtPath,
      });

      await runWorker({
        db: opened.db,
        runId,
        plan,
        scheduler: makeScheduler({ db: opened.db, runId, plan }),
        pool,
        client: client as never,
        bus: bus as never,
        branchPrefix: "pilot/x",
        base: "main",
        maxAttempts: 3,
        stallMs: 5_000,
      });

      const t = getTask(opened.db, runId, "T1")!;
      expect(t.status).toBe("failed");
      expect(t.last_error).toMatch(/STOP:.*tool unavailable/);
      expect(pool.inspect()[0]?.preserved).toBe(true);
    } finally {
      opened.close();
    }
  });
});

// --- Stall handling ------------------------------------------------------

describe("runWorker — stall", () => {
  test("waitForIdle returns stall → mark failed and preserve", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "src/a.ts", "x", "init");

    const wtPath = path.join(tmp, "wt", "00");
    const plan = makePlan([{ id: "T1", touches: ["src/**"], verify: ["true"] }]);
    const opened = openStateDb(":memory:");
    try {
      const runId = createRun(opened.db, { plan, planPath: "/p", slug: "s" });
      upsertFromPlan(opened.db, runId, plan);
      const { bus, pushIdleResult } = makeMockBus();
      const { client, calls } = makeMockClient();
      pushIdleResult("ses_test_1", { kind: "stall", stallMs: 1000 });
      const pool = new WorktreePool({
        repoPath: repo,
        worktreeDir: async () => wtPath,
      });

      await runWorker({
        db: opened.db,
        runId,
        plan,
        scheduler: makeScheduler({ db: opened.db, runId, plan }),
        pool,
        client: client as never,
        bus: bus as never,
        branchPrefix: "pilot/x",
        base: "main",
        maxAttempts: 3,
        stallMs: 1_000,
      });

      const t = getTask(opened.db, runId, "T1")!;
      expect(t.status).toBe("failed");
      expect(t.last_error).toMatch(/stalled/);
      // session.abort was called.
      expect(calls.abort).toHaveLength(1);
      expect(pool.inspect()[0]?.preserved).toBe(true);
    } finally {
      opened.close();
    }
  });
});

// --- Cascade fail --------------------------------------------------------

describe("runWorker — cascade-fail dependents", () => {
  test("when T1 fails, T2 (depends on T1) is marked blocked", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "src/a.ts", "x", "init");

    const wtPath = path.join(tmp, "wt", "00");
    const plan = makePlan([
      { id: "T1", touches: ["src/**"], verify: ["false"] },
      { id: "T2", touches: ["src/**"], verify: ["true"], depends_on: ["T1"] },
    ]);
    const opened = openStateDb(":memory:");
    try {
      const runId = createRun(opened.db, { plan, planPath: "/p", slug: "s" });
      upsertFromPlan(opened.db, runId, plan);
      const { bus, pushIdleResult } = makeMockBus();
      const { client } = makeMockClient();
      // T1 will run 3 attempts; queue 3 idles.
      pushIdleResult("ses_test_1", { kind: "idle" });
      pushIdleResult("ses_test_1", { kind: "idle" });
      pushIdleResult("ses_test_1", { kind: "idle" });

      const result = await runWorker({
        db: opened.db,
        runId,
        plan,
        scheduler: makeScheduler({ db: opened.db, runId, plan }),
        pool: new WorktreePool({
          repoPath: repo,
          worktreeDir: async () => wtPath,
        }),
        client: client as never,
        bus: bus as never,
        branchPrefix: "pilot/x",
        base: "main",
        maxAttempts: 3,
        stallMs: 5_000,
      });

      expect(getTask(opened.db, runId, "T1")?.status).toBe("failed");
      expect(getTask(opened.db, runId, "T2")?.status).toBe("blocked");
      expect(getTask(opened.db, runId, "T2")?.last_error).toMatch(/T1/);
      // Worker only attempts T1 (T2 blocked before pickup).
      expect(result.attempted).toEqual(["T1"]);
    } finally {
      opened.close();
    }
  });
});

// --- Abort signal --------------------------------------------------------

describe("runWorker — abort signal", () => {
  test("abort during waitForIdle: aborts session, marks task aborted, preserves worktree", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "src/a.ts", "x", "init");

    const wtPath = path.join(tmp, "wt", "00");
    const plan = makePlan([{ id: "T1", touches: ["src/**"], verify: ["true"] }]);
    const opened = openStateDb(":memory:");
    try {
      const runId = createRun(opened.db, { plan, planPath: "/p", slug: "s" });
      upsertFromPlan(opened.db, runId, plan);
      const { bus, pushIdleResult } = makeMockBus();
      const { client, calls } = makeMockClient();
      // waitForIdle returns abort — simulating signal-fired-during-wait.
      pushIdleResult("ses_test_1", { kind: "abort", reason: "test" });
      const pool = new WorktreePool({
        repoPath: repo,
        worktreeDir: async () => wtPath,
      });
      const ctrl = new AbortController();
      // We do NOT pre-abort: the worker checks the signal BEFORE picking a
      // task. By leaving the signal un-aborted at start, runWorker enters
      // the per-task path. Inside, the mock bus's waitForIdle returns
      // {kind:"abort"} immediately. The worker treats that as an abort.
      // (Real-world: the signal would have aborted by then; the bus
      // observes it via abortSignal listener and resolves abort.)
      void ctrl;

      const result = await runWorker({
        db: opened.db,
        runId,
        plan,
        scheduler: makeScheduler({ db: opened.db, runId, plan }),
        pool,
        client: client as never,
        bus: bus as never,
        branchPrefix: "pilot/x",
        base: "main",
        maxAttempts: 3,
        stallMs: 5_000,
      });

      // No abort signal observed before runWorker exits its loop, so
      // `aborted` is false at the result level — but the per-task abort
      // path still ran (driven by the mocked waitForIdle result).
      expect(result.attempted).toEqual(["T1"]);
      expect(getTask(opened.db, runId, "T1")?.status).toBe("aborted");
      expect(calls.abort).toHaveLength(1);
      expect(pool.inspect()[0]?.preserved).toBe(true);
    } finally {
      opened.close();
    }
  });

  test("pre-aborted signal exits without attempting any task", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "src/a.ts", "x", "init");

    const wtPath = path.join(tmp, "wt", "00");
    const plan = makePlan([{ id: "T1", touches: ["src/**"], verify: ["true"] }]);
    const opened = openStateDb(":memory:");
    try {
      const runId = createRun(opened.db, { plan, planPath: "/p", slug: "s" });
      upsertFromPlan(opened.db, runId, plan);
      const { bus } = makeMockBus();
      const { client } = makeMockClient();
      const pool = new WorktreePool({
        repoPath: repo,
        worktreeDir: async () => wtPath,
      });
      const ctrl = new AbortController();
      ctrl.abort("pre-aborted");

      const result = await runWorker({
        db: opened.db,
        runId,
        plan,
        scheduler: makeScheduler({ db: opened.db, runId, plan }),
        pool,
        client: client as never,
        bus: bus as never,
        branchPrefix: "pilot/x",
        base: "main",
        maxAttempts: 3,
        stallMs: 5_000,
        abortSignal: ctrl.signal,
      });

      expect(result.aborted).toBe(true);
      expect(result.attempted).toEqual([]);
      // T1 still pending — never picked up.
      expect(getTask(opened.db, runId, "T1")?.status).toBe("pending");
    } finally {
      opened.close();
    }
  });
});
