// auto-update — opportunistic two-phase updater for glorious-opencode.
//
// Design (see AGENTS.md and the PR that introduced this file):
//   - Phase A ("prepare"): fires async after plugin init. `git fetch` only —
//     never mutates the checkout, so it can't race against a live session.
//     Records `update_pending: true` + the target SHA in the state file.
//   - Phase B ("apply"): fires inside the `chat.params` hook, which the
//     OpenCode runtime awaits before sending the first message to the LLM.
//     This is the only safe sync barrier — the plugin constructor is not
//     guaranteed to resolve before TUI accepts input. A module-level flag
//     ensures phase B runs exactly once per OpenCode process.
//
// Safety gates skip the update on any of: opt-out env var, non-TTY / CI,
// non-canonical remote (supply-chain guard), git-op-in-progress, non-main,
// dirty tree (tracked files only — state/lock files are gitignored), lock
// contention, 24h rate limit, fetch failure, not-fast-forwardable.
//
// All state writes are atomic (tmp file + rename). The lockfile is a
// simple O_EXCL create with no stale-lock takeover — if a previous process
// died holding the lock, the next session skips once and recovers naturally.
//
// See .agent/plans/auto-update-plugin.md for full design notes.

import type { Plugin } from "@opencode-ai/plugin";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";

// ------------------------- constants -------------------------

// `GLORIOUS_OPENCODE_AUTO_UPDATE_CHECKOUT_ROOT` lets tests point at a scratch
// checkout without installing there. Not a user-facing knob — undocumented
// on purpose; nothing in normal operation should set it.
const CHECKOUT_ROOT =
  process.env.GLORIOUS_OPENCODE_AUTO_UPDATE_CHECKOUT_ROOT ||
  path.join(os.homedir(), ".glorious", "opencode");
const STATE_PATH = path.join(CHECKOUT_ROOT, ".auto-update-state.json");
const LOCK_PATH = path.join(CHECKOUT_ROOT, ".auto-update.lock");
const RATE_LIMIT_SECONDS = 24 * 60 * 60; // once per day
const FETCH_TIMEOUT_MS = 5000;
const INSTALL_TIMEOUT_MS = 120_000; // 2 minutes — installer is normally ~5s
const GIVEUP_DAYS = 7;
const OUTPUT_TAIL_BYTES = 2048;
const KNOWN_SCHEMA = 1;

const CANONICAL_HOST = "github.com";
const CANONICAL_PATH = "iceglober/glorious-opencode";

// ------------------------- types -------------------------

interface State {
  schema: number;
  first_run_announced: boolean;
  last_check_ts: number;
  last_check_ok: boolean;
  last_check_error: string | null;
  last_skip_reason: string | null;
  update_pending: boolean;
  pending_sha: string | null;
  pending_shortlog: string | null;
  pending_prepared_ts: number | null;
  installer_retry_pending: boolean;
  // Set the moment installer_retry_pending flips to true; cleared when it
  // flips back to false. The 7-day giveup ceiling is computed from this
  // timestamp, so a new upstream commit arriving mid-retry-loop does NOT
  // reset the ceiling.
  installer_retry_started_ts: number | null;
  last_applied_sha: string | null;
  last_applied_ts: number | null;
  last_applied_count: number | null;
  last_apply_output_tail: string | null;
  last_apply_ok: boolean | null;
  notification_sent_ts: number | null;
}

function defaultState(): State {
  return {
    schema: KNOWN_SCHEMA,
    first_run_announced: false,
    last_check_ts: 0,
    last_check_ok: false,
    last_check_error: null,
    last_skip_reason: null,
    update_pending: false,
    pending_sha: null,
    pending_shortlog: null,
    pending_prepared_ts: null,
    installer_retry_pending: false,
    installer_retry_started_ts: null,
    last_applied_sha: null,
    last_applied_ts: null,
    last_applied_count: null,
    last_apply_output_tail: null,
    last_apply_ok: null,
    notification_sent_ts: null,
  };
}

// ------------------------- state I/O (atomic) -------------------------

async function loadState(): Promise<State | "schema-future" | null> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    const schema = typeof parsed.schema === "number" ? parsed.schema : 0;
    if (schema > KNOWN_SCHEMA) return "schema-future";
    return { ...defaultState(), ...parsed, schema: KNOWN_SCHEMA };
  } catch (e: any) {
    if (e && e.code === "ENOENT") return null;
    // Malformed JSON, unreadable file, etc. — treat as absent. A future
    // write will produce a valid state file.
    return null;
  }
}

