// pilot-paths.test.ts — coverage of src/pilot/paths.ts.
//
// Mirrors the test patterns in test/plan-paths.test.ts (real git, real
// filesystem, env mutation isolated per test). Verifies:
//
//   - derivation determinism (same cwd → same paths)
//   - env override (GLORIOUS_PILOT_DIR)
//   - env composition (GLORIOUS_PLAN_DIR pulls pilot under same parent)
//   - repo-key match with getRepoFolder
//   - directory auto-creation
//   - runId safety check
//   - worker index padding

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  getPilotDir,
  getPlansDir,
  getRunDir,
  getWorktreeDir,
  getStateDbPath,
  getWorkerJsonlPath,
} from "../src/pilot/paths.js";
import { getRepoFolder } from "../src/plan-paths.js";

// --- Fixtures --------------------------------------------------------------

function mkTmpDir(prefix = "pilot-paths-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-b", "main", "--quiet", dir], {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

// Restore env vars per test. Pilot uses both GLORIOUS_PILOT_DIR and
// GLORIOUS_PLAN_DIR (for env composition).
function withCleanEnv(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const prevPilot = process.env.GLORIOUS_PILOT_DIR;
    const prevPlan = process.env.GLORIOUS_PLAN_DIR;
    delete process.env.GLORIOUS_PILOT_DIR;
    delete process.env.GLORIOUS_PLAN_DIR;
    try {
      await fn();
    } finally {
      if (prevPilot === undefined) delete process.env.GLORIOUS_PILOT_DIR;
      else process.env.GLORIOUS_PILOT_DIR = prevPilot;
      if (prevPlan === undefined) delete process.env.GLORIOUS_PLAN_DIR;
      else process.env.GLORIOUS_PLAN_DIR = prevPlan;
    }
  };
}

// --- getPilotDir -----------------------------------------------------------

describe("getPilotDir", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmpDir();
  });
  afterEach(() => rmTmpDir(tmp));

  test(
    "default: ~/.glorious/opencode/<repo>/pilot",
    withCleanEnv(async () => {
      const repo = path.join(tmp, "default-pilot");
      fs.mkdirSync(repo);
      gitInit(repo);

      const dir = await getPilotDir(repo);
      const expected = path.join(
        os.homedir(),
        ".glorious",
        "opencode",
        "default-pilot",
        "pilot",
      );
      expect(dir).toBe(expected);
      expect(fs.existsSync(dir)).toBe(true);
    }),
  );

  test(
    "GLORIOUS_PILOT_DIR overrides the base",
    withCleanEnv(async () => {
      const repo = path.join(tmp, "env-override");
      fs.mkdirSync(repo);
      gitInit(repo);

      const overrideBase = path.join(tmp, "alt-pilot-base");
      process.env.GLORIOUS_PILOT_DIR = overrideBase;

      const dir = await getPilotDir(repo);
      expect(dir).toBe(path.join(overrideBase, "env-override", "pilot"));
    }),
  );

  test(
    "GLORIOUS_PILOT_DIR expands leading ~",
    withCleanEnv(async () => {
      const repo = path.join(tmp, "tilde-expand");
      fs.mkdirSync(repo);
      gitInit(repo);

      process.env.GLORIOUS_PILOT_DIR = "~/custom-pilot-base";
      const dir = await getPilotDir(repo);
      const expected = path.join(
        os.homedir(),
        "custom-pilot-base",
        "tilde-expand",
        "pilot",
      );
      expect(dir).toBe(expected);
    }),
  );

  test(
    "GLORIOUS_PLAN_DIR sets pilot base to its parent (env composition)",
    withCleanEnv(async () => {
      const repo = path.join(tmp, "compose");
      fs.mkdirSync(repo);
      gitInit(repo);

      // User aimed plan dir at <tmp>/scratch-base/<repo>/plans
      // → pilot base should be <tmp>/scratch-base, sibling-style.
      const planBase = path.join(tmp, "scratch-base");
      process.env.GLORIOUS_PLAN_DIR = planBase;

      const dir = await getPilotDir(repo);
      expect(dir).toBe(path.join(tmp, "compose", "pilot"));
    }),
  );

  test(
    "GLORIOUS_PILOT_DIR has higher priority than GLORIOUS_PLAN_DIR",
    withCleanEnv(async () => {
      const repo = path.join(tmp, "both-set");
      fs.mkdirSync(repo);
      gitInit(repo);

      process.env.GLORIOUS_PLAN_DIR = path.join(tmp, "ignored-plan-base");
      process.env.GLORIOUS_PILOT_DIR = path.join(tmp, "winner");
      const dir = await getPilotDir(repo);
      expect(dir).toBe(path.join(tmp, "winner", "both-set", "pilot"));
    }),
  );

  test(
    "auto-creates the directory",
    withCleanEnv(async () => {
      const repo = path.join(tmp, "auto");
      fs.mkdirSync(repo);
      gitInit(repo);

      const overrideBase = path.join(tmp, "fresh-pilot-base");
      process.env.GLORIOUS_PILOT_DIR = overrideBase;
      expect(fs.existsSync(overrideBase)).toBe(false);

      const dir = await getPilotDir(repo);
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    }),
  );

  test(
    "uses same repo-key as getRepoFolder (consistency)",
    withCleanEnv(async () => {
      const repo = path.join(tmp, "consistent");
      fs.mkdirSync(repo);
      gitInit(repo);

      const folder = await getRepoFolder(repo);
      const overrideBase = path.join(tmp, "consistent-base");
      process.env.GLORIOUS_PILOT_DIR = overrideBase;
      const dir = await getPilotDir(repo);
      expect(dir).toBe(path.join(overrideBase, folder, "pilot"));
    }),
  );

  test(
    "rejects non-git cwd (delegates to getRepoFolder error)",
    withCleanEnv(async () => {
      const nonGit = path.join(tmp, "no-git");
      fs.mkdirSync(nonGit);
      await expect(getPilotDir(nonGit)).rejects.toThrow(/git/i);
    }),
  );
});

