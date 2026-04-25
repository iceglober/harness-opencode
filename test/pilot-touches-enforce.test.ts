// pilot-touches-enforce.test.ts — tests for src/pilot/verify/touches.ts.
//
// Two surfaces:
//   - enforceTouches (real-fs, real-git): exercises the diff-collection
//     path and verifies allowed-vs-violator splits on actual edits.
//   - enforceTouchesPure (no-fs): exhaustive logic coverage without
//     touching git (faster, more cases).

import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  enforceTouches,
  enforceTouchesPure,
} from "../src/pilot/verify/touches.js";
import { gitIsAvailable } from "../src/pilot/worktree/git.js";

// --- Fixtures --------------------------------------------------------------

let GIT_OK = false;
beforeAll(async () => {
  GIT_OK = await gitIsAvailable();
});

function mkTmpDir(prefix = "pilot-touches-test-"): string {
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
  fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
  fs.writeFileSync(path.join(repo, name), content);
  execFileSync("git", ["-C", repo, "add", name]);
  execFileSync("git", ["-C", repo, "commit", "-m", msg, "--quiet"]);
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

// --- enforceTouchesPure (logic coverage) -----------------------------------

describe("enforceTouchesPure", () => {
  test("ok=true when no files changed (verify-only task)", () => {
    const r = enforceTouchesPure({ changed: [], allowed: [] });
    expect(r).toEqual({ ok: true, changed: [] });
  });

  test("ok=true when no files changed and allowed list is non-empty", () => {
    const r = enforceTouchesPure({ changed: [], allowed: ["src/**"] });
    expect(r).toEqual({ ok: true, changed: [] });
  });

  test("ok=false when allowed empty and any file changed (every change is a violation)", () => {
    const r = enforceTouchesPure({
      changed: ["src/foo.ts", "src/bar.ts"],
      allowed: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violators).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  test("ok=true when every changed file matches an allowed glob", () => {
    const r = enforceTouchesPure({
      changed: ["src/api/foo.ts", "src/api/bar.ts"],
      allowed: ["src/api/**"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toEqual(["src/api/foo.ts", "src/api/bar.ts"]);
  });

  test("ok=false reports the subset that violates", () => {
    const r = enforceTouchesPure({
      changed: ["src/api/foo.ts", "src/web/bar.ts", "src/api/baz.ts"],
      allowed: ["src/api/**"],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violators).toEqual(["src/web/bar.ts"]);
    // changed is the full list, including allowed paths.
    expect(r.changed).toEqual([
      "src/api/foo.ts",
      "src/web/bar.ts",
      "src/api/baz.ts",
    ]);
  });

  test("multiple allowed globs OR'd together", () => {
    const r = enforceTouchesPure({
      changed: ["src/api/foo.ts", "test/api.test.ts", "docs/README.md"],
      allowed: ["src/**", "test/**"],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violators).toEqual(["docs/README.md"]);
  });

  test("dotfile match works (dot:true)", () => {
    const r = enforceTouchesPure({
      changed: [".gitignore"],
      allowed: ["**"],
    });
    expect(r.ok).toBe(true);
  });

  test("specific-file allowed exact match", () => {
    const r = enforceTouchesPure({
      changed: ["package.json", "bun.lock"],
      allowed: ["package.json"],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violators).toEqual(["bun.lock"]);
  });

  test("**/*.ts captures nested but not non-ts", () => {
    const r = enforceTouchesPure({
      changed: ["src/a.ts", "src/deep/nested/b.ts", "src/c.md"],
      allowed: ["**/*.ts"],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violators).toEqual(["src/c.md"]);
  });
});

// --- enforceTouches (real-fs / real-git) -----------------------------------

describe("enforceTouches (real git)", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => rmTmpDir(tmp));

  test("ok when changes are within allowed glob", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    const sha = gitCommitFile(repo, "src/api/a.ts", "old\n", "init");

    fs.writeFileSync(path.join(repo, "src/api/a.ts"), "new\n");
    fs.writeFileSync(path.join(repo, "src/api/b.ts"), "x\n");

    const r = await enforceTouches({
      worktree: repo,
      sinceSha: sha,
      allowed: ["src/api/**"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toContain("src/api/a.ts");
    expect(r.changed).toContain("src/api/b.ts");
  });

  test("violation reported for out-of-scope edit", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    const sha = gitCommitFile(repo, "src/api/a.ts", "x\n", "init");

    // Allowed scope is src/api only, but agent edits src/web too.
    fs.writeFileSync(path.join(repo, "src/api/a.ts"), "modified\n");
    fs.mkdirSync(path.join(repo, "src/web"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src/web/leak.ts"), "leak\n");

    const r = await enforceTouches({
      worktree: repo,
      sinceSha: sha,
      allowed: ["src/api/**"],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violators).toEqual(["src/web/leak.ts"]);
    expect(r.changed).toContain("src/api/a.ts");
    expect(r.changed).toContain("src/web/leak.ts");
  });

  test("no edits = ok (verify-only task that legitimately did nothing)", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    const sha = gitCommitFile(repo, "src/a.ts", "x\n", "init");

    const r = await enforceTouches({
      worktree: repo,
      sinceSha: sha,
      allowed: ["src/**"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toEqual([]);
  });

  test("any edit with allowed=[] is a violation", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    const sha = gitCommitFile(repo, "a.ts", "x\n", "init");
    fs.writeFileSync(path.join(repo, "a.ts"), "edited\n");

    const r = await enforceTouches({
      worktree: repo,
      sinceSha: sha,
      allowed: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violators).toEqual(["a.ts"]);
  });

  test("untracked out-of-scope file is a violation", async () => {
    if (!GIT_OK) return;
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    gitInit(repo);
    const sha = gitCommitFile(repo, "src/a.ts", "x\n", "init");
    fs.writeFileSync(path.join(repo, "rogue.txt"), "untracked\n");

    const r = await enforceTouches({
      worktree: repo,
      sinceSha: sha,
      allowed: ["src/**"],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violators).toEqual(["rogue.txt"]);
  });
});
