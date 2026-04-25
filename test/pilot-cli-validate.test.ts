// pilot-cli-validate.test.ts — coverage for src/pilot/cli/validate.ts.
//
// Exercises both surfaces:
//   - runValidate({ planPath?, strict?, quiet? }): Promise<exitCode>.
//   - The CLI binary spawned via `bun run dist/cli.js pilot validate ...`,
//     to confirm the cmd-ts wiring routes correctly. The spawn-based
//     tests are limited to a couple of smoke tests; deep coverage is at
//     the runValidate level.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runValidate } from "../src/pilot/cli/validate.js";

// --- Fixtures --------------------------------------------------------------

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-cli-validate-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writePlan(name: string, content: string): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
}

// YAML quoting: bare `true` parses to boolean, which Zod rejects (we
// want a string). Use the explicit string form for verify commands.
const VALID_PLAN = `
name: cli test plan
tasks:
  - id: T1
    title: first task
    prompt: do
    touches:
      - src/a.ts
    verify:
      - "true"
`.trimStart();

// Capture stdout/stderr around a runValidate call.
async function captured(
  fn: () => Promise<number>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  let code: number;
  try {
    code = await fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    code,
  };
}

// --- Happy path ------------------------------------------------------------

describe("runValidate — happy path", () => {
  test("exit 0 on a clean plan with explicit path", async () => {
    const p = writePlan("good.yaml", VALID_PLAN);
    const r = await captured(() => runValidate({ planPath: p, quiet: true }));
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
  });

  test("non-quiet mode prints an `ok:` summary to stdout", async () => {
    const p = writePlan("good.yaml", VALID_PLAN);
    const r = await captured(() => runValidate({ planPath: p }));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^ok: /);
    expect(r.stdout).toMatch(/1 tasks/);
  });

  test("accepts a directory and finds the newest *.yaml inside", async () => {
    fs.writeFileSync(path.join(tmp, "older.yaml"), VALID_PLAN);
    // Set mtime in the past on `older.yaml` to prove "newest by mtime"
    // wins. Then write a second file slightly later.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(tmp, "older.yaml"), past, past);
    const p = writePlan("newer.yaml", VALID_PLAN);
    void p;
    const r = await captured(() => runValidate({ planPath: tmp, quiet: true }));
    expect(r.code).toBe(0);
  });

  test("with no planPath, falls back to getPlansDir()", async () => {
    // Use GLORIOUS_PILOT_DIR override so the test doesn't touch real
    // user state. Also need a git repo at cwd because getPilotDir
    // delegates to getRepoFolder which requires git.
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    spawnSync("git", ["init", "-b", "main", "--quiet", repo], {
      stdio: "ignore",
    });
    const pilotBase = path.join(tmp, "pilot-base");

    // Manually mkdir the plans dir + drop a plan in it.
    const expectedPlansDir = path.join(pilotBase, "repo", "pilot", "plans");
    fs.mkdirSync(expectedPlansDir, { recursive: true });
    fs.writeFileSync(path.join(expectedPlansDir, "implicit.yaml"), VALID_PLAN);

    const prevCwd = process.cwd();
    const prevPilotEnv = process.env.GLORIOUS_PILOT_DIR;
    process.env.GLORIOUS_PILOT_DIR = pilotBase;
    process.chdir(repo);
    try {
      const r = await captured(() => runValidate({ quiet: true }));
      expect(r.code).toBe(0);
    } finally {
      process.chdir(prevCwd);
      if (prevPilotEnv === undefined) delete process.env.GLORIOUS_PILOT_DIR;
      else process.env.GLORIOUS_PILOT_DIR = prevPilotEnv;
    }
  });
});

// --- Schema errors ---------------------------------------------------------

