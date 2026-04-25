/**
 * Git wrappers for the pilot worktree subsystem.
 *
 * Pilot uses `git worktree` to give each task its own checkout. The
 * functions here are thin promisified wrappers around `git -C <path>`
 * via `execFile`. They:
 *
 *   - Reject inputs that could shell-inject (we use `execFile`, not
 *     `exec`, so argument arrays are safe — but null bytes and similar
 *     are still rejected for clarity).
 *   - Set sensible default timeouts (30s) so a hung git invocation
 *     doesn't wedge the worker forever.
 *   - Surface stderr in error messages — git's actual error reasons live
 *     there, and we want them in the worker's logs.
 *
 * Higher-level orchestration (acquire-a-worktree, prepare for a task,
 * preserve on failure) lives in `pool.ts`. This module is the
 * "git plumbing" layer.
 *
 * Ship-checklist alignment: Phase C1 of `PILOT_TODO.md`.
 */

import { execFile } from "node:child_process";

// --- execFile wrapper ------------------------------------------------------

type ExecResult = { stdout: string; stderr: string };

/**
 * Promisified `execFile` with a default timeout. Returns both stdout and
 * stderr on success; rejects with an `Error` whose message contains the
 * stderr so consumers don't have to inspect the underlying child-process
 * error shape.
 *
 * `timeoutMs = 30_000` covers slow operations like `git fetch` over a
 * congested link without being so long that a truly hung command stalls
 * a `pilot build` indefinitely.
 */
