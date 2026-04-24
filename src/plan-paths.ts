/**
 * Plan-path helpers — resolve the per-repo plan directory and migrate
 * legacy per-worktree plans into it.
 *
 * Why this module exists:
 * Plans describe work against a codebase, not against a transient worktree.
 * Before this module, the harness wrote every plan to `$WORKTREE/.agent/plans/`,
 * which meant plans disappeared when `/fresh` wiped the worktree and were
 * invisible from any other worktree/tab pointed at the same repo. This
 * module moves plan storage to `~/.glorious/opencode/<repo-folder>/plans/`
 * — a per-repo, worktree-agnostic location that mirrors the storage shape
 * already used by the cost-tracker plugin (see src/plugins/cost-tracker.ts
 * `resolveDataDir`).
 *
 * Exports:
 * - `getRepoFolder(worktreeDir)` — derive the worktree-agnostic repo key.
 * - `getPlanDir(worktreeDir)` — resolve the absolute plans directory,
 *   creating it if missing; honors `$GLORIOUS_PLAN_DIR` override.
 * - `migratePlans(worktreeDir, planDir)` — one-shot move of legacy
 *   `$worktree/.agent/plans/*.md` files into `planDir`; idempotent via
 *   a `.migrated` marker file.
 *
 * These helpers are intentionally free of OpenCode plugin types so they
 * can be called from the CLI (`src/cli.ts plan-dir`) and tests as well as
 * from the autopilot plugin.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// --- Small helpers ---------------------------------------------------------

/**
 * Promisified `execFile` with a timeout. Mirrors the pattern in
 * `src/plugins/autopilot.ts::runCheck` but slimmer — we only need stdout
 * on success and don't care about signal/code on error (the caller
 * decides what "a git failure" means for each helper).
 */
function execFileP(
  file: string,
  args: readonly string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  const { cwd, timeoutMs = 5000 } = opts;
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    execFile(
      file,
      args,
      { signal: controller.signal, cwd, encoding: "utf8" },
      (err, stdout) => {
        clearTimeout(timer);
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout ?? "");
      },
    );
  });
}

/**
 * Tilde-expand a path. Mirrors `src/plugins/cost-tracker.ts::resolveDataDir`:
 * `~` or `~/...` resolves via `os.homedir()`; anything else passes through.
 * Does NOT resolve `~user` (would need `/etc/passwd` lookup) — that's
 * out of scope for our single-user harness.
 */
function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// --- getRepoFolder ---------------------------------------------------------

/**
 * Derive a worktree-agnostic key for the repo containing `worktreeDir`.
 *
 * Returns `path.basename(path.dirname(gitCommonDir))`, where `gitCommonDir`
 * is the output of `git rev-parse --git-common-dir` — the same `.git`
 * directory shared by the main checkout and every linked worktree of a
 * repo. This means:
 *
 *   - `/path/to/my-repo`           → `my-repo`
 *   - `/path/to/my-repo/.git/worktrees/feature` (an actual worktree whose
 *     files live at `~/work/my-repo-feature/`) → also `my-repo`
 *
 * Both resolve to the parent of the main `.git` dir, giving a stable key
 * that's the same from every worktree of the same repo.
 *
 * Rejects if `worktreeDir` isn't inside any git repo (with `git rev-parse`'s
 * own error bubbled up) — callers can decide whether to fall back to a
 * legacy path or fail loudly.
 */
export async function getRepoFolder(worktreeDir: string): Promise<string> {
  let stdout: string;
  try {
    stdout = await execFileP(
      "git",
      ["rev-parse", "--git-common-dir"],
      { cwd: worktreeDir },
    );
  } catch (err) {
    // Normalize the error message so callers don't have to poke at the
    // raw execFile error shape. The most common cause is `worktreeDir`
    // not being inside a git repo.
    const msg =
      err instanceof Error
        ? err.message
        : "unknown error running `git rev-parse --git-common-dir`";
    throw new Error(
      `getRepoFolder: failed to resolve git-common-dir for ${worktreeDir}: ${msg}`,
    );
  }

  const gitCommonDir = stdout.trim();
  if (!gitCommonDir) {
    throw new Error(
      `getRepoFolder: \`git rev-parse --git-common-dir\` returned empty for ${worktreeDir}`,
    );
  }

  // `--git-common-dir` may be relative (`.git`) when cwd IS the main
  // checkout. Resolve to absolute against worktreeDir so we can take a
  // stable parent-dir.
  const absCommonDir = path.isAbsolute(gitCommonDir)
    ? gitCommonDir
    : path.resolve(worktreeDir, gitCommonDir);

  // Parent of `<path>/.git` is the repo root; basename is the repo folder.
  // For a bare repo (`<path>/repo.git`), parent is `<path>` and basename
  // is the parent directory's name — odd but non-empty, which is the
  // contract (the caller asked for a folder key; they get one).
  const repoRoot = path.dirname(absCommonDir);
  return path.basename(repoRoot);
}

