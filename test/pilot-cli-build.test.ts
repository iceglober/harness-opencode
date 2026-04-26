// pilot-cli-build.test.ts — tests for src/pilot/cli/build.ts.
//
// `pilot build` orchestrates many subsystems; e2e is gated by
// OPENCODE_E2E=1. Unit tests cover:
//   - --dry-run prints the plan summary and exits 0.
//   - validation failure short-circuits with exit 2.
//   - --filter rejects unknown task ids.
//   - --workers > 1 emits the clamp warning.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runBuild } from "../src/pilot/cli/build.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-cli-build-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-b", "main", "--quiet", dir], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", dir, "config", "user.email", "t@e.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "T"]);
  execFileSync("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
  // An initial commit so HEAD resolves.
  fs.writeFileSync(path.join(dir, "README.md"), "x");
  execFileSync("git", ["-C", dir, "add", "README.md"]);
  execFileSync("git", ["-C", dir, "commit", "-m", "init", "--quiet"]);
}

const VALID_PLAN = `
name: build cli test
tasks:
  - id: T1
    title: t
    prompt: do
    touches: [src/a.ts]
    verify: ["true"]
  - id: T2
    title: u
    prompt: do
    touches: [src/b.ts]
    verify: ["true"]
    depends_on: [T1]
`.trimStart();

function setupRepoWithPlan(): {
  repo: string;
  pilotBase: string;
  planPath: string;
} {
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  gitInit(repo);
  const pilotBase = path.join(tmp, "pilot-base");
  // Drop the plan file at the plans dir.
  const plansDir = path.join(pilotBase, "repo", "pilot", "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  const planPath = path.join(plansDir, "test-plan.yaml");
  fs.writeFileSync(planPath, VALID_PLAN);
  return { repo, pilotBase, planPath };
}

async function withRepoEnv<T>(
  setup: ReturnType<typeof setupRepoWithPlan>,
  fn: () => Promise<T>,
): Promise<T> {
  const prevCwd = process.cwd();
  const prevEnv = process.env.GLORIOUS_PILOT_DIR;
  process.env.GLORIOUS_PILOT_DIR = setup.pilotBase;
  process.chdir(setup.repo);
  try {
    return await fn();
  } finally {
    process.chdir(prevCwd);
    if (prevEnv === undefined) delete process.env.GLORIOUS_PILOT_DIR;
    else process.env.GLORIOUS_PILOT_DIR = prevEnv;
  }
}

async function captured(
  fn: () => Promise<number>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => {
    err.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  let code: number;
  try {
    code = await fn();
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
  return { stdout: out.join(""), stderr: err.join(""), code };
}

// --- --dry-run ------------------------------------------------------------

describe("runBuild — --dry-run", () => {
  test("exits 0 and prints plan name + tasks", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() => runBuild({ plan: setup.planPath, dryRun: true })),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/--dry-run/);
    expect(r.stdout).toMatch(/build cli test/);
    expect(r.stdout).toMatch(/T1: t/);
    expect(r.stdout).toMatch(/T2: u/);
  });

  test("auto-finds the newest plan when --plan is omitted", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() => runBuild({ dryRun: true })),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/build cli test/);
  });
});

// --- Validation failure ---------------------------------------------------

describe("runBuild — validation", () => {
  test("schema-invalid plan: exit 2", async () => {
    const setup = setupRepoWithPlan();
    const bad = path.join(path.dirname(setup.planPath), "bad.yaml");
    fs.writeFileSync(
      bad,
      `name: bad\ntasks:\n  - id: lowercase\n    title: t\n    prompt: p\n`,
    );
    const r = await withRepoEnv(setup, () =>
      captured(() => runBuild({ plan: bad, dryRun: true })),
    );
    expect(r.code).toBe(2);
  });

  test("missing plan file (via --plan): exit 2", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runBuild({
          plan: path.join(tmp, "nope.yaml"),
          dryRun: true,
        }),
      ),
    );
    // Exit 2 — same exit code as schema-invalid plan, because a missing
    // plan is a resolution-surface problem (user fixes the path). This
    // replaced the v0.1 exit-1 behavior, which was reached via runValidate
    // throwing "cannot stat ...". Now the three-step resolver catches
    // non-existent paths up front and short-circuits with exit 2 + a
    // clear stderr message listing the tried paths.
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/cannot find plan/);
  });
});

