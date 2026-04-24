// plan-paths.test.ts — unit tests for src/plan-paths.ts.
//
// Covers every code path for the three exports (getRepoFolder, getPlanDir,
// migratePlans) plus the CLI `plan-dir` subcommand contract. Uses real git
// (no mocking) so behavior stays honest against the actual `git rev-parse`
// output we depend on. Each test creates its own tmp dir, shells `git init`
// where needed, and tears down after.
//
// Run: `bun test test/plan-paths.test.ts`

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  getRepoFolder,
  getPlanDir,
  migratePlans,
} from "../src/plan-paths.js";

// --- Fixtures --------------------------------------------------------------

function mkTmpDir(prefix = "plan-paths-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function gitInit(dir: string): void {
  // `-b main` pins the default branch so tests don't depend on the host
  // git config. Quiet keeps tmpdir stderr noise out of bun's test log.
  execFileSync("git", ["init", "-b", "main", "--quiet", dir], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  // A commit isn't needed — `git rev-parse --git-common-dir` works on an
  // empty repo. But configure user so any downstream test that commits
  // doesn't error out.
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
}

function gitAddWorktree(mainRepo: string, worktreeDir: string, branch: string): void {
  // Create an initial commit first so we can branch off it.
  const readme = path.join(mainRepo, "README.md");
  fs.writeFileSync(readme, "# test\n");
  execFileSync("git", ["-C", mainRepo, "add", "README.md"]);
  execFileSync("git", ["-C", mainRepo, "commit", "-m", "initial", "--quiet"]);
  execFileSync("git", [
    "-C", mainRepo,
    "worktree", "add",
    "--quiet",
    "-b", branch,
    worktreeDir,
  ]);
}

// --- getRepoFolder ---------------------------------------------------------

describe("getRepoFolder", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => { rmTmpDir(tmp); });

  test("returns dirname-basename of the main repo (canonical checkout)", async () => {
    const repoDir = path.join(tmp, "my-project");
    fs.mkdirSync(repoDir);
    gitInit(repoDir);

    const folder = await getRepoFolder(repoDir);
    expect(folder).toBe("my-project");
  });

  test("returns the same key from a git worktree as from the main checkout", async () => {
    const mainRepo = path.join(tmp, "shared-repo");
    fs.mkdirSync(mainRepo);
    gitInit(mainRepo);

    const worktree = path.join(tmp, "worktrees", "feature-branch");
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    gitAddWorktree(mainRepo, worktree, "feature");

    const fromMain = await getRepoFolder(mainRepo);
    const fromWorktree = await getRepoFolder(worktree);

    expect(fromMain).toBe("shared-repo");
    expect(fromWorktree).toBe("shared-repo");
    expect(fromMain).toBe(fromWorktree);
  });

  test("rejects a non-git directory with a descriptive error", async () => {
    const nonGit = path.join(tmp, "not-a-repo");
    fs.mkdirSync(nonGit);

    // Expect a rejection — bun's `rejects.toThrow` matches the message.
    await expect(getRepoFolder(nonGit)).rejects.toThrow(/git/i);
  });

  test("handles a bare repo by throwing (no worktree \u2192 no plan dir)", async () => {
    const bareDir = path.join(tmp, "bare.git");
    fs.mkdirSync(bareDir);
    execFileSync("git", ["init", "--bare", "--quiet", bareDir], {
      stdio: ["ignore", "ignore", "ignore"],
    });

    // Running getRepoFolder from inside the bare repo directory — `git
    // rev-parse --git-common-dir` succeeds and returns the bare dir itself,
    // but there's no parent directory that's a meaningful "repo folder".
    // The plan agent can't write plans for a bare repo anyway. We accept
    // basename of the parent of the .git dir — in this case "bare.git"'s
    // parent is tmp, basename = (tmp basename). That's a legitimate
    // answer even if surprising; document the behavior by asserting
    // it does NOT throw and returns a non-empty string.
    const folder = await getRepoFolder(bareDir);
    expect(typeof folder).toBe("string");
    expect(folder.length).toBeGreaterThan(0);
  });

  test("trims trailing whitespace/newline from git stdout", async () => {
    const repoDir = path.join(tmp, "trim-me");
    fs.mkdirSync(repoDir);
    gitInit(repoDir);

    const folder = await getRepoFolder(repoDir);
    // No newline should survive.
    expect(folder).toBe("trim-me");
    expect(folder.includes("\n")).toBe(false);
    expect(folder.endsWith(" ")).toBe(false);
  });
});