function execFileP(
  file: string,
  args: readonly string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  const { cwd, timeoutMs = 30_000, env } = opts;
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    execFile(
      file,
      args,
      {
        signal: controller.signal,
        cwd,
        encoding: "utf8",
        env,
        // Increase maxBuffer — git diff/log output can exceed the
        // 1MB default on large repos.
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        if (err) {
          // execFile's error message is unhelpful ("Command failed: git
          // ..."); enrich with stderr.
          const msg = `${err.message}${
            stderr ? `\nstderr:\n${stderr}` : ""
          }`;
          reject(new Error(msg));
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

// --- Argument validation ---------------------------------------------------

/**
 * Reject strings that contain null bytes (which would surprise execFile)
 * or that are empty (which usually indicates a caller bug).
 */
function assertSafeArg(s: string, label: string): void {
  if (typeof s !== "string" || s.length === 0) {
    throw new TypeError(`${label}: expected non-empty string, got ${JSON.stringify(s)}`);
  }
  if (s.includes("\0")) {
    throw new TypeError(`${label}: contains null byte: ${JSON.stringify(s)}`);
  }
}

// --- Public API ------------------------------------------------------------

/**
 * Check that `git` is on PATH. Used by `doctor` and the worker before
 * the first git operation. Cheap (single subprocess) and definitive.
 */
export async function gitIsAvailable(): Promise<boolean> {
  try {
    await execFileP("git", ["--version"], { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the abbreviated short-sha at HEAD. The pool stores this as
 * `sinceSha` so `enforceTouches` can diff post-task changes.
 */
export async function headSha(repoOrWorktree: string): Promise<string> {
  assertSafeArg(repoOrWorktree, "headSha repo");
  const { stdout } = await execFileP("git", [
    "-C",
    repoOrWorktree,
    "rev-parse",
    "HEAD",
  ]);
  return stdout.trim();
}

/**
 * Current branch name (or empty string if detached HEAD).
 */
export async function currentBranch(worktree: string): Promise<string> {
  assertSafeArg(worktree, "currentBranch");
  const { stdout } = await execFileP("git", [
    "-C",
    worktree,
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  const out = stdout.trim();
  // `rev-parse --abbrev-ref HEAD` returns "HEAD" for detached state.
  return out === "HEAD" ? "" : out;
}

/**
 * Add a worktree at `worktreePath` checked out at `commit-ish` (a
 * branch name, sha, or tag). `repoPath` is the main checkout where the
 * worktree is registered.
 *
 * `branch` is optional: when provided, the worktree is created on a
 * fresh branch off `commitIsh`; when omitted, the worktree just checks
 * out `commitIsh` directly (useful for read-only inspection).
 */
export async function gitWorktreeAdd(args: {
  repoPath: string;
  worktreePath: string;
  commitIsh: string;
  branch?: string;
}): Promise<void> {
  assertSafeArg(args.repoPath, "repoPath");
  assertSafeArg(args.worktreePath, "worktreePath");
  assertSafeArg(args.commitIsh, "commitIsh");

  const cmd = ["-C", args.repoPath, "worktree", "add"];
  if (args.branch !== undefined) {
    assertSafeArg(args.branch, "branch");
    // -B forces re-create if the branch already exists at a different
    // commit. Pilot's worker uses fresh branches per task so this is
    // a safety net (not load-bearing).
    cmd.push("-B", args.branch);
  }
  cmd.push(args.worktreePath, args.commitIsh);

  await execFileP("git", cmd);
}

/**
 * Remove a worktree (the inverse of `gitWorktreeAdd`). `--force` is
 * always passed because pilot worktrees can have uncommitted changes
 * (e.g. when the worker bails mid-task and the pool is cleaning up).
 *
 * If the worktree directory doesn't exist on disk, `git worktree
 * remove` errors. We swallow that specific case because the post-task
 * cleanup path can race with the user `rm -rf`-ing the worktree dir.
 */
export async function gitWorktreeRemove(args: {
  repoPath: string;
  worktreePath: string;
}): Promise<void> {
  assertSafeArg(args.repoPath, "repoPath");
  assertSafeArg(args.worktreePath, "worktreePath");
  try {
    await execFileP("git", [
      "-C",
      args.repoPath,
      "worktree",
      "remove",
      "--force",
      args.worktreePath,
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Tolerate "is not a working tree" (already gone). Anything else is
    // re-thrown.
    if (
      /is not a working tree|worktree.*does not exist/i.test(msg)
    ) {
      return;
    }
    throw err;
  }
}

/**
 * List worktrees registered with the repo. Output of
 * `git worktree list --porcelain` parsed into structured records.
 *
 * Used by `pilot worktrees list` (Phase G6) and the pool's startup
 * reconciliation pass.
 */
export type WorktreeInfo = {
  /** Absolute path on disk. */
  path: string;
  /** Commit SHA the worktree is at. */
  head: string;
  /** Branch name, or null if detached. */
  branch: string | null;
  /** Whether the worktree is "bare" (no checkout). Pilot never creates these. */
  bare: boolean;
};

export async function gitWorktreeList(repoPath: string): Promise<WorktreeInfo[]> {
  assertSafeArg(repoPath, "repoPath");
  const { stdout } = await execFileP("git", [
    "-C",
    repoPath,
    "worktree",
    "list",
    "--porcelain",
  ]);

  const records: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> | null = null;
  // Porcelain format: blank-line-separated records, each with
  // `worktree <path>`, `HEAD <sha>`, `branch <ref>` or `detached` lines.
  for (const line of stdout.split("\n")) {
    if (line.length === 0) {
      if (cur && cur.path) records.push(finalizeWorktreeInfo(cur));
      cur = null;
      continue;
    }
    if (cur === null) cur = {};
    const [keyRaw, ...rest] = line.split(" ");
    const value = rest.join(" ");
    switch (keyRaw) {
      case "worktree":
        cur.path = value;
        break;
      case "HEAD":
        cur.head = value;
        break;
      case "branch":
        // Stripped to bare branch name. `refs/heads/foo` → `foo`.
        cur.branch = value.startsWith("refs/heads/")
          ? value.slice("refs/heads/".length)
          : value;
        break;
      case "detached":
        cur.branch = null;
        break;
      case "bare":
        cur.bare = true;
        break;
      default:
        // Ignore unknown keys (`prunable`, `locked`, etc. for forward-compat).
        break;
    }
  }
  if (cur && cur.path) records.push(finalizeWorktreeInfo(cur));
  return records;
}

function finalizeWorktreeInfo(p: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    path: p.path!,
    head: p.head ?? "",
    branch: p.branch ?? null,
    bare: p.bare ?? false,
  };
}

/**
 * Check out a fresh branch in an existing worktree. Used when the pool
 * is recycling a worktree across tasks: keep the directory, change the
 * branch.
 *
 * Equivalent to `git -C <wt> checkout -B <branch> <base>`. `-B` (capital)
 * resets the branch if it exists.
 */
export async function checkoutFreshBranch(args: {
  worktree: string;
  branch: string;
  base: string;
}): Promise<void> {
  assertSafeArg(args.worktree, "worktree");
  assertSafeArg(args.branch, "branch");
  assertSafeArg(args.base, "base");
  await execFileP("git", [
    "-C",
    args.worktree,
    "checkout",
    "-B",
    args.branch,
    args.base,
  ]);
}

/**
 * Reset the worktree to a clean state: discard all uncommitted changes
 * and untracked files. Used when recycling a worktree for a new task.
 *
 * Equivalent to `git reset --hard && git clean -fdx`. Note `-x` removes
 * .gitignored files too — we want a totally pristine state, including
 * `node_modules` if a previous task installed deps. The worker can
 * re-install at the start of the next task if needed.
 */
export async function cleanWorktree(worktree: string): Promise<void> {
  assertSafeArg(worktree, "worktree");
  await execFileP("git", ["-C", worktree, "reset", "--hard"]);
  await execFileP("git", ["-C", worktree, "clean", "-fdx"]);
}

/**
 * Stage every change and commit with the given message. Used at the
 * end of a successful task to land its work on the branch.
 *
 * `--allow-empty` is intentionally NOT passed: a successful task that
 * produced no diff is suspicious (the agent claimed completion but
 * didn't edit anything). The worker should detect that BEFORE calling
 * commit and decide whether to fail or skip.
 *
 * Returns the new HEAD sha.
 */
export async function commitAll(args: {
  worktree: string;
  message: string;
  authorName?: string;
  authorEmail?: string;
}): Promise<string> {
  assertSafeArg(args.worktree, "worktree");
  if (typeof args.message !== "string" || args.message.length === 0) {
    throw new TypeError("commitAll: message must be non-empty");
  }
  // `git add -A` covers added, modified, deleted, and untracked files.
  await execFileP("git", ["-C", args.worktree, "add", "-A"]);

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (args.authorName) env.GIT_AUTHOR_NAME = args.authorName;
  if (args.authorEmail) env.GIT_AUTHOR_EMAIL = args.authorEmail;
  if (args.authorName) env.GIT_COMMITTER_NAME = args.authorName;
  if (args.authorEmail) env.GIT_COMMITTER_EMAIL = args.authorEmail;

  await execFileP("git", ["-C", args.worktree, "commit", "-m", args.message], {
    env,
  });

  return headSha(args.worktree);
}

/**
 * List file paths that changed in `worktree` since `sinceSha`, including
 * uncommitted work. The output is the union of:
 *
 *   - committed changes since `sinceSha` (`git diff --name-only <sha>..HEAD`)
 *   - staged changes (`git diff --name-only --cached`)
 *   - unstaged changes (`git diff --name-only`)
 *   - untracked files (`git ls-files --others --exclude-standard`)
 *
 * Deduped and sorted. This is the input to `enforceTouches` (Phase C2).
 *
 * NB: deletions ARE included — the file paths returned reflect "files
 * that touched the working state", not "files that currently exist".
 * For `enforceTouches` purposes, deleting an out-of-scope file counts
 * as a violation.
 */
export async function diffNamesSince(
  worktree: string,
  sinceSha: string,
): Promise<string[]> {
  assertSafeArg(worktree, "worktree");
  assertSafeArg(sinceSha, "sinceSha");

  const sets = await Promise.all([
    runDiffNames(worktree, ["diff", "--name-only", `${sinceSha}..HEAD`]),
    runDiffNames(worktree, ["diff", "--name-only", "--cached"]),
    runDiffNames(worktree, ["diff", "--name-only"]),
    runDiffNames(worktree, [
      "ls-files",
      "--others",
      "--exclude-standard",
    ]),
  ]);

  const all = new Set<string>();
  for (const s of sets) for (const p of s) all.add(p);
  return [...all].sort();
}

async function runDiffNames(worktree: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileP("git", ["-C", worktree, ...args]);
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
