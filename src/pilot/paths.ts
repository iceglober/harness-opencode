/**
 * Pilot state directory layout.
 *
 * Mirrors the per-repo, worktree-agnostic key derivation from
 * `src/plan-paths.ts` but for the pilot subsystem's richer layout. All
 * pilot state lives under:
 *
 *     <base>/<repo-folder>/pilot/
 *       plans/                     YAML plans (input artifacts)
 *       runs/<runId>/              one dir per `pilot build` invocation
 *         state.db                 sqlite (Phase B1)
 *         workers/<n>.jsonl        per-worker structured logs (Phase E1)
 *       worktrees/<runId>/<n>/     git worktrees for tasks (Phase C1)
 *
 * Where:
 *   - `<base>` = `$GLORIOUS_PILOT_DIR` (with leading `~` expanded), else
 *     `$GLORIOUS_PLAN_DIR/..` if that env is set (so users overriding
 *     the harness root get pilot under it for free), else
 *     `~/.glorious/opencode`.
 *   - `<repo-folder>` is identical to the key from `src/plan-paths.ts`,
 *     so `pilot/plans/` and the harness's existing `plans/` (used by
 *     `/plan`) live as siblings under the same per-repo directory.
 *   - `<runId>` is a ULID (Phase B1 picks the format; this module is
 *     opaque to it).
 *   - Worker `<n>` is a 0-padded integer (e.g. `00`, `01`).
 *
 * Why a separate module from `plan-paths.ts`:
 *   - `plan-paths.ts` is consumed by the existing `/plan` flow
 *     (free-form markdown plans), which has different invariants: a
 *     single flat dir of `.md` files, in-place migration from a legacy
 *     location, no nested run state. Reusing that file would conflate
 *     two contracts and force one to constrain the other.
 *   - This module ALSO doesn't migrate anything — pilot is brand new,
 *     there's no legacy state to absorb.
 *
 * Auto-creation policy:
 *   - `getPilotDir`, `getPlansDir`: created on first access (callers
 *     expect a usable directory).
 *   - `getRunDir`, `getWorktreeDir`, `getStateDbPath`,
 *     `getWorkerJsonlPath`: parent directory created on first access of
 *     `getRunDir`. Specific files are NOT pre-created — that's the
 *     SQLite or fs writer's job.
 *
 * Ship-checklist alignment: Phase A5 of `PILOT_TODO.md`.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getRepoFolder } from "../plan-paths.js";

// --- Helpers ---------------------------------------------------------------

/**
 * Tilde-expand a path. Identical behavior to `plan-paths.ts::expandTilde`
 * — duplicated rather than exported across modules to keep
 * `plan-paths.ts` free of new external consumers (it currently has none
 * outside its own module + CLI).
 */
function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolve the base dir for ALL glorious state — `~/.glorious/opencode`
 * by default, overridable via env. The cascade:
 *
 *   1. `GLORIOUS_PILOT_DIR` (highest priority — explicit pilot scope).
 *   2. `GLORIOUS_PLAN_DIR/..` (if user overrode plan-dir; pilot lives as
 *      a sibling in their custom location).
 *   3. `~/.glorious/opencode` (default).
 *
 * Returns the absolute base — NOT yet repo-scoped. Callers compose with
 * `<repoFolder>/pilot/...` themselves.
 */
function resolveBaseDir(): string {
  const pilotEnv = process.env.GLORIOUS_PILOT_DIR;
  if (pilotEnv) return expandTilde(pilotEnv);

  const planEnv = process.env.GLORIOUS_PLAN_DIR;
  if (planEnv) {
    // User overrode plan dir to e.g. `~/scratch/plans`. The natural
    // sibling for pilot state is `~/scratch/` (parent of plan dir).
    // This way the user's mental model "all glorious state lives under
    // /scratch/" survives.
    return path.dirname(expandTilde(planEnv));
  }

  return path.join(os.homedir(), ".glorious", "opencode");
}

