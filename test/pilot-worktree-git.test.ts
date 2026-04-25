// pilot-worktree-git.test.ts — tests for src/pilot/worktree/git.ts.
//
// Uses real git (no mocking). Creates a tmp repo per test, optionally
// with worktrees. Skips entirely if `git` is not on PATH.
//
// Coverage targets (Phase C1 of PILOT_TODO.md):
//   - gitWorktreeAdd / gitWorktreeRemove / gitWorktreeList
//   - checkoutFreshBranch
//   - cleanWorktree
//   - commitAll
//   - currentBranch
//   - headSha
//   - diffNamesSince (committed + staged + unstaged + untracked)

import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  gitIsAvailable,
  gitWorktreeAdd,
  gitWorktreeRemove,
  gitWorktreeList,
  checkoutFreshBranch,
  cleanWorktree,
  commitAll,
  currentBranch,
  headSha,
  diffNamesSince,
} from "../src/pilot/worktree/git.js";

// --- Fixtures --------------------------------------------------------------

let GIT_OK = false;
beforeAll(async () => {
  GIT_OK = await gitIsAvailable();
});

function mkTmpDir(prefix = "pilot-wt-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rmTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-b", "main", "--quiet", dir], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
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

// Skipper: each `test` consults GIT_OK; if false, we still run but
// expect the global gate to handle it. Bun:test doesn't have describe.skipIf
// universally; we early-return inside each test as needed.
function skipIfNoGit(): boolean {
  if (!GIT_OK) {
    console.warn("[pilot-worktree-git] git not on PATH — skipping");
    return true;
  }
  return false;
}

// --- gitIsAvailable --------------------------------------------------------

describe("gitIsAvailable", () => {
  test("returns true when git is on PATH", async () => {
    const ok = await gitIsAvailable();
    expect(typeof ok).toBe("boolean");
    // We don't assert true/false because tests must be runnable on a
    // git-less host (CI sometimes is). Just verify it returns a bool
    // without throwing.
  });
});

// --- headSha + currentBranch -----------------------------------------------

describe("headSha + currentBranch", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => rmTmpDir(tmp));

  test("headSha returns the commit sha", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    const sha = gitCommitFile(repo, "a.txt", "a\n", "init");
    expect(await headSha(repo)).toBe(sha);
  });

  test("currentBranch returns the branch name", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "a.txt", "a", "init");
    expect(await currentBranch(repo)).toBe("main");
  });

  test("currentBranch returns empty string on detached HEAD", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    const sha = gitCommitFile(repo, "a.txt", "a", "init");
    execFileSync("git", ["-C", repo, "checkout", "--detach", sha, "--quiet"]);
    expect(await currentBranch(repo)).toBe("");
  });
});

// --- gitWorktreeAdd / Remove / List ----------------------------------------

describe("gitWorktreeAdd + gitWorktreeRemove + gitWorktreeList", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => rmTmpDir(tmp));

  test("gitWorktreeAdd creates a checkout at the specified path on a fresh branch", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "main.txt", "main\n", "init");

    const wt = path.join(tmp, "wt-1");
    await gitWorktreeAdd({
      repoPath: repo,
      worktreePath: wt,
      commitIsh: "main",
      branch: "pilot/test/T1",
    });
    expect(fs.existsSync(path.join(wt, "main.txt"))).toBe(true);
    expect(await currentBranch(wt)).toBe("pilot/test/T1");
  });

  test("gitWorktreeAdd without `branch` checks out the commitIsh directly (detached)", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    const sha = gitCommitFile(repo, "main.txt", "x", "init");
    const wt = path.join(tmp, "wt-detached");
    await gitWorktreeAdd({
      repoPath: repo,
      worktreePath: wt,
      commitIsh: sha,
    });
    expect(await headSha(wt)).toBe(sha);
  });

  test("gitWorktreeList returns added worktrees", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "a.txt", "a", "init");

    const wt1 = path.join(tmp, "wt-list-1");
    const wt2 = path.join(tmp, "wt-list-2");
    await gitWorktreeAdd({
      repoPath: repo,
      worktreePath: wt1,
      commitIsh: "main",
      branch: "feat/a",
    });
    await gitWorktreeAdd({
      repoPath: repo,
      worktreePath: wt2,
      commitIsh: "main",
      branch: "feat/b",
    });

    const list = await gitWorktreeList(repo);
    const branches = new Set(list.map((w) => w.branch));
    expect(branches.has("main")).toBe(true);
    expect(branches.has("feat/a")).toBe(true);
    expect(branches.has("feat/b")).toBe(true);
  });

  test("gitWorktreeRemove deletes the worktree", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "a.txt", "a", "init");
    const wt = path.join(tmp, "wt-rm");
    await gitWorktreeAdd({
      repoPath: repo,
      worktreePath: wt,
      commitIsh: "main",
      branch: "rm-me",
    });
    await gitWorktreeRemove({ repoPath: repo, worktreePath: wt });
    expect(fs.existsSync(wt)).toBe(false);
    const list = await gitWorktreeList(repo);
    expect(list.find((w) => w.path === wt)).toBeUndefined();
  });

  test("gitWorktreeRemove tolerates an already-deleted worktree dir", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "a.txt", "a", "init");
    const wt = path.join(tmp, "wt-pre-deleted");
    await gitWorktreeAdd({
      repoPath: repo,
      worktreePath: wt,
      commitIsh: "main",
      branch: "ghosty",
    });
    // User rm -rf's the worktree dir; we then call remove.
    fs.rmSync(wt, { recursive: true, force: true });
    // First call to remove succeeds and prunes registry.
    await gitWorktreeRemove({ repoPath: repo, worktreePath: wt });
    // Second call should also be tolerated (idempotent).
    await gitWorktreeRemove({ repoPath: repo, worktreePath: wt });
  });
});

