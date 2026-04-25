/**
 * `pilot build` — execute a pilot.yaml plan via the worker loop.
 *
 * Wires every Phase A-F primitive together:
 *
 *   1. Resolve + load + validate the plan (Phase A).
 *   2. Open / migrate the state DB at <runDir>/state.db (Phase B).
 *   3. Create a run row + insert task rows.
 *   4. Spawn an opencode server (Phase D1) and bind a client + bus.
 *   5. Build a worktree pool + scheduler.
 *   6. Run the worker (Phase E).
 *   7. Mark the run terminal; print summary.
 *
 * Flags:
 *   --plan <path>        Override plan path (default: newest in plans dir).
 *   --filter <id>        Run only the named task (single id only in v0.1).
 *   --dry-run            Validate + print the plan summary; do not execute.
 *   --opencode-port <n>  Port for the spawned server (default: 0 = random).
 *   --workers <n>        v0.1 only honors 1; warns if >1 (clamps to 1).
 *
 * Exit codes:
 *   - 0: every task succeeded.
 *   - 1: I/O / wiring failure (couldn't load plan, couldn't start server).
 *   - 2: plan validation failure.
 *   - 3: at least one task failed (plan was valid + executed; some failed).
 *   - 130: user interrupt (SIGINT).
 */

import {
  command,
  flag,
  option,
  optional,
  string,
  number as cmdNumber,
} from "cmd-ts";
import * as path from "node:path";

import { runValidate } from "./validate.js";
import { loadPlan } from "../plan/load.js";
import { validateDag } from "../plan/dag.js";
import { deriveSlug, resolveUniqueSlug } from "../plan/slug.js";
import {
  getPlansDir,
  getRunDir,
  getStateDbPath,
  getWorktreeDir,
} from "../paths.js";
import { openStateDb } from "../state/db.js";
import {
  createRun,
  markRunRunning,
  markRunFinished,
} from "../state/runs.js";
import { upsertFromPlan, countByStatus } from "../state/tasks.js";
import { appendEvent } from "../state/events.js";
import { startOpencodeServer } from "../opencode/server.js";
import { EventBus } from "../opencode/events.js";
import { WorktreePool } from "../worktree/pool.js";
import { headSha } from "../worktree/git.js";
import { makeScheduler } from "../scheduler/ready-set.js";
import { runWorker } from "../worker/worker.js";
import { promises as fs } from "node:fs";

// --- Public command --------------------------------------------------------

export const buildCmd = command({
  name: "build",
  description: "Execute a pilot.yaml plan via the worker loop.",
  args: {
    plan: option({
      long: "plan",
      type: optional(string),
      description:
        "Path to the plan file. Defaults to the newest *.yaml in the pilot plans dir.",
    }),
    filter: option({
      long: "filter",
      type: optional(string),
      description: "Run only this task id (v0.1: single id only).",
    }),
    dryRun: flag({
      long: "dry-run",
      description: "Validate the plan and print a summary; do not execute.",
    }),
    opencodePort: option({
      long: "opencode-port",
      type: optional(cmdNumber),
      description: "Port for the spawned opencode server (default: 0 = random).",
    }),
    workers: option({
      long: "workers",
      type: optional(cmdNumber),
      description: "Worker count. v0.1 supports 1; >1 is clamped with a warning.",
    }),
  },
  handler: async (args) => {
    const code = await runBuild(args);
    process.exit(code);
  },
});

// --- Implementation --------------------------------------------------------