// --- getPlansDir -----------------------------------------------------------

describe("getPlansDir", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmpDir();
  });
  afterEach(() => rmTmpDir(tmp));

  test(
    "appends 'plans' to the pilot dir and creates it",
    withCleanEnv(async () => {
      const repo = path.join(tmp, "plans-test");
      fs.mkdirSync(repo);
      gitInit(repo);

      process.env.GLORIOUS_PILOT_DIR = path.join(tmp, "pp");
      const plans = await getPlansDir(repo);
      expect(plans).toBe(path.join(tmp, "pp", "plans-test", "pilot", "plans"));
      expect(fs.existsSync(plans)).toBe(true);
    }),
  );
});

// --- getRunDir + getStateDbPath + getWorkerJsonlPath -----------------------

describe("getRunDir / file paths", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmpDir();
  });
  afterEach(() => rmTmpDir(tmp));

  test(
    "creates `runs/<runId>` and returns its path",
    withCleanEnv(async () => {
      const repo = path.join(tmp, "runs-test");
      fs.mkdirSync(repo);
      gitInit(repo);

      process.env.GLORIOUS_PILOT_DIR = path.join(tmp, "ppp");
      const runDir = await getRunDir(repo, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
      expect(runDir).toBe(
        path.join(
          tmp,
          "ppp",
          "runs-test",
          "pilot",
          "runs",
          "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        ),
      );
      expect(fs.existsSync(runDir)).toBe(true);
    }),
  );

  test(
    "getStateDbPath returns `<runDir>/state.db` (file not pre-created)",
    withCleanEnv(async () => {
      const repo = path.join(tmp, "db-test");
      fs.mkdirSync(repo);
      gitInit(repo);

      process.env.GLORIOUS_PILOT_DIR = path.join(tmp, "pdb");
      const dbPath = await getStateDbPath(repo, "01ARZ3NDEKTSV4RRFFQ69G5FA0");
      expect(path.basename(dbPath)).toBe("state.db");
      // Parent (runDir) exists but db file itself does NOT.
      expect(fs.existsSync(path.dirname(dbPath))).toBe(true);
      expect(fs.existsSync(dbPath)).toBe(false);
    }),
  );

  test(
    "getWorkerJsonlPath creates `workers/` and pads index",
    withCleanEnv(async () => {
      const repo = path.join(tmp, "jsonl-test");
      fs.mkdirSync(repo);
      gitInit(repo);

      process.env.GLORIOUS_PILOT_DIR = path.join(tmp, "pjsonl");
      const p0 = await getWorkerJsonlPath(repo, "01ARZ3NDEKTSV4RRFFQ69G5FAA", 0);
      const p1 = await getWorkerJsonlPath(repo, "01ARZ3NDEKTSV4RRFFQ69G5FAA", 1);
      expect(path.basename(p0)).toBe("00.jsonl");
      expect(path.basename(p1)).toBe("01.jsonl");
      expect(fs.existsSync(path.dirname(p0))).toBe(true);
      // File NOT pre-created.
      expect(fs.existsSync(p0)).toBe(false);
    }),
  );

  test(
    "rejects unsafe runIds",
    withCleanEnv(async () => {
      const repo = path.join(tmp, "unsafe-id");
      fs.mkdirSync(repo);
      gitInit(repo);

      process.env.GLORIOUS_PILOT_DIR = path.join(tmp, "punsafe");
      await expect(getRunDir(repo, "../escape")).rejects.toThrow(/safe/);
      await expect(getRunDir(repo, "/abs")).rejects.toThrow(/safe/);
      await expect(getRunDir(repo, ".hidden")).rejects.toThrow(/safe/);
      await expect(getRunDir(repo, "")).rejects.toThrow(/safe/);
      await expect(getRunDir(repo, "has space")).rejects.toThrow(/safe/);
    }),
  );
});

