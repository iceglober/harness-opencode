// pilot-worktree-pool.test.ts — tests for src/pilot/worktree/pool.ts.
//
// Real-git fixtures (no mocks). Verifies acquire/prepare/release lifecycle,
// preserve-on-failure semantics, the >1 workerCount clamp, and shutdown.

import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { WorktreePool } from "../src/pilot/worktree/pool.js";
import { gitIsAvailable, currentBranch } from "../src/pilot/worktree/git.js";

// --- Fixtures --------------------------------------------------------------

let GIT_OK = false;
beforeAll(async () => {
  GIT_OK = await gitIsAvailable();
});

function mkTmpDir(prefix = "pilot-pool-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rmTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
function gitInit(dir: string): void {
  execFileSync("git", ["init", "-b", "main", "--quiet", dir], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  execFileSync("git", ["-C", dir, "config", "user.email", "t@e.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "T"]);
  execFileSync("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
}
function gitCommitFile(repo: string, name: string, content: string, msg: string): string {
  fs.writeFileSync(path.join(repo, name), content);
  execFileSync("git", ["-C", repo, "add", name]);
  execFileSync("git", ["-C", repo, "commit", "-m", msg, "--quiet"]);
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

// --- acquire / clamping ---------------------------------------------------

describe("WorktreePool — acquire / workerCount clamp", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => rmTmpDir(tmp));

  test("acquire returns slot 0 first", () => {
    const pool = new WorktreePool({
      repoPath: tmp,
      worktreeDir: async (n) => path.join(tmp, "wt", String(n)),
    });
    const s = pool.acquire();
    expect(s.index).toBe(0);
    expect(s.prepared).toBe(false);
  });

  test("acquire twice without release throws (single-worker exhaustion)", () => {
    const pool = new WorktreePool({
      repoPath: tmp,
      worktreeDir: async (n) => path.join(tmp, "wt", String(n)),
    });
    pool.acquire();
    expect(() => pool.acquire()).toThrow(/no free/);
  });

  test("workerCount > 1 is clamped to 1 with stderr warning", () => {
    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      const pool = new WorktreePool({
        repoPath: tmp,
        worktreeDir: async (n) => path.join(tmp, "wt", String(n)),
        workerCount: 4,
      });
      pool.acquire();
      expect(() => pool.acquire()).toThrow(/no free/);
    } finally {
      process.stderr.write = orig;
    }
    expect(captured.join("")).toMatch(/v0\.1.*1/);
  });

  test("release returns the slot to the pool", () => {
    const pool = new WorktreePool({
      repoPath: tmp,
      worktreeDir: async (n) => path.join(tmp, "wt", String(n)),
    });
    const s = pool.acquire();
    pool.release(s);
    const s2 = pool.acquire();
    expect(s2.index).toBe(0);
  });

  test("releasing an unheld slot throws", () => {
    const pool = new WorktreePool({
      repoPath: tmp,
      worktreeDir: async (n) => path.join(tmp, "wt", String(n)),
    });
    const s = pool.acquire();
    pool.release(s);
    expect(() => pool.release(s)).toThrow(/not held/);
  });
});

// --- prepare / reuse ------------------------------------------------------

describe("WorktreePool — prepare / reuse across tasks", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => rmTmpDir(tmp));

  test("first prepare creates the worktree on a fresh branch", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "a.txt", "a", "init");

    const pool = new WorktreePool({
      repoPath: repo,
      worktreeDir: async (n) =>
        path.join(tmp, "wt", `0${n}`),
    });
    const slot = pool.acquire();
    const r = await pool.prepare({
      slot,
      taskId: "T1",
      branchPrefix: "pilot/test",
      base: "main",
    });
    expect(r.branch).toBe("pilot/test/T1");
    expect(r.path).toBe(slot.path);
    expect(fs.existsSync(slot.path)).toBe(true);
    expect(await currentBranch(slot.path)).toBe("pilot/test/T1");
    expect(typeof r.sinceSha).toBe("string");
    expect(r.sinceSha.length).toBe(40);
  });

  test("second prepare on same slot recycles the worktree on a new branch", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "a.txt", "a", "init");

    const pool = new WorktreePool({
      repoPath: repo,
      worktreeDir: async (n) =>
        path.join(tmp, "wt", `0${n}`),
    });
    const slot = pool.acquire();
    await pool.prepare({
      slot,
      taskId: "T1",
      branchPrefix: "pilot/x",
      base: "main",
    });
    pool.release(slot);

    // Simulate the worker leaving uncommitted edits on the worktree.
    fs.writeFileSync(path.join(slot.path, "stray.txt"), "stray\n");

    const slot2 = pool.acquire();
    const r2 = await pool.prepare({
      slot: slot2,
      taskId: "T2",
      branchPrefix: "pilot/x",
      base: "main",
    });
    expect(r2.path).toBe(slot.path); // same on-disk path
    expect(r2.branch).toBe("pilot/x/T2");
    expect(await currentBranch(slot.path)).toBe("pilot/x/T2");
    // cleanWorktree wiped the stray file.
    expect(fs.existsSync(path.join(slot.path, "stray.txt"))).toBe(false);
  });

  test("prepare cleans up a stale worktree dir from a prior crashed run", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "a.txt", "a", "init");

    // Pre-create a stale dir at the path the pool will pick.
    const wtPath = path.join(tmp, "wt", "00");
    fs.mkdirSync(wtPath, { recursive: true });
    fs.writeFileSync(path.join(wtPath, "old.txt"), "stale\n");

    const pool = new WorktreePool({
      repoPath: repo,
      worktreeDir: async () => wtPath,
    });
    const slot = pool.acquire();
    await pool.prepare({
      slot,
      taskId: "T1",
      branchPrefix: "pilot/x",
      base: "main",
    });
    // Stale file should be gone.
    expect(fs.existsSync(path.join(wtPath, "old.txt"))).toBe(false);
    expect(await currentBranch(wtPath)).toBe("pilot/x/T1");
  });
});