describe("runValidate — schema errors", () => {
  test("exit 2 on a schema-invalid plan; stderr lists the error path", async () => {
    const p = writePlan(
      "bad.yaml",
      `
name: bad
tasks:
  - id: t1   # lowercase = invalid per /^[A-Z][A-Z0-9-]*$/
    title: x
    prompt: p
`.trimStart(),
    );
    const r = await captured(() => runValidate({ planPath: p }));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/schema/);
    expect(r.stderr).toMatch(/tasks\[0\]\.id/);
  });

  test("exit 2 on YAML parse error; stderr labels it 'yaml'", async () => {
    const p = writePlan("syntax.yaml", `name: "unterminated`);
    const r = await captured(() => runValidate({ planPath: p }));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/yaml/);
  });

  test("exit 1 on missing file", async () => {
    const r = await captured(() =>
      runValidate({ planPath: path.join(tmp, "missing.yaml") }),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/cannot stat|ENOENT/i);
  });
});

// --- DAG errors ------------------------------------------------------------

describe("runValidate — DAG errors", () => {
  test("exit 2 on cycle; stderr labels it 'dag'", async () => {
    const p = writePlan(
      "cycle.yaml",
      `
name: cycle
tasks:
  - id: T1
    title: a
    prompt: p
    depends_on: [T2]
  - id: T2
    title: b
    prompt: p
    depends_on: [T1]
`.trimStart(),
    );
    const r = await captured(() => runValidate({ planPath: p }));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/dag:.*cycle/);
  });

  test("exit 2 on dangling depends_on", async () => {
    const p = writePlan(
      "dangling.yaml",
      `
name: dangling
tasks:
  - id: T1
    title: a
    prompt: p
    depends_on: [GHOST]
`.trimStart(),
    );
    const r = await captured(() => runValidate({ planPath: p }));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/dag:.*GHOST/);
  });

  test("exit 2 on duplicate task ID", async () => {
    const p = writePlan(
      "dupes.yaml",
      `
name: dupes
tasks:
  - id: T1
    title: a
    prompt: p
  - id: T1
    title: b
    prompt: p
`.trimStart(),
    );
    const r = await captured(() => runValidate({ planPath: p }));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/dag:.*duplicate/);
  });
});

// --- Glob conflicts (warnings) ---------------------------------------------

describe("runValidate — glob conflicts", () => {
  const overlappingPlan = `
name: overlap
tasks:
  - id: T1
    title: a
    prompt: p
    touches: [src/**]
  - id: T2
    title: b
    prompt: p
    touches: [src/api/**]
`.trimStart();

  test("warns by default but exits 0", async () => {
    const p = writePlan("overlap.yaml", overlappingPlan);
    const r = await captured(() => runValidate({ planPath: p, quiet: true }));
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/touches-conflict.*warn/);
    expect(r.stderr).toMatch(/T1.*T2/);
  });

  test("--strict promotes to error and exits 2", async () => {
    const p = writePlan("overlap.yaml", overlappingPlan);
    const r = await captured(() =>
      runValidate({ planPath: p, strict: true, quiet: true }),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/touches-conflict.*error/);
  });
});

// --- CLI binary smoke (subprocess) -----------------------------------------

describe("CLI surface — pilot validate (spawned)", () => {
  const cliPath = path.resolve(import.meta.dir, "..", "src", "cli.ts");

  test("exit 0 on a valid plan via the spawned CLI", () => {
    const p = writePlan("ok.yaml", VALID_PLAN);
    const r = spawnSync("bun", ["run", cliPath, "pilot", "validate", p], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(r.status).toBe(0);
  });

  test("exit 2 on an invalid plan via the spawned CLI; stderr non-empty", () => {
    const p = writePlan(
      "bad.yaml",
      `name: x\ntasks:\n  - id: lowercase\n    title: t\n    prompt: p\n`,
    );
    const r = spawnSync("bun", ["run", cliPath, "pilot", "validate", p], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  test("--help prints subcommand info", () => {
    const r = spawnSync(
      "bun",
      ["run", cliPath, "pilot", "validate", "--help"],
      { encoding: "utf8", timeout: 10_000 },
    );
    // cmd-ts exits 1 on --help. Status is implementation detail; we
    // care that the help text mentions our command.
    expect(r.stdout + r.stderr).toMatch(/validate/i);
  });
});