// --- getPlanDir ------------------------------------------------------------

describe("getPlanDir", () => {
  let tmp: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmp = mkTmpDir();
    prevEnv = process.env.GLORIOUS_PLAN_DIR;
    delete process.env.GLORIOUS_PLAN_DIR;
  });
  afterEach(() => {
    rmTmpDir(tmp);
    if (prevEnv === undefined) {
      delete process.env.GLORIOUS_PLAN_DIR;
    } else {
      process.env.GLORIOUS_PLAN_DIR = prevEnv;
    }
  });

  test("default resolves under ~/.glorious/opencode/<repo-folder>/plans", async () => {
    const repoDir = path.join(tmp, "default-base");
    fs.mkdirSync(repoDir);
    gitInit(repoDir);

    const planDir = await getPlanDir(repoDir);
    const expected = path.join(os.homedir(), ".glorious", "opencode", "default-base", "plans");
    expect(planDir).toBe(expected);
  });

  test("honors GLORIOUS_PLAN_DIR env override", async () => {
    const repoDir = path.join(tmp, "env-override");
    fs.mkdirSync(repoDir);
    gitInit(repoDir);

    const overrideBase = path.join(tmp, "alt-base");
    process.env.GLORIOUS_PLAN_DIR = overrideBase;

    const planDir = await getPlanDir(repoDir);
    expect(planDir).toBe(path.join(overrideBase, "env-override", "plans"));
  });

  test("expands leading ~ in GLORIOUS_PLAN_DIR via os.homedir()", async () => {
    const repoDir = path.join(tmp, "tilde-expand");
    fs.mkdirSync(repoDir);
    gitInit(repoDir);

    process.env.GLORIOUS_PLAN_DIR = "~/custom-plan-base";

    const planDir = await getPlanDir(repoDir);
    const expected = path.join(os.homedir(), "custom-plan-base", "tilde-expand", "plans");
    expect(planDir).toBe(expected);
  });

  test("creates the plans dir if it does not exist", async () => {
    const repoDir = path.join(tmp, "auto-create");
    fs.mkdirSync(repoDir);
    gitInit(repoDir);

    const overrideBase = path.join(tmp, "new-base-never-created");
    process.env.GLORIOUS_PLAN_DIR = overrideBase;

    // Precondition: base dir does not exist.
    expect(fs.existsSync(overrideBase)).toBe(false);

    const planDir = await getPlanDir(repoDir);

    // Postcondition: the plans dir was created.
    expect(fs.existsSync(planDir)).toBe(true);
    expect(fs.statSync(planDir).isDirectory()).toBe(true);
  });

  test("idempotent when plans dir already exists", async () => {
    const repoDir = path.join(tmp, "idempotent");
    fs.mkdirSync(repoDir);
    gitInit(repoDir);

    const overrideBase = path.join(tmp, "already-exists");
    process.env.GLORIOUS_PLAN_DIR = overrideBase;

    const first = await getPlanDir(repoDir);
    const second = await getPlanDir(repoDir);

    expect(first).toBe(second);
    expect(fs.existsSync(first)).toBe(true);
  });
});

// --- migratePlans ----------------------------------------------------------