// --- preserveOnFailure ----------------------------------------------------

describe("WorktreePool — preserveOnFailure", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => rmTmpDir(tmp));

  test("preserved slots are not reusable", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "a.txt", "a", "init");

    const pool = new WorktreePool({
      repoPath: repo,
      worktreeDir: async (n) => path.join(tmp, "wt", `0${n}`),
    });
    const slot = pool.acquire();
    await pool.prepare({
      slot,
      taskId: "T1",
      branchPrefix: "pilot/x",
      base: "main",
    });

    pool.preserveOnFailure(slot);

    // After preservation, the slot is no longer busy (acquire returns it).
    const slotAgain = pool.acquire();
    expect(slotAgain.index).toBe(0);
    // ...but prepare refuses to reuse it.
    await expect(
      pool.prepare({
        slot: slotAgain,
        taskId: "T2",
        branchPrefix: "pilot/x",
        base: "main",
      }),
    ).rejects.toThrow(/preserved/);
  });

  test("shutdown skips preserved slots by default", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "a.txt", "a", "init");

    const pool = new WorktreePool({
      repoPath: repo,
      worktreeDir: async () => path.join(tmp, "wt", "00"),
    });
    const slot = pool.acquire();
    await pool.prepare({
      slot,
      taskId: "T1",
      branchPrefix: "pilot/x",
      base: "main",
    });
    pool.preserveOnFailure(slot);

    await pool.shutdown(); // default keepPreserved=true
    // Worktree dir should still exist for inspection.
    expect(fs.existsSync(slot.path)).toBe(true);
  });

  test("shutdown({ keepPreserved: false }) tears down preserved slots too", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "a.txt", "a", "init");

    const pool = new WorktreePool({
      repoPath: repo,
      worktreeDir: async () => path.join(tmp, "wt", "00"),
    });
    const slot = pool.acquire();
    await pool.prepare({
      slot,
      taskId: "T1",
      branchPrefix: "pilot/x",
      base: "main",
    });
    pool.preserveOnFailure(slot);

    await pool.shutdown({ keepPreserved: false });
    expect(fs.existsSync(slot.path)).toBe(false);
  });
});

// --- shutdown -------------------------------------------------------------

describe("WorktreePool — shutdown", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => rmTmpDir(tmp));

  test("removes prepared, non-preserved worktrees", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "a.txt", "a", "init");

    const pool = new WorktreePool({
      repoPath: repo,
      worktreeDir: async () => path.join(tmp, "wt", "00"),
    });
    const slot = pool.acquire();
    await pool.prepare({
      slot,
      taskId: "T1",
      branchPrefix: "pilot/x",
      base: "main",
    });
    expect(fs.existsSync(slot.path)).toBe(true);

    pool.release(slot);
    await pool.shutdown();
    expect(fs.existsSync(slot.path)).toBe(false);
  });

  test("inspect shows current slot state", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "a.txt", "a", "init");

    const pool = new WorktreePool({
      repoPath: repo,
      worktreeDir: async () => path.join(tmp, "wt", "00"),
    });
    const slot = pool.acquire();
    expect(pool.inspect()).toHaveLength(1);
    expect(pool.inspect()[0]!.prepared).toBe(false);
    await pool.prepare({
      slot,
      taskId: "T1",
      branchPrefix: "pilot/x",
      base: "main",
    });
    expect(pool.inspect()[0]!.prepared).toBe(true);
  });
});