// --- --filter -------------------------------------------------------------

describe("runBuild — --filter", () => {
  test("--filter with unknown id exits 2 with stderr", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runBuild({ plan: setup.planPath, filter: "GHOST", dryRun: true }),
      ),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/GHOST.*doesn't match/);
  });

  test("--filter with valid id passes through dry-run", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runBuild({ plan: setup.planPath, filter: "T1", dryRun: true }),
      ),
    );
    expect(r.code).toBe(0);
  });
});

// --- --workers ------------------------------------------------------------

describe("runBuild — --workers", () => {
  test("--workers > 1 logs a clamp warning to stderr", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runBuild({ plan: setup.planPath, dryRun: true, workers: 4 }),
      ),
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/--workers=4/);
    expect(r.stderr).toMatch(/clamping/i);
  });
});

// --- Positional plan arg + three-step resolution --------------------------

describe("runBuild — positional plan arg", () => {
  test("absolute path via positional resolves and dry-runs", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runBuild({ planPositional: setup.planPath, dryRun: true }),
      ),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/build cli test/);
  });

  test("bare filename resolves against plans dir", async () => {
    const setup = setupRepoWithPlan();
    // plan filename is "test-plan.yaml" — pass bare name.
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runBuild({ planPositional: "test-plan.yaml", dryRun: true }),
      ),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/build cli test/);
  });

  test("bare stem (no extension) resolves against plans dir with .yaml appended", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() => runBuild({ planPositional: "test-plan", dryRun: true })),
    );
    expect(r.code).toBe(0);
  });

  test("cwd-relative path resolves when plan lives in cwd", async () => {
    const setup = setupRepoWithPlan();
    // Copy the plan into cwd so a cwd-relative path hits.
    const copyPath = path.join(setup.repo, "local-plan.yaml");
    fs.writeFileSync(copyPath, fs.readFileSync(setup.planPath, "utf8"));
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runBuild({ planPositional: "local-plan.yaml", dryRun: true }),
      ),
    );
    expect(r.code).toBe(0);
  });

  test("positional path that doesn't match any location: exit 2 with tried paths in stderr", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runBuild({ planPositional: "does-not-exist.yaml", dryRun: true }),
      ),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/cannot find plan/);
    expect(r.stderr).toMatch(/Tried:/);
  });

  test("--plan wins over positional when both are supplied", async () => {
    const setup = setupRepoWithPlan();
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runBuild({
          plan: setup.planPath,
          planPositional: "does-not-exist.yaml",
          dryRun: true,
        }),
      ),
    );
    expect(r.code).toBe(0);
  });
});

// --- Interactive picker seam ----------------------------------------------

describe("runBuild — interactive picker seam", () => {
  test("readPlanSelection stub returning a path is respected when TTY", async () => {
    const setup = setupRepoWithPlan();
    // Force isTTY true so the TTY branch is taken. Restore after.
    const prevIsTTY = (process.stdin as NodeJS.ReadStream).isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    try {
      const r = await withRepoEnv(setup, () =>
        captured(() =>
          runBuild({
            dryRun: true,
            readPlanSelection: async () => setup.planPath,
          }),
        ),
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/build cli test/);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: prevIsTTY,
        configurable: true,
      });
    }
  });

  test("readPlanSelection returning undefined (Ctrl-C) exits 130", async () => {
    const setup = setupRepoWithPlan();
    const prevIsTTY = (process.stdin as NodeJS.ReadStream).isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    try {
      const r = await withRepoEnv(setup, () =>
        captured(() =>
          runBuild({
            dryRun: true,
            readPlanSelection: async () => undefined,
          }),
        ),
      );
      expect(r.code).toBe(130);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: prevIsTTY,
        configurable: true,
      });
    }
  });

  test("no args, non-TTY: falls back to newest in plans dir", async () => {
    const setup = setupRepoWithPlan();
    // bun test is typically non-TTY; don't force. If it were TTY the
    // test would need readPlanSelection to get past the picker.
    const prevIsTTY = (process.stdin as NodeJS.ReadStream).isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    try {
      const r = await withRepoEnv(setup, () =>
        captured(() => runBuild({ dryRun: true })),
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/build cli test/);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: prevIsTTY,
        configurable: true,
      });
    }
  });
});

