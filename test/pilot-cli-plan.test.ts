// pilot-cli-plan.test.ts — tests for src/pilot/cli/plan.ts.
//
// `pilot plan` spawns opencode and waits. We can't (and shouldn't) spawn
// a real opencode in unit tests, so we use a shell shim on PATH:
//   - "happy" shim: writes a yaml into the plans dir, exits 0.
//   - "fail" shim: exits 1 without writing.
//   - "no-op" shim: exits 0 without writing.
// The shim is invoked via the `--opencode-bin` flag (avoids PATH gymnastics).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runPlan } from "../src/pilot/cli/plan.js";

// --- Fixtures --------------------------------------------------------------

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-cli-plan-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-b", "main", "--quiet", dir], {
    stdio: "ignore",
  });
}

function setupRepo(): { repo: string; pilotBase: string; plansDir: string } {
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  gitInit(repo);
  const pilotBase = path.join(tmp, "pilot-base");
  // The plans dir doesn't need to exist beforehand — runPlan() calls
  // getPlansDir which auto-creates it.
  const plansDir = path.join(pilotBase, "repo", "pilot", "plans");
  return { repo, pilotBase, plansDir };
}

/**
 * Write a shell shim that exits with `kind`'s behavior.
 *   - "happy": writes a fake plan into $PLANS_DIR, exits 0.
 *   - "fail": exits 1.
 *   - "noop": exits 0.
 *   - "log-argv": records its own argv to `argvLogPath`, writes a fake
 *     plan, exits 0. Used to assert the `--prompt` text that runPlan
 *     passes to opencode.
 */
function writeShim(
  kind: "happy" | "fail" | "noop" | "log-argv",
  plansDir: string,
  argvLogPath?: string,
): string {
  const file = path.join(tmp, "fake-opencode.sh");
  const body =
    kind === "happy"
      ? `#!/usr/bin/env bash\nmkdir -p ${JSON.stringify(plansDir)}\ncat > ${JSON.stringify(path.join(plansDir, "test-plan.yaml"))} <<'YAML'\nname: test\ntasks:\n  - id: T1\n    title: t\n    prompt: p\nYAML\nexit 0\n`
      : kind === "fail"
        ? `#!/usr/bin/env bash\nexit 1\n`
        : kind === "noop"
          ? `#!/usr/bin/env bash\nexit 0\n`
          : // log-argv
            `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argvLogPath ?? "/dev/null")}\nmkdir -p ${JSON.stringify(plansDir)}\ncat > ${JSON.stringify(path.join(plansDir, "test-plan.yaml"))} <<'YAML'\nname: test\ntasks:\n  - id: T1\n    title: t\n    prompt: p\nYAML\nexit 0\n`;
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return file;
}

/** Test seam stub for `readInput`. Returns a fixed string. */
const stubReadInput = (text: string) => async (): Promise<string> => text;

async function withRepoEnv<T>(
  setup: ReturnType<typeof setupRepo>,
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

// --- Tests -----------------------------------------------------------------

describe("runPlan", () => {
  test("exit 0 + prints plan path when shim writes a new YAML", async () => {
    const setup = setupRepo();
    const shim = writeShim("happy", setup.plansDir);
    const r = await withRepoEnv(setup, () =>
      captured(() => runPlan({ input: "test input", opencodeBin: shim })),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Plan ready at/);
    expect(r.stdout).toMatch(/test-plan\.yaml/);
    expect(r.stdout).toMatch(/pilot build/);
  });

  test("exit 1 when shim exits non-zero", async () => {
    const setup = setupRepo();
    const shim = writeShim("fail", setup.plansDir);
    const r = await withRepoEnv(setup, () =>
      captured(() => runPlan({ input: "x", opencodeBin: shim })),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/exited with code 1/);
  });

  test("exit 1 when shim exits 0 but writes no plan", async () => {
    const setup = setupRepo();
    const shim = writeShim("noop", setup.plansDir);
    const r = await withRepoEnv(setup, () =>
      captured(() => runPlan({ input: "x", opencodeBin: shim })),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no new plan was saved/);
  });

  test("no positional input: uses readInput seam to collect prompt", async () => {
    const setup = setupRepo();
    const shim = writeShim("happy", setup.plansDir);
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runPlan({
          opencodeBin: shim,
          readInput: stubReadInput("from prompt"),
        }),
      ),
    );
    expect(r.code).toBe(0);
  });

  test("no positional input: typed prompt is passed to opencode --prompt", async () => {
    const setup = setupRepo();
    const argvLog = path.join(tmp, "argv.log");
    const shim = writeShim("log-argv", setup.plansDir, argvLog);
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runPlan({
          opencodeBin: shim,
          readInput: stubReadInput("build me a thing"),
        }),
      ),
    );
    expect(r.code).toBe(0);
    const argv = fs.readFileSync(argvLog, "utf8");
    // The shim records one argv element per line. We should see the agent
    // flag, the agent name, the prompt flag, and the initial prompt text
    // (which embeds the user's typed input).
    expect(argv).toMatch(/--agent/);
    expect(argv).toMatch(/pilot-planner/);
    expect(argv).toMatch(/--prompt/);
    expect(argv).toMatch(/build me a thing/);
  });

  test("no positional input and readInput returns empty: exits 1 without launching opencode", async () => {
    const setup = setupRepo();
    const argvLog = path.join(tmp, "argv.log");
    const shim = writeShim("log-argv", setup.plansDir, argvLog);
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runPlan({
          opencodeBin: shim,
          readInput: stubReadInput("   "), // whitespace-only
        }),
      ),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no description provided/);
    // Shim must NOT have been invoked — the argv log file should not exist.
    expect(fs.existsSync(argvLog)).toBe(false);
  });

  test("no positional input and readInput throws ExitPromptError: exits 130", async () => {
    const setup = setupRepo();
    const argvLog = path.join(tmp, "argv.log");
    const shim = writeShim("log-argv", setup.plansDir, argvLog);
    const readInputCancelled = async (): Promise<string> => {
      const err = new Error("user cancelled") as Error & { name: string };
      err.name = "ExitPromptError";
      throw err;
    };
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runPlan({ opencodeBin: shim, readInput: readInputCancelled }),
      ),
    );
    expect(r.code).toBe(130);
    expect(r.stderr).toMatch(/cancelled/);
    expect(fs.existsSync(argvLog)).toBe(false);
  });

  test("missing opencode binary surfaces a spawn error", async () => {
    const setup = setupRepo();
    const r = await withRepoEnv(setup, () =>
      captured(() =>
        runPlan({
          input: "x",
          opencodeBin: path.join(tmp, "this-does-not-exist"),
        }),
      ),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/failed to spawn|ENOENT/i);
  });
});
