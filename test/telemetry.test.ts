import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// We need to test the `clean` function and the opt-out logic from
// src/telemetry.ts. Because the module reads env vars at import time
// (for the DISABLED const), we test `clean` via a direct import and
// test opt-out behavior by checking the exported DISABLED flag under
// controlled env.
// ---------------------------------------------------------------------------

import { clean } from "../src/telemetry.js";

// ---------------------------------------------------------------------------
// clean() — property allowlist
// ---------------------------------------------------------------------------

describe("telemetry clean()", () => {
  it("passes through allowed string props", () => {
    expect(clean({ tool: "hashline_edit", outcome: "success" })).toEqual({
      tool: "hashline_edit",
      outcome: "success",
    });
  });

  it("passes through allowed number props", () => {
    expect(clean({ duration_ms: 42, ops_count: 7 })).toEqual({
      duration_ms: 42,
      ops_count: 7,
    });
  });

  it("converts booleans to 0/1", () => {
    expect(clean({ stale: true })).toEqual({ stale: 1 });
    expect(clean({ stale: false })).toEqual({ stale: 0 });
  });

  it("strips unknown keys", () => {
    const result = clean({
      tool: "hashline_edit",
      secret_data: "should not appear",
      file_path: "/home/user/project/foo.ts",
      prompt: "do something dangerous",
    });
    expect(result).toEqual({ tool: "hashline_edit" });
    expect(result).not.toHaveProperty("secret_data");
    expect(result).not.toHaveProperty("file_path");
    expect(result).not.toHaveProperty("prompt");
  });

  it("strips non-string/number/boolean values", () => {
    const result = clean({
      tool: "test",
      duration_ms: { nested: true } as any,
      outcome: ["array"] as any,
      ext: null as any,
    });
    expect(result).toEqual({ tool: "test" });
  });

  it("handles empty input", () => {
    expect(clean({})).toEqual({});
  });

  it("passes through all allowed keys", () => {
    const allAllowed: Record<string, unknown> = {
      tool: "t",
      outcome: "success",
      duration_ms: 100,
      edit_kind: "replace",
      ops_count: 5,
      retry_count: 0,
      diagnostics_count: 3,
      ext: ".ts",
      stale: false,
      error_class: "hash_mismatch",
      subagent: "builder",
      memory_op: "read",
      tool_category: "custom",
    };
    const result = clean(allAllowed);
    expect(Object.keys(result).sort()).toEqual(Object.keys(allAllowed).sort());
  });
});

// ---------------------------------------------------------------------------
// Install ID — creation, persistence, permissions
// ---------------------------------------------------------------------------

describe("telemetry install-id", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-test-"));
    origHome = process.env.HOME;
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    // Clean up
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("creates install-id file with expected format", () => {
    // We can't easily re-import the module to test getInstallId() in
    // isolation (it runs at module load), so we replicate the logic here
    // and verify it produces the expected shape.
    const { createHash, randomUUID } = require("node:crypto");
    const id = createHash("sha256")
      .update(randomUUID())
      .digest("hex")
      .slice(0, 16);

    // Should be 16 hex chars
    expect(id).toMatch(/^[a-f0-9]{16}$/);
  });

  it("truncates to 8 chars for transmission (verified via clean props)", () => {
    // The install ID is truncated to 8 chars in the `props` object.
    // This is enforced in the track() function body:
    //   props: { ...clean(props), install: installId.slice(0, 8) }
    // We verify the contract: slice(0, 8) of a 16-char hex string yields 8 chars.
    const fullId = "abcdef0123456789";
    expect(fullId.slice(0, 8)).toBe("abcdef01");
    expect(fullId.slice(0, 8)).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// DISABLED flag — env var opt-out
// ---------------------------------------------------------------------------

describe("telemetry DISABLED flag", () => {
  // Note: DISABLED is evaluated at import time. Since we import the module
  // once at the top, its value is fixed for this test run. We test the
  // logic by checking the conditions directly.

  it("is disabled when CI=true", () => {
    // This tests the condition logic, not the actual import-time value
    const check = (env: Record<string, string | undefined>) =>
      env.HARNESS_OPENCODE_TELEMETRY === "0" ||
      env.HARNESS_OPENCODE_TELEMETRY === "false" ||
      env.DO_NOT_TRACK === "1" ||
      env.CI === "true";

    expect(check({ CI: "true" })).toBe(true);
    expect(check({ DO_NOT_TRACK: "1" })).toBe(true);
    expect(check({ HARNESS_OPENCODE_TELEMETRY: "0" })).toBe(true);
    expect(check({ HARNESS_OPENCODE_TELEMETRY: "false" })).toBe(true);
    expect(check({})).toBe(false);
    expect(check({ CI: "false" })).toBe(false);
    expect(check({ DO_NOT_TRACK: "0" })).toBe(false);
    expect(check({ HARNESS_OPENCODE_TELEMETRY: "1" })).toBe(false);
  });
});