// --- checkoutFreshBranch ---------------------------------------------------

describe("checkoutFreshBranch", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => rmTmpDir(tmp));

  test("creates a new branch in an existing worktree", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "a.txt", "a", "init");
    const wt = path.join(tmp, "wt");
    await gitWorktreeAdd({
      repoPath: repo,
      worktreePath: wt,
      commitIsh: "main",
      branch: "first",
    });
    await checkoutFreshBranch({ worktree: wt, branch: "second", base: "main" });
    expect(await currentBranch(wt)).toBe("second");
  });

  test("resets the branch ref if it already exists", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    const sha1 = gitCommitFile(repo, "a.txt", "1", "first");
    gitCommitFile(repo, "b.txt", "2", "second");
    const wt = path.join(tmp, "wt");
    await gitWorktreeAdd({
      repoPath: repo,
      worktreePath: wt,
      commitIsh: "main",
      branch: "feat",
    });
    // Reset feat to point at sha1 (the older commit).
    await checkoutFreshBranch({ worktree: wt, branch: "feat", base: sha1 });
    expect(await headSha(wt)).toBe(sha1);
  });
});

// --- cleanWorktree ---------------------------------------------------------

describe("cleanWorktree", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => rmTmpDir(tmp));

  test("discards uncommitted edits and untracked files", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "a.txt", "original\n", "init");
    const wt = path.join(tmp, "wt");
    await gitWorktreeAdd({
      repoPath: repo,
      worktreePath: wt,
      commitIsh: "main",
      branch: "x",
    });
    fs.writeFileSync(path.join(wt, "a.txt"), "modified\n");
    fs.writeFileSync(path.join(wt, "untracked.txt"), "x\n");
    fs.mkdirSync(path.join(wt, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(wt, "node_modules", "fake.json"), "{}");

    await cleanWorktree(wt);

    expect(fs.readFileSync(path.join(wt, "a.txt"), "utf8")).toBe("original\n");
    expect(fs.existsSync(path.join(wt, "untracked.txt"))).toBe(false);
    expect(fs.existsSync(path.join(wt, "node_modules"))).toBe(false);
  });
});

// --- commitAll -------------------------------------------------------------

describe("commitAll", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => rmTmpDir(tmp));

  test("stages all changes and commits with the given message", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "a.txt", "a", "init");
    const wt = path.join(tmp, "wt");
    await gitWorktreeAdd({
      repoPath: repo,
      worktreePath: wt,
      commitIsh: "main",
      branch: "feat",
    });
    fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
    fs.writeFileSync(path.join(wt, "c.txt"), "c\n");
    const sha = await commitAll({
      worktree: wt,
      message: "T1: add things",
      authorName: "Pilot",
      authorEmail: "pilot@example.com",
    });
    expect(typeof sha).toBe("string");
    expect(sha.length).toBe(40);
    // Verify the commit content.
    const log = execFileSync(
      "git",
      ["-C", wt, "log", "-1", "--pretty=%B"],
      { encoding: "utf8" },
    ).trim();
    expect(log).toBe("T1: add things");
    const author = execFileSync(
      "git",
      ["-C", wt, "log", "-1", "--pretty=%an <%ae>"],
      { encoding: "utf8" },
    ).trim();
    expect(author).toBe("Pilot <pilot@example.com>");
  });

  test("rejects empty message", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "a.txt", "a", "init");
    await expect(
      commitAll({ worktree: repo, message: "" }),
    ).rejects.toThrow(/non-empty/);
  });

  test("fails (no --allow-empty) when there are no changes", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    gitCommitFile(repo, "a.txt", "a", "init");
    const wt = path.join(tmp, "wt");
    await gitWorktreeAdd({
      repoPath: repo,
      worktreePath: wt,
      commitIsh: "main",
      branch: "empty",
    });
    await expect(
      commitAll({ worktree: wt, message: "no changes" }),
    ).rejects.toThrow();
  });
});

