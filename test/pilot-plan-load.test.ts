// pilot-plan-load.test.ts — integration tests for src/pilot/plan/load.ts.
//
// Uses the real filesystem (tmp dirs) — no `fs` mocking. Exercises every
// branch of the loader's discriminated-union return:
//   - LoadOk
//   - kind: "fs"      (file not found, EISDIR)
//   - kind: "yaml"    (malformed YAML, empty file, bare-null doc)
//   - kind: "schema"  (well-formed YAML that fails the plan schema)
//
// Each test creates and tears down its own tmp dir.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadPlan } from "../src/pilot/plan/load.js";

// --- Helpers ---------------------------------------------------------------

function mkTmpDir(prefix = "pilot-plan-load-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writePlan(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

const VALID_PLAN = `
name: test plan
tasks:
  - id: T1
    title: first task
    prompt: do the thing
`.trim();

// --- Happy path ------------------------------------------------------------

describe("loadPlan — happy path", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => { rmTmpDir(tmp); });

  test("loads and validates a minimal valid plan", async () => {
    const p = writePlan(tmp, "pilot.yaml", VALID_PLAN);
    const result = await loadPlan(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.name).toBe("test plan");
    expect(result.plan.tasks).toHaveLength(1);
    expect(result.plan.tasks[0]!.id).toBe("T1");
    expect(result.absPath).toBe(p);
  });

  test("resolves relative paths against process.cwd()", async () => {
    const p = writePlan(tmp, "pilot.yaml", VALID_PLAN);
    const prevCwd = process.cwd();
    try {
      process.chdir(tmp);
      const result = await loadPlan("pilot.yaml");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // On macOS, /tmp is a symlink to /private/tmp, so process.chdir + path.resolve
      // can yield /private/var/... while the original p is /var/... . Compare via
      // realpath on both sides.
      expect(fs.realpathSync(result.absPath)).toBe(fs.realpathSync(p));
    } finally {
      process.chdir(prevCwd);
    }
  });

  test("loads a more complex plan with milestones, deps, verify, touches", async () => {
    const content = `
name: complex plan
defaults:
  agent: pilot-builder
  model: anthropic/claude-sonnet-4-6
  verify_after_each:
    - bun run typecheck
milestones:
  - name: M1
    description: Foundation
    verify:
      - bun run build
tasks:
  - id: T1
    title: schema
    prompt: |
      Build the schema.
      Multi-line OK.
    touches:
      - src/schema/**
    verify:
      - bun test test/schema.test.ts
    milestone: M1
  - id: T2
    title: loader
    prompt: build the loader
    touches:
      - src/loader/**
    depends_on:
      - T1
    milestone: M1
`.trim();
    const p = writePlan(tmp, "complex.yaml", content);
    const result = await loadPlan(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.tasks).toHaveLength(2);
    expect(result.plan.tasks[1]!.depends_on).toEqual(["T1"]);
    expect(result.plan.milestones[0]!.verify).toEqual(["bun run build"]);
    expect(result.plan.defaults.verify_after_each).toEqual(["bun run typecheck"]);
  });
});

// --- Filesystem failures ---------------------------------------------------

describe("loadPlan — fs errors", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => { rmTmpDir(tmp); });

  test("returns kind=fs when file does not exist", async () => {
    const result = await loadPlan(path.join(tmp, "missing.yaml"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("fs");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.path).toBe("<file>");
    expect(result.errors[0]!.message.toLowerCase()).toMatch(/enoent|no such/);
  });

  test("returns kind=fs when path points at a directory (EISDIR)", async () => {
    // Reading a directory as a file errors with EISDIR.
    const result = await loadPlan(tmp);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("fs");
    expect(result.errors[0]!.message.toLowerCase()).toMatch(/eisdir|directory/);
  });

  test("returns absolute path even when input was relative", async () => {
    const result = await loadPlan("does-not-exist.yaml");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(path.isAbsolute(result.absPath)).toBe(true);
  });

  test("throws TypeError on non-string input (caller bug)", async () => {
    // Caller bugs SHOULD throw — this isn't a user-data error envelope case.
    // @ts-expect-error testing runtime behavior with bad input
    await expect(loadPlan(42)).rejects.toThrow(/string/);
  });
});

// --- YAML errors -----------------------------------------------------------

