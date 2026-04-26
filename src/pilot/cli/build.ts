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
  positional,
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
import { appendEvent, subscribeToEvents } from "../state/events.js";
import { startOpencodeServer } from "../opencode/server.js";
import { EventBus } from "../opencode/events.js";
import { WorktreePool } from "../worktree/pool.js";
import { headSha } from "../worktree/git.js";
import { makeScheduler } from "../scheduler/ready-set.js";
import { runWorker } from "../worker/worker.js";
import { promises as fs } from "node:fs";
import { requirePlugin } from "../../cli/plugin-check.js";

// --- Public command --------------------------------------------------------

export const buildCmd = command({
  name: "build",
  description: "Execute a pilot.yaml plan via the worker loop.",
  args: {
    planPositional: positional({
      type: optional(string),
      displayName: "plan",
      description:
        "Plan path: absolute, cwd-relative, or bare filename (with or without .yaml/.yml) resolved against the pilot plans dir. Omit to pick interactively from the plans dir.",
    }),
    plan: option({
      long: "plan",
      type: optional(string),
      description:
        "Path to the plan file. Wins over the positional arg for backwards compatibility. Defaults to interactive picker; in non-TTY mode falls back to the newest *.yaml in the pilot plans dir.",
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
    quiet: flag({
      long: "quiet",
      description:
        "Suppress per-task progress lines on stderr. Summary and error output still print.",
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
    await requirePlugin();
    const code = await runBuild(args);
    process.exit(code);
  },
});

// --- Implementation --------------------------------------------------------

export async function runBuild(opts: {
  /** Positional plan arg: absolute, cwd-relative, or bare filename. */
  planPositional?: string | undefined;
  /** --plan flag: wins over the positional arg when both are supplied. */
  plan?: string | undefined;
  filter?: string | undefined;
  dryRun?: boolean;
  quiet?: boolean;
  opencodePort?: number | undefined;
  workers?: number | undefined;
  /**
   * Test seam. When no plan arg is provided and stdin is a TTY, we call
   * this to let the user pick a plan from the dir. Defaults to an
   * `@inquirer/prompts` `select()` listing plans sorted by mtime desc.
   * Returns the chosen absolute plan path, or `undefined` if the user
   * bailed (Ctrl-C).
   */
  readPlanSelection?: () => Promise<string | undefined>;
  /**
   * Test seam. Streaming progress lines are written via this function.
   * Defaults to `process.stderr.write`. Tests inject a stub to capture
   * output without polluting the test runner's stderr.
   */
  stderrWriter?: (chunk: string) => void;
}): Promise<number> {
  const cwd = process.cwd();
  const stderrWriter =
    opts.stderrWriter ?? ((s) => void process.stderr.write(s));

  // 1. Resolve the plan path BEFORE handing off to runValidate. Previously
  //    `runValidate` re-resolved, which meant a relative bare-filename
  //    like `rule-engine-refocus.yaml` was treated as cwd-relative and
  //    missed the plans dir entirely. We do the three-step resolution
  //    here and pass an absolute path downstream.
  const resolveResult = await resolvePlanPathSmart(
    {
      flag: opts.plan,
      positional: opts.planPositional,
    },
    cwd,
    opts.readPlanSelection,
  );
  if (resolveResult.kind === "cancelled") return 130;
  if (resolveResult.kind === "error") {
    process.stderr.write(`pilot build: ${resolveResult.message}\n`);
    return 2;
  }
  const resolvedPlanPath = resolveResult.path;

  // 2. Validate. Reuse runValidate so we get the same error rendering.
  const validateCode = await runValidate({
    planPath: resolvedPlanPath,
    quiet: true,
  });
  if (validateCode !== 0) return validateCode;

  // 3. Re-load (validate already opened it once; re-loading is cheap
  //    and lets us keep runValidate as a pure exit-code function).
  const planPath = resolvedPlanPath;
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

  // 4. Derive run-id + slug + dirs.
  const slug = await deriveUniqueSlug(plan, planPath, cwd);

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

  // Branch prefix MUST include the runId so that two runs of the same
  // plan don't collide on `git worktree add -B`. Prior runs with preserved
  // worktrees hold `<basePrefix>/<oldRunId>/<taskId>` branches; new runs
  // get `<basePrefix>/<newRunId>/<taskId>`. `pilot resume` reconstructs
  // the same prefix using the persisted run_id.
  const branchPrefix = deriveBranchPrefix(plan.branch_prefix, slug, runId);

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
    quiet: opts.quiet,
    stderrWriter,
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
  /** Suppress per-task streaming output on stderr. Summary still prints. */
  quiet?: boolean;
  /** Sink for streaming log lines. Defaults to `process.stderr.write`. */
  stderrWriter?: (chunk: string) => void;
}): Promise<number> {
  const { db, runId, plan, planPath, runDir, branchPrefix, cleanup } = args;
  const cwd = process.cwd();
  const stderrWriter =
    args.stderrWriter ?? ((s: string) => void process.stderr.write(s));

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

  // Streaming progress logger — subscribes to appendEvent fan-out and
  // writes per-task lines to stderr as events are persisted. Suppressed
  // under --quiet. Teardown runs before DB close; we push it to cleanup
  // so SIGINT paths also clean up the subscription.
  if (args.quiet !== true) {
    const unsubLogger = startStreamingLogger({
      stderrWriter,
      runId,
      totalTasks: plan.tasks.length,
      subscribe: subscribeToEvents,
    });
    cleanup.push(() => unsubLogger());
    stderrWriter(
      `pilot build: run ${runId} started (${plan.tasks.length} tasks)\n`,
    );
  }

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

/**
 * Three-step plan-path resolver. Replaces the v0.1 resolver, which only
 * handled `path.resolve(input)` (and therefore failed on bare filenames
 * that live in the plans dir — forcing users to type the full
 * `~/.glorious/opencode/<repo>/pilot/plans/<file>.yaml` every time).
 *
 * Resolution order:
 *   1. `--plan <path>` flag (preserved for backwards compatibility and
 *      script pinning). Treated as an explicit absolute-or-cwd-relative
 *      path; no fallback search.
 *   2. Positional plan arg. Tried as: (a) absolute path, (b) cwd-relative,
 *      (c) plans-dir-relative, (d) plans-dir-relative with `.yaml` appended,
 *      (e) plans-dir-relative with `.yml` appended. First hit wins.
 *   3. Interactive picker via `readPlanSelection()` when stdin is a TTY.
 *   4. Fallback to the newest *.yaml in the plans dir (old default).
 *
 * Returns a discriminated result so callers can distinguish "user Ctrl-C'd
 * out of the picker" (exit 130) from "no plan could be resolved" (exit 2)
 * from a successful resolution.
 */
type ResolveResult =
  | { kind: "ok"; path: string }
  | { kind: "cancelled" } // user hit Ctrl-C in the picker
  | { kind: "error"; message: string };

async function resolvePlanPathSmart(
  input: { flag?: string | undefined; positional?: string | undefined },
  cwd: string,
  readPlanSelection?: () => Promise<string | undefined>,
): Promise<ResolveResult> {
  // 1. --plan flag — explicit, wins over positional.
  if (input.flag !== undefined && input.flag.length > 0) {
    const resolved = path.isAbsolute(input.flag)
      ? input.flag
      : path.resolve(cwd, input.flag);
    if (await isFile(resolved)) {
      return { kind: "ok", path: resolved };
    }
    return {
      kind: "error",
      message: `cannot find plan at ${JSON.stringify(resolved)} (from --plan ${JSON.stringify(input.flag)})`,
    };
  }

  // 2. Positional arg — three-step resolution.
  if (input.positional !== undefined && input.positional.length > 0) {
    const plansDir = await getPlansDir(cwd);
    const candidates: string[] = [];
    if (path.isAbsolute(input.positional)) {
      candidates.push(input.positional);
    } else {
      candidates.push(path.resolve(cwd, input.positional));
      candidates.push(path.join(plansDir, input.positional));
      if (!/\.(ya?ml)$/i.test(input.positional)) {
        candidates.push(path.join(plansDir, `${input.positional}.yaml`));
        candidates.push(path.join(plansDir, `${input.positional}.yml`));
      }
    }
    for (const c of candidates) {
      if (await isFile(c)) return { kind: "ok", path: c };
    }
    return {
      kind: "error",
      message:
        `cannot find plan ${JSON.stringify(input.positional)}. Tried:\n` +
        candidates.map((c) => `  - ${c}`).join("\n"),
    };
  }

  // 3. Interactive picker — only when stdin is a TTY AND a reader is
  //    available (either the default inquirer picker or a test stub).
  //    A caller that explicitly passes `readPlanSelection: undefined`
  //    AND no args is asking for the non-interactive fallback path,
  //    which we handle in step 4.
  if (process.stdin.isTTY && readPlanSelection !== undefined) {
    const picked = await readPlanSelection();
    if (picked === undefined) return { kind: "cancelled" };
    return { kind: "ok", path: picked };
  }
  if (process.stdin.isTTY && readPlanSelection === undefined) {
    // Production default: fall back to the inquirer-backed picker when
    // the caller didn't override. Tests that want non-interactive
    // fallback should pass `readPlanSelection: () => Promise.resolve(undefined)`
    // or just use the --plan flag / positional.
    const picked = await defaultReadPlanSelection(cwd);
    if (picked === undefined) return { kind: "cancelled" };
    return { kind: "ok", path: picked };
  }

  // 4. Non-TTY fallback: newest *.yaml in the plans dir. Same behavior
  //    as the v0.1 default; preserved so scripts piping into `pilot build`
  //    with no args keep working.
  const plansDir = await getPlansDir(cwd);
  const newest = await findNewestYaml(plansDir);
  if (newest === null) {
    return {
      kind: "error",
      message: `no *.yaml files in ${plansDir}`,
    };
  }
  return { kind: "ok", path: newest };
}

async function isFile(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function findNewestYaml(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const yamls = entries.filter(
    (n) => n.endsWith(".yaml") || n.endsWith(".yml"),
  );
  if (yamls.length === 0) return null;
  let newest: { name: string; mtime: number } | null = null;
  for (const name of yamls) {
    try {
      const st = await fs.stat(path.join(dir, name));
      if (newest === null || st.mtimeMs > newest.mtime) {
        newest = { name, mtime: st.mtimeMs };
      }
    } catch {
      continue;
    }
  }
  return newest ? path.join(dir, newest.name) : null;
}

/**
 * Default interactive plan picker. Dynamic-imports `@inquirer/prompts`
 * so the dep is only loaded when `pilot build` is invoked interactively
 * with no plan arg. Matches the pattern used in `pilot plan` for the
 * free-text prompt.
 *
 * Returns the chosen absolute plan path, or `undefined` if the user hit
 * Ctrl-C (inquirer throws `ExitPromptError`).
 */
async function defaultReadPlanSelection(
  cwd: string,
): Promise<string | undefined> {
  const plansDir = await getPlansDir(cwd);
  let entries: string[];
  try {
    entries = await fs.readdir(plansDir);
  } catch {
    return undefined;
  }
  const yamls = entries.filter(
    (n) => n.endsWith(".yaml") || n.endsWith(".yml"),
  );
  if (yamls.length === 0) return undefined;

  // Stat in parallel to sort by mtime desc.
  const stats = await Promise.all(
    yamls.map(async (name) => {
      const full = path.join(plansDir, name);
      try {
        const st = await fs.stat(full);
        return { name, full, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const sorted = stats
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => b.mtime - a.mtime);

  // Best-effort plan-name enrichment. If loadPlan succeeds, show the
  // `name:` field alongside the filename. If it fails (invalid YAML,
  // schema errors, etc.), just show the filename — a broken plan still
  // belongs in the picker list so the user can discover it.
  const annotated = await Promise.all(
    sorted.map(async (s) => {
      try {
        const loaded = await loadPlan(s.full);
        const planName = loaded.ok ? loaded.plan.name : null;
        return { ...s, planName };
      } catch {
        return { ...s, planName: null };
      }
    }),
  );

  const choices = annotated.map((a) => ({
    name: formatPickerRow(a.name, a.planName, a.mtime),
    value: a.full,
  }));

  const { select } = await import("@inquirer/prompts");
  try {
    const chosen = await select({
      message: "Pick a plan:",
      choices,
    });
    return chosen;
  } catch (err) {
    if (isExitPromptError(err)) return undefined;
    throw err;
  }
}

function formatPickerRow(
  filename: string,
  planName: string | null,
  mtimeMs: number,
): string {
  const rel = relativeTimeFromNow(mtimeMs);
  if (planName === null) return `${filename}  —  ${rel}`;
  return `${filename}  —  ${planName}  —  ${rel}`;
}

function relativeTimeFromNow(thenMs: number): string {
  const deltaMs = Date.now() - thenMs;
  const s = Math.max(0, Math.round(deltaMs / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function isExitPromptError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "name" in err &&
    (err as { name: unknown }).name === "ExitPromptError"
  );
}

/**
 * Start a streaming logger that writes per-task progress lines to
 * `stderrWriter` as events are appended to the DB. Returns an
 * unsubscribe function that teardown should call in all paths
 * (normal completion, SIGINT, error).
 *
 * The logger subscribes to the global `appendEvent` fan-out (added in
 * `src/pilot/state/events.ts`). Subscribing there instead of the
 * EventBus keeps us at the semantic layer (task-level events already
 * computed by the worker) rather than the raw opencode SSE stream.
 *
 * Output is deliberately compact — one line per high-signal event, not
 * every event kind. Users who need the full trace can `pilot logs --run`.
 */
export function startStreamingLogger(args: {
  stderrWriter: (chunk: string) => void;
  runId: string;
  totalTasks: number;
  subscribe: typeof import("../state/events.js").subscribeToEvents;
  clock?: () => number;
}): () => void {
  const { stderrWriter, runId, totalTasks, subscribe } = args;
  const clock = args.clock ?? (() => Date.now());
  const taskStart = new Map<string, number>();
  let succeeded = 0;
  let failed = 0;

  const formatTs = (ms: number): string => {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  };

  const write = (line: string) => {
    stderrWriter(`[${formatTs(clock())}] ${line}\n`);
  };

  const unsub = subscribe((event) => {
    // Scope to this run only; in practice there's only one active run
    // per `pilot build` process, but filter defensively in case other
    // runs concurrently insert (pilot plan, other subsystems).
    if (event.runId !== runId) return;

    const id = event.taskId;
    switch (event.kind) {
      case "task.started":
        if (id !== null) taskStart.set(id, event.ts);
        write(`task.started ${id ?? "?"}`);
        break;
      case "task.verify.passed":
        write(`task.verify.passed ${id ?? "?"}`);
        break;
      case "task.verify.failed":
        write(`task.verify.failed ${id ?? "?"}`);
        break;
      case "task.succeeded": {
        succeeded += 1;
        const ms = id !== null ? event.ts - (taskStart.get(id) ?? event.ts) : 0;
        write(`task.succeeded ${id ?? "?"} in ${Math.round(ms / 1000)}s`);
        write(`run.progress ${succeeded}/${totalTasks} succeeded`);
        break;
      }
      case "task.failed": {
        failed += 1;
        const ms = id !== null ? event.ts - (taskStart.get(id) ?? event.ts) : 0;
        write(`task.failed ${id ?? "?"} in ${Math.round(ms / 1000)}s`);
        write(
          `run.progress ${succeeded}/${totalTasks} succeeded, ${failed} failed`,
        );
        break;
      }
      case "task.aborted":
        write(`task.aborted ${id ?? "?"}`);
        break;
      case "task.stopped":
        write(`task.stopped ${id ?? "?"} (builder STOP)`);
        break;
      case "task.blocked":
        write(`task.blocked ${id ?? "?"}`);
        break;
      case "task.touches.violation":
        write(`task.touches.violation ${id ?? "?"}`);
        break;
      // Other kinds (task.session.created, task.attempt, run.*) are
      // intentionally suppressed — too chatty for stdout. `pilot logs`
      // carries the full trace.
      default:
        break;
    }
  });

  return unsub;
}

/**
 * Construct the branch prefix used for per-task worktrees. Format is
 * `<basePrefix>/<runId>` where `<basePrefix>` is either the user's
 * `plan.branch_prefix` override or the default `pilot/<slug>`.
 *
 * The runId segment is what makes branches collision-free across runs
 * of the same plan. Without it, `preserveOnFailure` worktrees from a
 * prior run hold branches with the same name, and `git worktree add -B`
 * refuses to re-bind them. With it, each run's branches live in their
 * own ULID-scoped namespace.
 *
 * Exported so tests can lock the shape.
 */
export function deriveBranchPrefix(
  planBranchPrefix: string | undefined,
  slug: string,
  runId: string,
): string {
  const base = planBranchPrefix ?? `pilot/${slug}`;
  return `${base}/${runId}`;
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