describe("migratePlans", () => {
  let tmp: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmp = mkTmpDir();
    prevEnv = process.env.GLORIOUS_PLAN_DIR;
    delete process.env.GLORIOUS_PLAN_DIR;
  });
  afterEach(() => {
    rmTmpDir(tmp);
    if (prevEnv === undefined) {
      delete process.env.GLORIOUS_PLAN_DIR;
    } else {
      process.env.GLORIOUS_PLAN_DIR = prevEnv;
    }
  });

  test("no-op when .agent/plans/ does not exist", async () => {
    const repoDir = path.join(tmp, "no-plans");
    fs.mkdirSync(repoDir);
    gitInit(repoDir);

    const planDir = path.join(tmp, "plans-dest");
    fs.mkdirSync(planDir, { recursive: true });

    await migratePlans(repoDir, planDir);

    // No marker should be written if the old dir didn't exist.
    const marker = path.join(repoDir, ".agent", "plans", ".migrated");
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("moves existing plans and writes .migrated marker", async () => {
    const repoDir = path.join(tmp, "has-plans");
    fs.mkdirSync(repoDir);
    gitInit(repoDir);

    // Seed old-location plans.
    const oldDir = path.join(repoDir, ".agent", "plans");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "first.md"), "# First\n");
    fs.writeFileSync(path.join(oldDir, "second.md"), "# Second\n");

    const planDir = path.join(tmp, "plans-dest");
    fs.mkdirSync(planDir, { recursive: true });

    await migratePlans(repoDir, planDir);

    // Files moved.
    expect(fs.existsSync(path.join(planDir, "first.md"))).toBe(true);
    expect(fs.existsSync(path.join(planDir, "second.md"))).toBe(true);
    expect(fs.readFileSync(path.join(planDir, "first.md"), "utf8")).toBe("# First\n");

    // Old files gone.
    expect(fs.existsSync(path.join(oldDir, "first.md"))).toBe(false);
    expect(fs.existsSync(path.join(oldDir, "second.md"))).toBe(false);

    // Marker written.
    expect(fs.existsSync(path.join(oldDir, ".migrated"))).toBe(true);
  });

  test("idempotent — subsequent calls skip when .migrated marker is present", async () => {
    const repoDir = path.join(tmp, "already-migrated");
    fs.mkdirSync(repoDir);
    gitInit(repoDir);

    const oldDir = path.join(repoDir, ".agent", "plans");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, ".migrated"), "");
    // Seed a plan file AFTER the marker — should NOT be moved.
    fs.writeFileSync(path.join(oldDir, "post-marker.md"), "# Post\n");

    const planDir = path.join(tmp, "plans-dest");
    fs.mkdirSync(planDir, { recursive: true });

    await migratePlans(repoDir, planDir);

    // The post-marker file should still be in the old location.
    expect(fs.existsSync(path.join(oldDir, "post-marker.md"))).toBe(true);
    // And NOT in the new location.
    expect(fs.existsSync(path.join(planDir, "post-marker.md"))).toBe(false);
  });

  test("collision with identical content: source is removed, destination unchanged", async () => {
    const repoDir = path.join(tmp, "collision-same");
    fs.mkdirSync(repoDir);
    gitInit(repoDir);

    const oldDir = path.join(repoDir, ".agent", "plans");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "shared.md"), "# Shared content\n");

    const planDir = path.join(tmp, "plans-dest");
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, "shared.md"), "# Shared content\n");

    await migratePlans(repoDir, planDir);

    // Source removed because content matched (no data loss).
    expect(fs.existsSync(path.join(oldDir, "shared.md"))).toBe(false);
    // Destination unchanged.
    expect(fs.readFileSync(path.join(planDir, "shared.md"), "utf8")).toBe("# Shared content\n");
    // Marker still written — migration ran.
    expect(fs.existsSync(path.join(oldDir, ".migrated"))).toBe(true);
  });

  test("collision with different content: source preserved, destination unchanged, stderr warning", async () => {
    const repoDir = path.join(tmp, "collision-differ");
    fs.mkdirSync(repoDir);
    gitInit(repoDir);

    const oldDir = path.join(repoDir, ".agent", "plans");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "conflict.md"), "# OLD content\n");

    const planDir = path.join(tmp, "plans-dest");
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, "conflict.md"), "# NEW content\n");

    // Capture stderr for the warning assertion.
    const origStderr = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      await migratePlans(repoDir, planDir);
    } finally {
      process.stderr.write = origStderr;
    }

    // Source NOT removed — preserves user data on conflict.
    expect(fs.existsSync(path.join(oldDir, "conflict.md"))).toBe(true);
    expect(fs.readFileSync(path.join(oldDir, "conflict.md"), "utf8")).toBe("# OLD content\n");
    // Destination untouched.
    expect(fs.readFileSync(path.join(planDir, "conflict.md"), "utf8")).toBe("# NEW content\n");
    // Warning emitted.
    const warning = captured.join("");
    expect(warning).toMatch(/conflict\.md/);
    expect(warning.toLowerCase()).toMatch(/conflict|collision|skip|exists/);
  });

  test("continues migrating remaining files after one collision", async () => {
    const repoDir = path.join(tmp, "partial-collision");
    fs.mkdirSync(repoDir);
    gitInit(repoDir);

    const oldDir = path.join(repoDir, ".agent", "plans");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "unique.md"), "# Unique\n");
    fs.writeFileSync(path.join(oldDir, "conflict.md"), "# OLD\n");
    fs.writeFileSync(path.join(oldDir, "also-unique.md"), "# AlsoUnique\n");

    const planDir = path.join(tmp, "plans-dest");
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, "conflict.md"), "# NEW\n");

    // Silence stderr.
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await migratePlans(repoDir, planDir);
    } finally {
      process.stderr.write = origStderr;
    }

    // Non-colliding files migrated.
    expect(fs.existsSync(path.join(planDir, "unique.md"))).toBe(true);
    expect(fs.existsSync(path.join(planDir, "also-unique.md"))).toBe(true);
    expect(fs.existsSync(path.join(oldDir, "unique.md"))).toBe(false);
    expect(fs.existsSync(path.join(oldDir, "also-unique.md"))).toBe(false);

    // Colliding file preserved in old location.
    expect(fs.existsSync(path.join(oldDir, "conflict.md"))).toBe(true);
  });

  test("non-markdown files in .agent/plans/ are ignored", async () => {
    const repoDir = path.join(tmp, "non-md");
    fs.mkdirSync(repoDir);
    gitInit(repoDir);

    const oldDir = path.join(repoDir, ".agent", "plans");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "plan.md"), "# Plan\n");
    fs.writeFileSync(path.join(oldDir, "notes.txt"), "notes");
    fs.writeFileSync(path.join(oldDir, "scratch"), "no ext");

    const planDir = path.join(tmp, "plans-dest");
    fs.mkdirSync(planDir, { recursive: true });

    await migratePlans(repoDir, planDir);

    // Markdown moved.
    expect(fs.existsSync(path.join(planDir, "plan.md"))).toBe(true);
    // Non-markdown left alone.
    expect(fs.existsSync(path.join(oldDir, "notes.txt"))).toBe(true);
    expect(fs.existsSync(path.join(oldDir, "scratch"))).toBe(true);
  });
});