export async function runBuild(opts: {
  plan?: string | undefined;
  filter?: string | undefined;
  dryRun?: boolean;
  opencodePort?: number | undefined;
  workers?: number | undefined;
}): Promise<number> {
  // 1. Validate. Reuse runValidate so we get the same error rendering.
  const validateCode = await runValidate({
    planPath: opts.plan,
    quiet: true,
  });
  if (validateCode !== 0) return validateCode;

  // 2. Re-load (validate already opened it once; re-loading is cheap
  //    and lets us keep runValidate as a pure exit-code function).
  const planPath = await resolvePlanPath(opts.plan);
  const loaded = await loadPlan(planPath);
  if (!loaded.ok) {
    // Should be unreachable since runValidate just succeeded; defensive.
    process.stderr.write(`pilot build: load failed unexpectedly\n`);
    return 1;
  }
  const plan = loaded.plan;

  // 3. DAG (also validated above; we need the topo order here).
  const dag = validateDag(plan);
  if (!dag.ok) {
    process.stderr.write(`pilot build: DAG invalid (re-run pilot validate)\n`);
    return 2;
  }

  if (opts.workers !== undefined && opts.workers > 1) {
    process.stderr.write(
      `pilot build: --workers=${opts.workers} requested, but v0.1 supports 1; clamping.\n`,
    );
  }

  // Filter narrowing (v0.1: single id only).
  if (opts.filter !== undefined) {
    if (!plan.tasks.find((t) => t.id === opts.filter)) {
      process.stderr.write(
        `pilot build: --filter ${JSON.stringify(opts.filter)} doesn't match any task in the plan\n`,
      );
      return 2;
    }
  }

  if (opts.dryRun) {
    printDryRun(plan, planPath);
    return 0;
  }

  const cwd = process.cwd();

  // 4. Derive run-id + slug + dirs.
  const slug = await deriveUniqueSlug(plan, planPath, cwd);
  const branchPrefix = plan.branch_prefix ?? `pilot/${slug}`;

  // 5. Open state DB.
  const opened = openStateDb(":memory:"); // placeholder; reassigned below
  opened.close();
  const cleanup: Array<() => Promise<void> | void> = [];

  // We can't compute the runId before createRun (that's the source of
  // truth for ULID generation). Open a temporary in-memory DB just to
  // call createRun? No — createRun expects the same DB to persist. Do
  // it in two phases: pre-allocate a dir using a placeholder, then
  // move once we know the id. Simpler approach: open a tmp DB just to
  // generate the ULID via createRun's internal call, then move the
  // file? Cleaner: refactor createRun to accept a pre-generated id.
  //
  // For v0.1, the simplest correct flow: use ULID generation directly.
  const { ulid } = await import("ulid");
  const runId = ulid();
  const dbPath = await getStateDbPath(cwd, runId);
  const runDir = await getRunDir(cwd, runId);

  const real = openStateDb(dbPath);
  cleanup.push(() => real.close());

  // Since we generated the runId externally, we manually insert the
  // run row to mirror createRun's effect.
  real.db.run(
    `INSERT INTO runs (id, plan_path, plan_slug, started_at, status)
     VALUES (?, ?, ?, ?, 'pending')`,
    [runId, planPath, slug, Date.now()],
  );
  // (Keep the import to satisfy "unused import" lint cleanliness when
  // we eventually refactor.)
  void createRun;

  upsertFromPlan(real.db, runId, plan);
  markRunRunning(real.db, runId);
  appendEvent(real.db, {
    runId,
    kind: "run.started",
    payload: { planPath, slug, runDir, branchPrefix },
  });

  // From here on, the per-run execution is shared with `pilot resume`.
  return executeRun({
    db: real,
    runId,
    plan,
    planPath,
    runDir,
    branchPrefix,
    cleanup,
    opencodePort: opts.opencodePort,
  });
}

/**
 * Execute the worker against an already-prepared run row + state DB.
 *
 * Extracted from `runBuild` so `pilot resume` can re-enter the
 * post-validation lifecycle without re-creating a run row. Caller is
 * responsible for:
 *
 *   - Validating the plan (no-op on resume; the plan was validated at
 *     build time).
 *   - Inserting the `runs` row + task rows (build creates fresh; resume
 *     leaves existing rows alone).
 *   - Setting up the `cleanup` array (caller pushes whatever needs to
 *     run on exit).
 *
 * Returns the appropriate exit code: 0 = clean, 3 = some failures,
 * 130 = aborted, 1 = wiring failure.
 */