// --- getPlanDir ------------------------------------------------------------

/**
 * Resolve the absolute plans directory for the repo containing
 * `worktreeDir`. Shape: `<base>/<repo-folder>/plans`.
 *
 *   - `<base>` = `$GLORIOUS_PLAN_DIR` if set (with leading `~` expanded),
 *     else `~/.glorious/opencode`.
 *   - `<repo-folder>` = `getRepoFolder(worktreeDir)`.
 *
 * Creates the full directory tree if missing (`fs.mkdir recursive`).
 * Idempotent — subsequent calls with the same inputs return the same path
 * without side effects beyond a (no-op) mkdir.
 */
export async function getPlanDir(worktreeDir: string): Promise<string> {
  const override = process.env.GLORIOUS_PLAN_DIR;
  const base = override
    ? expandTilde(override)
    : path.join(os.homedir(), ".glorious", "opencode");

  const repoFolder = await getRepoFolder(worktreeDir);
  const planDir = path.join(base, repoFolder, "plans");

  await fs.mkdir(planDir, { recursive: true });
  return planDir;
}

// --- migratePlans ----------------------------------------------------------

/**
 * One-shot migration of legacy `<worktreeDir>/.agent/plans/*.md` files
 * into `planDir`. Writes a `<worktreeDir>/.agent/plans/.migrated` marker
 * on first run; subsequent calls are no-ops if the marker exists.
 *
 * Collision handling:
 *   - Destination file does NOT exist → move source.
 *   - Destination exists with identical bytes → remove source (no data
 *     loss; migration is complete).
 *   - Destination exists with different bytes → leave source in place,
 *     emit a stderr warning naming the file, and continue migrating
 *     remaining files. The user must resolve the conflict manually.
 *
 * Non-markdown files under `.agent/plans/` are intentionally left alone —
 * this harness only wrote `.md` plans there, and anything else is the
 * user's data.
 */
export async function migratePlans(
  worktreeDir: string,
  planDir: string,
): Promise<void> {
  const oldDir = path.join(worktreeDir, ".agent", "plans");
  const marker = path.join(oldDir, ".migrated");

  // Short-circuit if the source dir doesn't exist or the marker is present.
  try {
    await fs.stat(oldDir);
  } catch {
    // No `.agent/plans/` → nothing to migrate.
    return;
  }
  try {
    await fs.stat(marker);
    // Marker present → migration already ran; skip.
    return;
  } catch {
    // Marker absent → fall through to migration.
  }

  let entries: string[];
  try {
    entries = await fs.readdir(oldDir);
  } catch {
    return;
  }

  // Filter to `.md` files only; ignore dotfiles (including .migrated) and
  // non-markdown artifacts.
  const planFiles = entries.filter(
    (name) => name.endsWith(".md") && !name.startsWith("."),
  );

  // Ensure destination exists — caller usually did this via `getPlanDir`
  // but don't assume.
  await fs.mkdir(planDir, { recursive: true });

  for (const name of planFiles) {
    const src = path.join(oldDir, name);
    const dst = path.join(planDir, name);

    let dstExists = false;
    try {
      await fs.stat(dst);
      dstExists = true;
    } catch {
      dstExists = false;
    }

    if (!dstExists) {
      // Clean move.
      await fs.rename(src, dst);
      continue;
    }

    // Destination already exists — compare bytes.
    const [srcBuf, dstBuf] = await Promise.all([
      fs.readFile(src),
      fs.readFile(dst),
    ]);
    if (srcBuf.equals(dstBuf)) {
      // Identical content — remove source, keep destination.
      await fs.unlink(src);
      continue;
    }

    // True conflict. Preserve source, warn, move on.
    process.stderr.write(
      `[harness-opencode] migratePlans: conflict on ${name} — ` +
        `destination ${dst} exists with different content; ` +
        `leaving source ${src} in place. Resolve manually.\n`,
    );
  }

  // Always write the marker — even if every file was a conflict, we've
  // made the attempt and don't want to re-scan on every CLI call.
  await fs.writeFile(marker, "");
}