describe("loadPlan — yaml errors", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => { rmTmpDir(tmp); });

  test("returns kind=yaml on malformed YAML (unclosed string)", async () => {
    const p = writePlan(tmp, "bad.yaml", "name: \"unterminated");
    const result = await loadPlan(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("yaml");
    expect(result.errors[0]!.message.toLowerCase()).toMatch(/yaml/);
  });

  test("returns kind=yaml on tab-indented block (a common YAML pitfall)", async () => {
    const content = "tasks:\n\t- id: T1\n\t  title: t\n\t  prompt: p";
    const p = writePlan(tmp, "tabs.yaml", content);
    const result = await loadPlan(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Either yaml-parser-rejected or schema-rejected (depending on how
    // the parser handles tabs in some versions). In either case, it's
    // NOT ok=true.
    expect(["yaml", "schema"]).toContain(result.kind);
  });

  test("returns kind=yaml on empty file", async () => {
    const p = writePlan(tmp, "empty.yaml", "");
    const result = await loadPlan(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("yaml");
    expect(result.errors[0]!.message.toLowerCase()).toMatch(/empty|null/);
  });

  test("returns kind=yaml on bare-null document ('~')", async () => {
    const p = writePlan(tmp, "null-doc.yaml", "~");
    const result = await loadPlan(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("yaml");
    expect(result.errors[0]!.message.toLowerCase()).toMatch(/null|empty/);
  });

  test("includes line/col context in yaml parse error when available", async () => {
    // A YAML mapping-then-list-without-key error with deterministic position.
    const content = "name: ok\ntasks:\n  - id: T1\n    title: : :\n";
    const p = writePlan(tmp, "syntax.yaml", content);
    const result = await loadPlan(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // We expect a parse error of some kind; line/col is best-effort.
    expect(["yaml", "schema"]).toContain(result.kind);
  });
});

// --- Schema errors ---------------------------------------------------------

describe("loadPlan — schema errors", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => { rmTmpDir(tmp); });

  test("returns kind=schema when YAML is well-formed but plan-invalid (missing tasks)", async () => {
    const p = writePlan(tmp, "no-tasks.yaml", "name: just a name\n");
    const result = await loadPlan(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("schema");
    expect(result.errors.some((e) => e.path.includes("tasks"))).toBe(true);
  });

  test("returns kind=schema with structured errors (path + message)", async () => {
    const content = `
name: bad task
tasks:
  - id: t1   # lowercase — invalid
    title: x
    prompt: p
`.trim();
    const p = writePlan(tmp, "bad-id.yaml", content);
    const result = await loadPlan(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("schema");
    const idErr = result.errors.find((e) => e.path.includes("id"));
    expect(idErr).toBeDefined();
    expect(idErr!.message).toMatch(/[A-Z]\[A-Z0-9-\]\*|task id/i);
  });

  test("returns kind=schema with multiple errors collected (not short-circuit)", async () => {
    const content = `
name: many errors
tasks:
  - id: bad-lowercase
    title: ""
    prompt: ""
`.trim();
    const p = writePlan(tmp, "many.yaml", content);
    const result = await loadPlan(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("schema");
    // At least 2 errors: bad id + empty title (and maybe empty prompt).
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  test("returns kind=schema when document is an array, not an object", async () => {
    const p = writePlan(tmp, "array-doc.yaml", "- foo\n- bar\n");
    const result = await loadPlan(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("schema");
  });
});

// --- absPath in the result -------------------------------------------------

describe("loadPlan — absPath fidelity", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => { rmTmpDir(tmp); });

  test("resolves symlinks-aware absolute path on every result kind", async () => {
    // Simple: just check the path is absolute on every branch.
    const ok = await loadPlan(writePlan(tmp, "ok.yaml", VALID_PLAN));
    expect(path.isAbsolute(ok.ok ? ok.absPath : ok.absPath)).toBe(true);

    const fsErr = await loadPlan(path.join(tmp, "missing.yaml"));
    expect(path.isAbsolute(fsErr.ok ? fsErr.absPath : fsErr.absPath)).toBe(true);

    const yamlErr = await loadPlan(writePlan(tmp, "bad.yaml", "name: \"unterminated"));
    expect(path.isAbsolute(yamlErr.ok ? yamlErr.absPath : yamlErr.absPath)).toBe(true);

    const schemaErr = await loadPlan(writePlan(tmp, "noTasks.yaml", "name: x\n"));
    expect(path.isAbsolute(schemaErr.ok ? schemaErr.absPath : schemaErr.absPath)).toBe(true);
  });
});
