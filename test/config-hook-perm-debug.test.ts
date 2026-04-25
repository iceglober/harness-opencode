/**
 * Tests for the `HARNESS_OPENCODE_PERM_DEBUG` diagnostic probe.
 *
 * The probe writes a JSON snapshot of every agent's final permission
 * block to `$XDG_STATE_HOME/harness-opencode/perm-debug.json` (fallback
 * `~/.local/state/harness-opencode/perm-debug.json`) when the env var
 * equals `"1"`. It is silent and zero-overhead when the var is unset.
 *
 * These tests isolate the write target via `XDG_STATE_HOME` pointed at
 * a temp dir, so the real user's state dir is never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { applyConfig, writePermDebugSnapshot } from "../src/config-hook.js";

describe("HARNESS_OPENCODE_PERM_DEBUG probe", () => {
  let tempStateDir: string;
  let priorXdg: string | undefined;
  let priorDebug: string | undefined;

  beforeEach(() => {
    tempStateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "harness-perm-debug-test-"),
    );
    priorXdg = process.env["XDG_STATE_HOME"];
    priorDebug = process.env["HARNESS_OPENCODE_PERM_DEBUG"];
    process.env["XDG_STATE_HOME"] = tempStateDir;
  });

  afterEach(() => {
    if (priorXdg === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = priorXdg;
    if (priorDebug === undefined) delete process.env["HARNESS_OPENCODE_PERM_DEBUG"];
    else process.env["HARNESS_OPENCODE_PERM_DEBUG"] = priorDebug;
    try {
      fs.rmSync(tempStateDir, { recursive: true, force: true });
    } catch {}
  });

  it("perm-debug probe is silent when HARNESS_OPENCODE_PERM_DEBUG is unset", () => {
    delete process.env["HARNESS_OPENCODE_PERM_DEBUG"];
    const config: any = {};
    applyConfig(config);
    // No file should have been written.
    const expected = path.join(
      tempStateDir,
      "harness-opencode",
      "perm-debug.json",
    );
    expect(fs.existsSync(expected)).toBe(false);
  });

  it("perm-debug probe is silent when HARNESS_OPENCODE_PERM_DEBUG is set to a non-'1' value", () => {
    process.env["HARNESS_OPENCODE_PERM_DEBUG"] = "true";
    const config: any = {};
    applyConfig(config);
    const expected = path.join(
      tempStateDir,
      "harness-opencode",
      "perm-debug.json",
    );
    expect(fs.existsSync(expected)).toBe(false);
  });

  it("perm-debug probe writes a JSON snapshot when HARNESS_OPENCODE_PERM_DEBUG=1", () => {
    process.env["HARNESS_OPENCODE_PERM_DEBUG"] = "1";
    const config: any = {};
    applyConfig(config);
    const expected = path.join(
      tempStateDir,
      "harness-opencode",
      "perm-debug.json",
    );
    expect(fs.existsSync(expected)).toBe(true);
    const raw = fs.readFileSync(expected, "utf8");
    const parsed = JSON.parse(raw);
    expect(typeof parsed.timestamp).toBe("string");
    expect(typeof parsed.pluginVersion).toBe("string");
    expect(Array.isArray(parsed.agents)).toBe(true);
    expect(typeof parsed.agentPermissions).toBe("object");
    // Global permission block captured too.
    expect(parsed.globalPermission).not.toBeNull();
  });

  it("perm-debug snapshot includes qa-reviewer agent with permission.bash object", () => {
    process.env["HARNESS_OPENCODE_PERM_DEBUG"] = "1";
    const config: any = {};
    applyConfig(config);
    const expected = path.join(
      tempStateDir,
      "harness-opencode",
      "perm-debug.json",
    );
    const parsed = JSON.parse(fs.readFileSync(expected, "utf8"));
    expect(parsed.agents).toContain("qa-reviewer");
    const qrPerm = parsed.agentPermissions["qa-reviewer"];
    expect(qrPerm).toBeDefined();
    expect(qrPerm).not.toBeNull();
    expect(typeof qrPerm.bash).toBe("object");
    expect(qrPerm.bash["*"]).toBe("allow");
    // Pain-point entries must be present so the user can eyeball them.
    expect(qrPerm.bash["tail *"]).toBe("allow");
    expect(qrPerm.bash["pnpm lint *"]).toBe("allow");
    expect(qrPerm.bash["git merge-base *"]).toBe("allow");
    // Destructive denies still present.
    expect(qrPerm.bash["rm -rf /*"]).toBe("deny");
    expect(qrPerm.bash["sudo *"]).toBe("deny");
  });

  it("perm-debug snapshot includes prime with bash object-form", () => {
    process.env["HARNESS_OPENCODE_PERM_DEBUG"] = "1";
    const config: any = {};
    applyConfig(config);
    const parsed = JSON.parse(
      fs.readFileSync(
        path.join(tempStateDir, "harness-opencode", "perm-debug.json"),
        "utf8",
      ),
    );
    expect(parsed.agents).toContain("prime");
    const orchPerm = parsed.agentPermissions["prime"];
    expect(typeof orchPerm.bash).toBe("object");
    expect(orchPerm.bash["*"]).toBe("allow");
    expect(orchPerm.bash["git diff *"]).toBe("allow");
  });

  it("writePermDebugSnapshot swallows file-system errors (never breaks plugin startup)", () => {
    // Point XDG_STATE_HOME at a path we can't write to. The probe must
    // NOT throw — it's best-effort by design.
    process.env["HARNESS_OPENCODE_PERM_DEBUG"] = "1";
    process.env["XDG_STATE_HOME"] = "/nonexistent/read-only/path";
    const config: any = { agent: {} };
    // Must not throw.
    expect(() => writePermDebugSnapshot(config)).not.toThrow();
  });
});