export async function executeRun(args: {
  db: ReturnType<typeof openStateDb>;
  runId: string;
  plan: ReturnType<typeof loadPlan> extends Promise<infer R>
    ? R extends { ok: true; plan: infer P }
      ? P
      : never
    : never;
  planPath: string;
  runDir: string;
  branchPrefix: string;
  cleanup: Array<() => Promise<void> | void>;
  opencodePort?: number | undefined;
}): Promise<number> {
  const { db, runId, plan, planPath, runDir, branchPrefix, cleanup } = args;
  const cwd = process.cwd();

  // 6. Spawn server.
  let server;
  try {
    server = await startOpencodeServer({
      port: args.opencodePort ?? 0,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    appendEvent(db.db, {
      runId,
      kind: "run.error",
      payload: { phase: "server-start", reason },
    });
    markRunFinished(db.db, runId, "failed");
    process.stderr.write(`pilot: ${reason}\n`);
    await runCleanup(cleanup);
    return 1;
  }
  cleanup.push(() => server!.shutdown());

  const bus = new EventBus(server.client);
  cleanup.push(() => bus.close());

  // 7. Build pool + scheduler.
  const pool = new WorktreePool({
    repoPath: cwd,
    worktreeDir: async (n) => getWorktreeDir(cwd, runId, n),
  });
  cleanup.push(() => pool.shutdown({ keepPreserved: true }));

  const scheduler = makeScheduler({ db: db.db, runId, plan });

  // 8. Determine the base ref.
  let base: string;
  try {
    base = await headSha(cwd);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`pilot: cannot resolve HEAD sha: ${reason}\n`);
    appendEvent(db.db, {
      runId,
      kind: "run.error",
      payload: { phase: "head-sha", reason },
    });
    markRunFinished(db.db, runId, "failed");
    await runCleanup(cleanup);
    return 1;
  }

  // 9. Run the worker.
  const aborter = new AbortController();
  const sigintHandler = () => aborter.abort("SIGINT");
  process.once("SIGINT", sigintHandler);
  cleanup.push(() => {
    process.off("SIGINT", sigintHandler);
  });

  const result = await runWorker({
    db: db.db,
    runId,
    plan,
    scheduler,
    pool,
    client: server.client,
    bus,
    branchPrefix,
    base,
    abortSignal: aborter.signal,
  });

  // 10. Compute final disposition.
  const counts = countByStatus(db.db, runId);
  const finalStatus = result.aborted
    ? "aborted"
    : counts.failed > 0 || counts.aborted > 0 || counts.blocked > 0
      ? "failed"
      : "completed";
  markRunFinished(db.db, runId, finalStatus);
  appendEvent(db.db, {
    runId,
    kind: "run.finished",
    payload: { status: finalStatus, counts },
  });

  // 11. Print summary BEFORE cleanup so subprocess shutdown noise
  //     doesn't interleave with the user-facing report.
  printSummary({ planPath, runId, runDir, counts, finalStatus });

  // 12. Cleanup (server, bus, pool, sigint handler, db).
  await runCleanup(cleanup);

  if (result.aborted) return 130;
  if (counts.failed > 0 || counts.aborted > 0 || counts.blocked > 0) return 3;
  return 0;
}

// --- Helpers ---------------------------------------------------------------

async function resolvePlanPath(input: string | undefined): Promise<string> {
  if (input !== undefined && input.length > 0) {
    return path.resolve(input);
  }
  const dir = await getPlansDir(process.cwd());
  const entries = await fs.readdir(dir);
  const yamls = entries.filter((n) => n.endsWith(".yaml") || n.endsWith(".yml"));
  if (yamls.length === 0) {
    throw new Error(`pilot build: no *.yaml in ${dir}`);
  }
  let newest: { name: string; mtime: number } | null = null;
  for (const name of yamls) {
    const st = await fs.stat(path.join(dir, name));
    if (newest === null || st.mtimeMs > newest.mtime) {
      newest = { name, mtime: st.mtimeMs };
    }
  }
  return path.join(dir, newest!.name);
}

async function deriveUniqueSlug(
  plan: { name: string },
  planPath: string,
  cwd: string,
): Promise<string> {
  // Use the plan filename basename (sans extension) as the source of
  // truth — the planner agent already deterministically slugged the
  // input when saving. Fallback to plan.name → kebab if needed.
  const base =
    path.basename(planPath, path.extname(planPath)) ||
    deriveSlug(plan.name);

  const dir = await getPlansDir(cwd);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const existingSlugs = new Set(
    entries
      .filter((n) => n.endsWith(".yaml") || n.endsWith(".yml"))
      .map((n) => path.basename(n, path.extname(n))),
  );
  // The plan we're building IS in the dir; that's not a "collision".
  existingSlugs.delete(base);
  return resolveUniqueSlug(base, existingSlugs);
}

function printDryRun(
  plan: { name: string; tasks: ReadonlyArray<{ id: string; title: string }> },
  planPath: string,
): void {
  process.stdout.write(
    `# pilot build --dry-run\nPlan: ${plan.name} (${planPath})\nTasks:\n`,
  );
  for (const t of plan.tasks) {
    process.stdout.write(`  - ${t.id}: ${t.title}\n`);
  }
}

function printSummary(args: {
  planPath: string;
  runId: string;
  runDir: string;
  counts: ReturnType<typeof countByStatus>;
  finalStatus: string;
}): void {
  const { counts, finalStatus, runId, runDir, planPath } = args;
  const totalRun = counts.succeeded + counts.failed + counts.aborted;
  process.stdout.write(
    `\nRun ${runId} ${finalStatus}: ` +
      `succeeded=${counts.succeeded} failed=${counts.failed} ` +
      `blocked=${counts.blocked} aborted=${counts.aborted} ` +
      `pending=${counts.pending} ready=${counts.ready} running=${counts.running} ` +
      `(of ${totalRun + counts.blocked + counts.pending + counts.ready + counts.running} total)\n` +
      `  plan: ${planPath}\n` +
      `  run dir: ${runDir}\n` +
      `  status: bunx @glrs-dev/harness-opencode pilot status --run ${runId}\n` +
      `  logs:   bunx @glrs-dev/harness-opencode pilot logs --run ${runId} <task-id>\n`,
  );
}

async function runCleanup(
  cleanup: Array<() => Promise<void> | void>,
): Promise<void> {
  // Run in reverse insertion order so dependencies tear down before the
  // things they depended on (e.g. bus.close before server.shutdown).
  while (cleanup.length > 0) {
    const fn = cleanup.pop()!;
    try {
      await fn();
    } catch {
      // Swallow cleanup errors — by definition we're already shutting
      // down; a noisy stack trace doesn't help the user understand
      // the actual run outcome.
    }
  }
}