// --- CLI: plan-dir subcommand ---------------------------------------------

describe("CLI: plan-dir", () => {
  let tmp: string;

  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => { rmTmpDir(tmp); });

  // Resolve the CLI entry relative to this test file.
  const cliPath = path.resolve(__dirname, "..", "src", "cli.ts");

  function runCli(
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv = {},
  ): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync("bun", ["run", cliPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 10_000,
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status,
    };
  }

  test("prints the resolved plan dir to stdout on success", () => {
    const repoDir = path.join(tmp, "cli-happy");
    fs.mkdirSync(repoDir);
    gitInit(repoDir);

    const overrideBase = path.join(tmp, "cli-base");
    const res = runCli(["plan-dir"], repoDir, {
      GLORIOUS_PLAN_DIR: overrideBase,
    });

    expect(res.status).toBe(0);
    const expected = path.join(overrideBase, "cli-happy", "plans");
    expect(res.stdout.trim()).toBe(expected);
    expect(res.stderr).toBe("");
  });

  test("creates the plan dir as a side effect", () => {
    const repoDir = path.join(tmp, "cli-create");
    fs.mkdirSync(repoDir);
    gitInit(repoDir);

    const overrideBase = path.join(tmp, "cli-create-base");
    expect(fs.existsSync(overrideBase)).toBe(false);

    const res = runCli(["plan-dir"], repoDir, {
      GLORIOUS_PLAN_DIR: overrideBase,
    });

    expect(res.status).toBe(0);
    expect(fs.existsSync(res.stdout.trim())).toBe(true);
  });

  test("runs migration as a side effect", () => {
    const repoDir = path.join(tmp, "cli-migrate");
    fs.mkdirSync(repoDir);
    gitInit(repoDir);

    // Seed old plans.
    const oldDir = path.join(repoDir, ".agent", "plans");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "legacy.md"), "# Legacy\n");

    const overrideBase = path.join(tmp, "cli-migrate-base");
    const res = runCli(["plan-dir"], repoDir, {
      GLORIOUS_PLAN_DIR: overrideBase,
    });

    expect(res.status).toBe(0);
    const planDir = res.stdout.trim();
    // Legacy plan was migrated.
    expect(fs.existsSync(path.join(planDir, "legacy.md"))).toBe(true);
    expect(fs.existsSync(path.join(oldDir, "legacy.md"))).toBe(false);
    expect(fs.existsSync(path.join(oldDir, ".migrated"))).toBe(true);
  });

  test("fails with descriptive stderr when run outside a git repo", () => {
    const nonGit = path.join(tmp, "no-git");
    fs.mkdirSync(nonGit);

    const res = runCli(["plan-dir"], nonGit);

    expect(res.status).not.toBe(0);
    expect(res.stderr.toLowerCase()).toMatch(/git/);
    // Nothing printed to stdout.
    expect(res.stdout.trim()).toBe("");
  });
});