async function saveState(state: State): Promise<void> {
  const tmp = `${STATE_PATH}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  try {
    await fs.rename(tmp, STATE_PATH);
  } catch (e) {
    // If the rename failed (cross-device, permission, etc.), don't leave
    // the tmp file littering the directory. The rename is our atomicity
    // guarantee, so raising the error is correct — the caller's state is
    // simply whatever it was before this call.
    try {
      await fs.unlink(tmp);
    } catch {
      // best-effort cleanup
    }
    throw e;
  }
}

// Merge partial updates onto the current state and persist atomically. If
// loadState returned "schema-future" or null, the caller decides what to do —
// this helper assumes a valid starting state.
async function mutateState(base: State, patch: Partial<State>): Promise<State> {
  const next: State = { ...base, ...patch };
  await saveState(next);
  return next;
}

// ------------------------- lockfile -------------------------

async function acquireLock(): Promise<boolean> {
  try {
    await fs.mkdir(CHECKOUT_ROOT, { recursive: true });
    const fh = await fs.open(LOCK_PATH, "wx");
    await fh.writeFile(String(process.pid));
    await fh.close();
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(): Promise<void> {
  try {
    await fs.unlink(LOCK_PATH);
  } catch {
    // ignore — best-effort
  }
}

// ------------------------- URL allow-list -------------------------

// Parse a git remote URL into { host, path } with NO regex. Handles:
//   https://github.com/iceglober/glorious-opencode[.git][/]
//   https://<user>@github.com/iceglober/glorious-opencode[.git][/]
//   git@github.com:iceglober/glorious-opencode[.git][/]
//   ssh://git@github.com/iceglober/glorious-opencode[.git][/]
//   ssh://git@github.com:22/iceglober/glorious-opencode[.git][/]
//   git+https://..., git+ssh://...
//
// Returns null on any shape we don't recognize — caller treats that as
// "not canonical", which is the safe default.
export function parseRemoteUrl(url: string): { host: string; path: string } | null {
  if (!url || typeof url !== "string") return null;
  let s = url.trim();

  // Strip `git+` prefix (git+https://, git+ssh://).
  if (s.startsWith("git+")) s = s.slice(4);

  // Strip scheme if present.
  let hasScheme = false;
  for (const scheme of ["https://", "http://", "ssh://", "git://"]) {
    if (s.startsWith(scheme)) {
      s = s.slice(scheme.length);
      hasScheme = true;
      break;
    }
  }

  // Strip user@ prefix (only valid in URL/host position, not in a path).
  // SCP-form `git@github.com:foo/bar` — user@ appears before a host, path
  // is after `:`.
  const atIdx = s.indexOf("@");
  const firstSlashBeforeAt = s.indexOf("/");
  if (atIdx > 0 && (firstSlashBeforeAt === -1 || atIdx < firstSlashBeforeAt)) {
    s = s.slice(atIdx + 1);
  }

  // Now split into host and path. If the remaining string contains `:`
  // before any `/`, we're in SCP form (git@github.com:foo/bar). Otherwise
  // it's URL form (github.com/foo/bar or github.com:22/foo/bar).
  let host = "";
  let rest = "";
  const colonIdx = s.indexOf(":");
  const slashIdx = s.indexOf("/");
  if (!hasScheme && colonIdx !== -1 && (slashIdx === -1 || colonIdx < slashIdx)) {
    // SCP form.
    host = s.slice(0, colonIdx);
    rest = s.slice(colonIdx + 1);
  } else if (slashIdx !== -1) {
    host = s.slice(0, slashIdx);
    rest = s.slice(slashIdx + 1);
    // Strip `:port` from host if present.
    const portIdx = host.indexOf(":");
    if (portIdx !== -1) host = host.slice(0, portIdx);
  } else {
    return null;
  }

  if (!host || !rest) return null;

  // Normalize path: strip trailing `/` and `.git`.
  let p = rest;
  while (p.endsWith("/")) p = p.slice(0, -1);
  if (p.endsWith(".git")) p = p.slice(0, -4);
  while (p.endsWith("/")) p = p.slice(0, -1);

  return { host, path: p };
}

function isCanonicalRemote(url: string): boolean {
  const override = process.env.GLORIOUS_OPENCODE_AUTO_UPDATE_REMOTE_ALLOW;
  if (override && override.trim() === url.trim()) return true;
  const parsed = parseRemoteUrl(url);
  if (!parsed) return false;
  return parsed.host === CANONICAL_HOST && parsed.path === CANONICAL_PATH;
}

// ------------------------- shelling out -------------------------

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCmd(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? CHECKOUT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Prevent git from prompting on auth failure; fail fast instead.
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "true",
        SSH_ASKPASS: "true",
      },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on("error", () => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr, timedOut });
    });
  });
}

// ------------------------- safety gates -------------------------

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function gitOpInProgress(): Promise<string | null> {
  const checks: Array<[string, string]> = [
    [".git/rebase-merge", "rebase-merge"],
    [".git/rebase-apply", "rebase-apply"],
    [".git/MERGE_HEAD", "merge"],
    [".git/CHERRY_PICK_HEAD", "cherry-pick"],
    [".git/BISECT_LOG", "bisect"],
  ];
  for (const [rel, name] of checks) {
    if (await fileExists(path.join(CHECKOUT_ROOT, rel))) return name;
  }
  return null;
}

// Returns null if all gates pass, else a skip-reason string. `phase`
// distinguishes A-only gates from phase-B re-checks. Rate-limit is A-only.
async function checkGates(phase: "A" | "B"): Promise<string | null> {
  if (process.env.GLORIOUS_OPENCODE_AUTO_UPDATE === "0") return "opt-out";
  // Undocumented — tests only. Short-circuits every git call so the harness
  // can exercise the gate logic without mutating a real checkout.
  if (process.env.GLORIOUS_OPENCODE_AUTO_UPDATE_TEST_MODE === "1") return "test-mode";
  // Undocumented override for tests — the plugin is invoked from non-TTY
  // harnesses (CI / bun -e piped through bash). Not user-facing.
  if (process.env.GLORIOUS_OPENCODE_AUTO_UPDATE_FORCE_TTY !== "1") {
    if (!process.stdout.isTTY || process.env.CI) return "non-tty";
  }

  if (!(await fileExists(CHECKOUT_ROOT))) return "not-installed-here";
  if (!(await fileExists(path.join(CHECKOUT_ROOT, ".git")))) return "not-installed-here";

  // Remote allow-list.
  const remote = await runCmd("git", ["remote", "get-url", "origin"], { timeoutMs: 2000 });
  if (remote.code !== 0) return "fetch-failed:no-remote";
  const url = remote.stdout.trim();
  if (!isCanonicalRemote(url)) return `remote-not-canonical:${url}`;

  const op = await gitOpInProgress();
  if (op) return `git-op-in-progress:${op}`;

  // Branch check. Detached HEAD is distinct from "on a named branch that
  // isn't main".
  const branch = await runCmd("git", ["symbolic-ref", "--short", "HEAD"], { timeoutMs: 2000 });
  if (branch.code !== 0) return "detached-head";
  const branchName = branch.stdout.trim();
  if (branchName !== "main") return `non-main-branch:${branchName}`;

  // Dirty tree (ignore untracked — state/lock files are untracked on fresh
  // installs until .gitignore catches up).
  const status = await runCmd(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { timeoutMs: 2000 },
  );
  if (status.code === 0 && status.stdout.trim().length > 0) return "dirty-tree";

  return null;
}

// ------------------------- phase A -------------------------

// Cheapest possible opt-out. Bypasses state reads/writes entirely so users
// who set the env var see zero evidence the plugin ran.
function isHardOptOut(): boolean {
  return process.env.GLORIOUS_OPENCODE_AUTO_UPDATE === "0";
}

async function runPhaseA(): Promise<void> {
  if (isHardOptOut()) return;
  const loaded = await loadState();
  if (loaded === "schema-future") {
    // We cannot safely overwrite a newer-schema state file. Bail out loud
    // but non-destructively.
    return;
  }
  const state: State = loaded ?? defaultState();

  const skip = await checkGates("A");
  if (skip) {
    await mutateState(state, {
      last_check_ts: Math.floor(Date.now() / 1000),
      last_check_ok: false,
      last_skip_reason: skip,
    });
    return;
  }

  // Rate limit (A-only).
  const now = Math.floor(Date.now() / 1000);
  if (state.last_check_ts && now - state.last_check_ts < RATE_LIMIT_SECONDS) {
    // Don't even record — we're intentionally quiet on rate-limit hits.
    return;
  }

  if (!(await acquireLock())) {
    await mutateState(state, {
      last_check_ts: now,
      last_check_ok: false,
      last_skip_reason: "lock-held",
    });
    return;
  }

  try {
    const fetchResult = await runCmd(
      "git",
      ["fetch", "--quiet", "origin", "main"],
      { timeoutMs: FETCH_TIMEOUT_MS },
    );
    if (fetchResult.code !== 0) {
      let reason = "network";
      if (fetchResult.timedOut) reason = "timeout";
      else if (/authentication|permission denied/i.test(fetchResult.stderr)) reason = "auth";
      await mutateState(state, {
        last_check_ts: now,
        last_check_ok: false,
        last_skip_reason: `fetch-failed:${reason}`,
        last_check_error: fetchResult.stderr.slice(0, 500) || null,
      });
      return;
    }

    // Compute behind count.
    const behind = await runCmd(
      "git",
      ["rev-list", "--count", "HEAD..origin/main"],
      { timeoutMs: 2000 },
    );
    if (behind.code !== 0) {
      await mutateState(state, {
        last_check_ts: now,
        last_check_ok: false,
        last_skip_reason: "fetch-failed:unknown",
        last_check_error: behind.stderr.slice(0, 500) || null,
      });
      return;
    }
    const count = Number(behind.stdout.trim());

    if (count === 0) {
      await mutateState(state, {
        last_check_ts: now,
        last_check_ok: true,
        last_check_error: null,
        last_skip_reason: null,
      });
      return;
    }

    // Verify fast-forwardable.
    const ancestor = await runCmd(
      "git",
      ["merge-base", "--is-ancestor", "HEAD", "origin/main"],
      { timeoutMs: 2000 },
    );
    if (ancestor.code !== 0) {
      await mutateState(state, {
        last_check_ts: now,
        last_check_ok: true,
        last_skip_reason: "not-fast-forwardable",
      });
      return;
    }

    // Capture pending info.
    const shaOut = await runCmd("git", ["rev-parse", "--short", "origin/main"], { timeoutMs: 2000 });
    const shortlogOut = await runCmd(
      "git",
      ["log", "HEAD..origin/main", "--oneline", "--no-decorate", "-5"],
      { timeoutMs: 2000 },
    );
    await mutateState(state, {
      last_check_ts: now,
      last_check_ok: true,
      last_check_error: null,
      last_skip_reason: null,
      update_pending: true,
      pending_sha: shaOut.stdout.trim() || null,
      pending_shortlog: shortlogOut.stdout.trim() || null,
      pending_prepared_ts: now,
    });
  } finally {
    await releaseLock();
  }
}

// ------------------------- phase B -------------------------

function tail(s: string, bytes: number): string {
  if (s.length <= bytes) return s;
  return "…" + s.slice(s.length - bytes);
}

async function notify(
  client: any,
  title: string,
  message: string,
): Promise<void> {
  // TUI toast.
  try {
    await client.tui.showToast({
      body: { title, message, variant: "info", duration: 8000 },
    });
  } catch {
    // Headless, no-op.
  }
  // OS-level notification (best-effort).
  try {
    if (process.platform === "darwin") {
      const esc = (x: string) => x.replace(/"/g, '\\"');
      await runCmd("osascript", [
        "-e",
        `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`,
      ], { timeoutMs: 2000 });
    } else if (process.platform === "linux") {
      await runCmd("notify-send", [title, message], { timeoutMs: 2000 });
    }
  } catch {
    // ignore
  }
}

async function runPhaseB(client: any): Promise<void> {
  if (isHardOptOut()) return;
  const loaded = await loadState();
  if (loaded === "schema-future" || loaded === null) {
    // schema-future → don't touch. null → nothing pending by definition.
    return;
  }
  const state = loaded;
  if (!state.update_pending && !state.installer_retry_pending) return;

  const now = Math.floor(Date.now() / 1000);

  if (!(await acquireLock())) {
    await mutateState(state, { last_skip_reason: "lock-held" });
    return;
  }

  let merged = false;
  let cur: State = state;
  try {
    const skip = await checkGates("B");
    if (skip) {
      cur = await mutateState(cur, { last_skip_reason: skip });
      return;
    }

    // Merge step.
    if (cur.update_pending) {
      const merge = await runCmd("git", ["merge", "--ff-only", "origin/main"], {
        timeoutMs: 15_000,
      });
      if (merge.code !== 0) {
        cur = await mutateState(cur, {
          update_pending: false,
          last_skip_reason: "apply-failed:merge",
          last_apply_output_tail: tail(merge.stderr || merge.stdout, OUTPUT_TAIL_BYTES),
          last_apply_ok: false,
        });
        await notify(
          client,
          "glorious-opencode: update failed",
          "Merge failed. Run ~/.glorious/opencode/update.sh manually for details.",
        );
        return;
      }
      merged = true;
      cur = await mutateState(cur, {
        update_pending: false,
        last_applied_sha: cur.pending_sha,
      });
    }

    // Install step (runs if we just merged OR we're retrying a prior failure).
    // Tell the user why their first message is briefly stalled — install.sh
    // is usually ~5s, but on a slow network `bun install` can drag up to the
    // 2-minute timeout.
    await notify(
      client,
      "glorious-opencode: applying update…",
      merged ? "Re-linking symlinks and installing plugins." : "Retrying installer…",
    );
    const install = await runCmd("bash", ["install.sh"], {
      cwd: CHECKOUT_ROOT,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    const installOutput = tail(
      (install.stdout + install.stderr).trim(),
      OUTPUT_TAIL_BYTES,
    );

    if (install.code === 0) {
      cur = await mutateState(cur, {
        installer_retry_pending: false,
        installer_retry_started_ts: null,
        last_apply_ok: true,
        last_apply_output_tail: installOutput || null,
        last_applied_ts: now,
        last_applied_count: merged
          ? (cur.pending_shortlog ?? "").split("\n").filter(Boolean).length || null
          : cur.last_applied_count,
      });
    } else {
      // Retry ceiling (7 days). We track the retry window explicitly rather
      // than deriving it from pending_prepared_ts, because phase A overwrites
      // pending_prepared_ts whenever new upstream commits arrive — which
      // would silently reset the ceiling if we reused that field.
      const retryStartedTs = cur.installer_retry_started_ts ?? now;
      const retriedDays = (now - retryStartedTs) / 86400;
      if (retriedDays > GIVEUP_DAYS) {
        cur = await mutateState(cur, {
          installer_retry_pending: false,
          installer_retry_started_ts: null,
          last_apply_ok: false,
          last_apply_output_tail: installOutput || null,
        });
        await notify(
          client,
          "glorious-opencode: auto-update giving up",
          `Install failed ${GIVEUP_DAYS} days running. Run ~/.glorious/opencode/update.sh manually.`,
        );
        return;
      }
      cur = await mutateState(cur, {
        installer_retry_pending: true,
        installer_retry_started_ts: retryStartedTs,
        last_apply_ok: false,
        last_apply_output_tail: installOutput || null,
      });
      await notify(
        client,
        "glorious-opencode: install failed, will retry",
        "Run was merged but installer exited non-zero. Will retry next session.",
      );
      return;
    }

    // Success notification.
    const count = cur.last_applied_count ?? 0;
    const lines = (cur.pending_shortlog ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => "• " + l)
      .slice(0, 5)
      .join("\n");
    const title = count > 0
      ? `glorious-opencode updated (${count} commit${count === 1 ? "" : "s"})`
      : "glorious-opencode: install recovery succeeded";
    const message = lines || "Re-linked symlinks; no new commits.";
    await notify(client, title, message);
    cur = await mutateState(cur, {
      notification_sent_ts: now,
      pending_sha: null,
      pending_shortlog: null,
      pending_prepared_ts: null,
    });

    // First-run announcement (one-time).
    if (!cur.first_run_announced) {
      await notify(
        client,
        "glorious-opencode now auto-updates",
        "Disable with: export GLORIOUS_OPENCODE_AUTO_UPDATE=0\nSee docs/installation.md#auto-update",
      );
      cur = await mutateState(cur, { first_run_announced: true });
    }
  } catch (e: any) {
    await mutateState(cur, {
      last_skip_reason: "apply-failed:exception",
      last_check_error: String(e?.message ?? e).slice(0, 500),
    });
  } finally {
    await releaseLock();
  }
}

// ------------------------- plugin entry -------------------------

let hasRunPhaseB = false;

const plugin: Plugin = async ({ client }) => {
  // Dispatch phase A in the background; never await. Uncaught errors get
  // swallowed into the state file so they can't crash OpenCode.
  (async () => {
    try {
      await runPhaseA();
    } catch (e: any) {
      try {
        const loaded = await loadState();
        if (loaded && loaded !== "schema-future") {
          await mutateState(loaded, {
            last_skip_reason: "uncaught:phase-a",
            last_check_error: String(e?.message ?? e).slice(0, 500),
          });
        }
      } catch {
        // give up quietly
      }
    }
  })();

  return {
    "chat.params": async () => {
      if (hasRunPhaseB) return;
      hasRunPhaseB = true;
      try {
        await runPhaseB(client);
      } catch {
        // already logged inside runPhaseB; swallow here to avoid blocking
        // the user's message.
      }
    },
  };
};

export default plugin;