// --- Streaming logger (unit test via exported helper) ----------------------

describe("startStreamingLogger", () => {
  test("emits task.started / task.succeeded / run.progress lines", () => {
    const { startStreamingLogger } = require("../src/pilot/cli/build.js");
    const lines: string[] = [];
    const stderrWriter = (s: string) => lines.push(s);

    // Fake subscriber that captures the registered callback so the test
    // can fire synthetic events.
    let cb: ((e: {
      runId: string;
      taskId: string | null;
      kind: string;
      payload: unknown;
      ts: number;
    }) => void) | null = null;
    const subscribe = (handler: typeof cb) => {
      cb = handler;
      return () => {
        cb = null;
      };
    };

    const teardown = startStreamingLogger({
      stderrWriter,
      runId: "RUN1",
      totalTasks: 3,
      subscribe: subscribe as Parameters<
        typeof startStreamingLogger
      >[0]["subscribe"],
      clock: () => 1700000000000,
    });

    // Fire: task T1 starts, passes verify, succeeds.
    cb!({
      runId: "RUN1",
      taskId: "T1",
      kind: "task.started",
      payload: null,
      ts: 1700000000000,
    });
    cb!({
      runId: "RUN1",
      taskId: "T1",
      kind: "task.verify.passed",
      payload: null,
      ts: 1700000010000,
    });
    cb!({
      runId: "RUN1",
      taskId: "T1",
      kind: "task.succeeded",
      payload: null,
      ts: 1700000015000,
    });

    const out = lines.join("");
    expect(out).toMatch(/task\.started T1/);
    expect(out).toMatch(/task\.verify\.passed T1/);
    expect(out).toMatch(/task\.succeeded T1/);
    expect(out).toMatch(/run\.progress 1\/3 succeeded/);

    teardown();
  });

  test("filters events from other runs", () => {
    const { startStreamingLogger } = require("../src/pilot/cli/build.js");
    const lines: string[] = [];
    let cb:
      | ((e: {
          runId: string;
          taskId: string | null;
          kind: string;
          payload: unknown;
          ts: number;
        }) => void)
      | null = null;
    const subscribe = (handler: typeof cb) => {
      cb = handler;
      return () => {
        cb = null;
      };
    };
    const teardown = startStreamingLogger({
      stderrWriter: (s: string) => lines.push(s),
      runId: "RUN1",
      totalTasks: 2,
      subscribe: subscribe as Parameters<
        typeof startStreamingLogger
      >[0]["subscribe"],
      clock: () => 1700000000000,
    });
    cb!({
      runId: "OTHER_RUN",
      taskId: "T1",
      kind: "task.started",
      payload: null,
      ts: 1700000000000,
    });
    expect(lines.join("")).toBe("");
    teardown();
  });

  test("suppresses chatty kinds (task.session.created etc.)", () => {
    const { startStreamingLogger } = require("../src/pilot/cli/build.js");
    const lines: string[] = [];
    let cb:
      | ((e: {
          runId: string;
          taskId: string | null;
          kind: string;
          payload: unknown;
          ts: number;
        }) => void)
      | null = null;
    const subscribe = (handler: typeof cb) => {
      cb = handler;
      return () => {
        cb = null;
      };
    };
    const teardown = startStreamingLogger({
      stderrWriter: (s: string) => lines.push(s),
      runId: "RUN1",
      totalTasks: 1,
      subscribe: subscribe as Parameters<
        typeof startStreamingLogger
      >[0]["subscribe"],
      clock: () => 1700000000000,
    });
    cb!({
      runId: "RUN1",
      taskId: "T1",
      kind: "task.session.created",
      payload: null,
      ts: 1700000000000,
    });
    cb!({
      runId: "RUN1",
      taskId: "T1",
      kind: "task.attempt",
      payload: null,
      ts: 1700000000001,
    });
    expect(lines.join("")).toBe("");
    teardown();
  });
});