// --- diffNamesSince --------------------------------------------------------

describe("diffNamesSince", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => rmTmpDir(tmp));

  test("captures committed changes since sinceSha", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    const since = gitCommitFile(repo, "a.txt", "a", "init");
    gitCommitFile(repo, "b.txt", "b", "add b");
    gitCommitFile(repo, "c.txt", "c", "add c");
    const names = await diffNamesSince(repo, since);
    expect(names).toContain("b.txt");
    expect(names).toContain("c.txt");
    // a.txt was at `since`; only files changed AFTER it appear.
    expect(names).not.toContain("a.txt");
  });

  test("captures unstaged uncommitted edits", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    const sha = gitCommitFile(repo, "a.txt", "a", "init");
    fs.writeFileSync(path.join(repo, "a.txt"), "modified");
    const names = await diffNamesSince(repo, sha);
    expect(names).toContain("a.txt");
  });

  test("captures staged uncommitted changes", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    const sha = gitCommitFile(repo, "a.txt", "a", "init");
    fs.writeFileSync(path.join(repo, "staged.txt"), "x");
    execFileSync("git", ["-C", repo, "add", "staged.txt"]);
    const names = await diffNamesSince(repo, sha);
    expect(names).toContain("staged.txt");
  });

  test("captures untracked files (respecting .gitignore)", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
    const sha = gitCommitFile(repo, ".gitignore", "ignored.txt\n", "init");
    fs.writeFileSync(path.join(repo, "untracked.txt"), "x");
    fs.writeFileSync(path.join(repo, "ignored.txt"), "y");
    const names = await diffNamesSince(repo, sha);
    expect(names).toContain("untracked.txt");
    expect(names).not.toContain("ignored.txt");
  });

  test("returns deduped + sorted names", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    const sha = gitCommitFile(repo, "a.txt", "a", "init");
    // Modify file AND add a new untracked file.
    fs.writeFileSync(path.join(repo, "a.txt"), "modified");
    fs.writeFileSync(path.join(repo, "z.txt"), "z");
    const names = await diffNamesSince(repo, sha);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  test("returns empty list when nothing has changed", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    const sha = gitCommitFile(repo, "a.txt", "a", "init");
    expect(await diffNamesSince(repo, sha)).toEqual([]);
  });
});

// --- input validation ------------------------------------------------------

describe("input validation (assertSafeArg)", () => {
  test("rejects empty string args", async () => {
    await expect(headSha("")).rejects.toThrow(/non-empty/);
    await expect(currentBranch("")).rejects.toThrow(/non-empty/);
  });

  test("rejects null-byte-containing args", async () => {
    await expect(headSha("with\0nul")).rejects.toThrow(/null/);
  });
});

// --- integration: prepare-task lifecycle (smoke) ---------------------------

describe("integration: per-task worktree lifecycle", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => rmTmpDir(tmp));

  test("add → edit → diff → clean → re-checkout → diff", async () => {
    if (skipIfNoGit()) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    const baseline = gitCommitFile(repo, "a.txt", "a", "init");

    const wt = path.join(tmp, "wt");
    await gitWorktreeAdd({
      repoPath: repo,
      worktreePath: wt,
      commitIsh: "main",
      branch: "task-1",
    });

    // Agent edits files
    fs.writeFileSync(path.join(wt, "a.txt"), "modified");
    fs.writeFileSync(path.join(wt, "new.txt"), "x");
    let diff = await diffNamesSince(wt, baseline);
    expect(diff).toContain("a.txt");
    expect(diff).toContain("new.txt");

    // Worker recycles for next task
    await cleanWorktree(wt);
    await checkoutFreshBranch({ worktree: wt, branch: "task-2", base: "main" });
    diff = await diffNamesSince(wt, baseline);
    expect(diff).toEqual([]);
  });
});

// Eliminate "spawnSync unused" lint by using it in a (currently-empty)
// reservation for a future test of a fork-bomb-style git arg. Remove
// when actually used.
void spawnSync;