// --- getWorktreeDir --------------------------------------------------------

describe("getWorktreeDir", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmpDir();
  });
  afterEach(() => rmTmpDir(tmp));

  test(
    "creates parent `worktrees/<runId>/` and returns padded leaf path",
    withCleanEnv(async () => {
      const repo = path.join(tmp, "wt-test");
      fs.mkdirSync(repo);
      gitInit(repo);

      process.env.GLORIOUS_PILOT_DIR = path.join(tmp, "wt-base");
      const wt0 = await getWorktreeDir(repo, "01ARZ3NDEKTSV4RRFFQ69G5FAB", 0);
      expect(path.basename(wt0)).toBe("00");
      // Parent created.
      expect(fs.existsSync(path.dirname(wt0))).toBe(true);
      // Leaf NOT created (git worktree add owns that).
      expect(fs.existsSync(wt0)).toBe(false);

      const wt12 = await getWorktreeDir(repo, "01ARZ3NDEKTSV4RRFFQ69G5FAB", 12);
      expect(path.basename(wt12)).toBe("12");
    }),
  );

  test(
    "rejects negative or non-integer worker index",
    withCleanEnv(async () => {
      const repo = path.join(tmp, "wt-bad-n");
      fs.mkdirSync(repo);
      gitInit(repo);
      process.env.GLORIOUS_PILOT_DIR = path.join(tmp, "wbn");

      await expect(
        getWorktreeDir(repo, "01ARZ3NDEKTSV4RRFFQ69G5FAB", -1),
      ).rejects.toThrow(/non-negative/);
      await expect(
        getWorktreeDir(repo, "01ARZ3NDEKTSV4RRFFQ69G5FAB", 1.5),
      ).rejects.toThrow(/integer/);
    }),
  );
});

// --- Determinism -----------------------------------------------------------

describe("determinism", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmpDir();
  });
  afterEach(() => rmTmpDir(tmp));

  test(
    "same inputs produce same paths every call",
    withCleanEnv(async () => {
      const repo = path.join(tmp, "deterministic");
      fs.mkdirSync(repo);
      gitInit(repo);
      process.env.GLORIOUS_PILOT_DIR = path.join(tmp, "det-base");

      const a = await getPilotDir(repo);
      const b = await getPilotDir(repo);
      expect(a).toBe(b);

      const r1 = await getRunDir(repo, "01ARZ3NDEKTSV4RRFFQ69G5FAC");
      const r2 = await getRunDir(repo, "01ARZ3NDEKTSV4RRFFQ69G5FAC");
      expect(r1).toBe(r2);
    }),
  );
});