/**
 * Pad a worker index to two digits. `0` → `"00"`, `12` → `"12"`,
 * `100` → `"100"` (no truncation; we let the rare 3-digit case
 * sort lexically wrong rather than overflow).
 */
function padWorker(n: number): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`worker index must be a non-negative integer, got ${n}`);
  }
  return n.toString().padStart(2, "0");
}

// --- Public API ------------------------------------------------------------

/**
 * Resolve `<base>/<repo>/pilot/`. Creates the directory if missing.
 *
 * `cwd` is the worktree path the pilot is running from — we derive the
 * repo key from its `git common-dir` per `getRepoFolder`. Throws if
 * `cwd` isn't inside a git repo.
 */
export async function getPilotDir(cwd: string): Promise<string> {
  const base = resolveBaseDir();
  const repoFolder = await getRepoFolder(cwd);
  const dir = path.join(base, repoFolder, "pilot");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Resolve `<pilot>/plans/`. Created if missing.
 *
 * Plan-as-input artifacts live here. The CLI's `pilot validate`,
 * `pilot plan`, and `pilot build` commands all read from this directory.
 */
export async function getPlansDir(cwd: string): Promise<string> {
  const pilot = await getPilotDir(cwd);
  const dir = path.join(pilot, "plans");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Resolve `<pilot>/runs/<runId>/`. Created if missing.
 *
 * One directory per `pilot build` invocation. Holds the SQLite state
 * file, worker JSONL logs, and any other per-run artifacts.
 */
export async function getRunDir(cwd: string, runId: string): Promise<string> {
  if (!isSafeRunId(runId)) {
    throw new Error(
      `getRunDir: runId ${JSON.stringify(runId)} is not a safe filesystem segment`,
    );
  }
  const pilot = await getPilotDir(cwd);
  const dir = path.join(pilot, "runs", runId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Resolve `<pilot>/worktrees/<runId>/<n>/` — the directory that will be
 * passed to `git worktree add`. Created if missing (parent only; git
 * itself creates the leaf when the worktree is added).
 *
 * `n` is the worker index (0 for v0.1's single worker; up to v0.3's
 * configured pool size).
 */
export async function getWorktreeDir(
  cwd: string,
  runId: string,
  n: number,
): Promise<string> {
  if (!isSafeRunId(runId)) {
    throw new Error(
      `getWorktreeDir: runId ${JSON.stringify(runId)} is not a safe filesystem segment`,
    );
  }
  const pilot = await getPilotDir(cwd);
  const parent = path.join(pilot, "worktrees", runId);
  await fs.mkdir(parent, { recursive: true });
  return path.join(parent, padWorker(n));
}

/**
 * Resolve `<runDir>/state.db`. Does NOT create or open the database —
 * that's the caller's job (Phase B1). Just returns the path.
 *
 * Parent directory IS created (via `getRunDir`) so SQLite can open
 * with `O_CREAT` and not error on a missing dir.
 */
export async function getStateDbPath(
  cwd: string,
  runId: string,
): Promise<string> {
  const runDir = await getRunDir(cwd, runId);
  return path.join(runDir, "state.db");
}

/**
 * Resolve `<runDir>/workers/<n>.jsonl`. Creates the parent
 * `workers/` directory if missing. Caller appends to the JSONL file.
 */
export async function getWorkerJsonlPath(
  cwd: string,
  runId: string,
  n: number,
): Promise<string> {
  const runDir = await getRunDir(cwd, runId);
  const workersDir = path.join(runDir, "workers");
  await fs.mkdir(workersDir, { recursive: true });
  return path.join(workersDir, `${padWorker(n)}.jsonl`);
}

// --- Validation helpers ----------------------------------------------------

/**
 * Reject runIds that contain path separators, leading dots, or other
 * filesystem-mischief characters. ULIDs (the expected shape) are
 * `[0-9A-Z]{26}`, well within this check.
 *
 * We don't enforce the ULID grammar exactly — a future refactor might
 * use UUIDs or `<date>-<n>`, and it'd be silly to gate this module on
 * one format. Just keep the segment to a safe character class.
 */
function isSafeRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(runId);
}
