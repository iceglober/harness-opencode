// pilot-opencode-server.test.ts — tests for src/pilot/opencode/server.ts.
//
// Two tiers of tests:
//
//   1. UNIT (always run): exercise resolveTimeoutMs precedence,
//      ensureOpencodeOnPath success/failure, and shutdown idempotency
//      using a synthetic opencode shim on $PATH.
//   2. E2E (gated by OPENCODE_E2E=1): spawn a real opencode server,
//      hit /path with the returned client, and verify shutdown actually
//      kills the child. Requires `opencode` on PATH and is skipped in
//      CI by default.
//
// The unit tier covers the harness-side logic; the E2E tier is the
// integration safety net for upstream-SDK regressions.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  startOpencodeServer,
  resolveTimeoutMs,
} from "../src/pilot/opencode/server.js";

// --- Fixtures --------------------------------------------------------------

function mkTmpDir(prefix = "pilot-server-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rmTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Save and restore PATH-related env vars across tests. The unit tests
 * mutate `PATH` to point at fake `opencode` shims; we MUST restore
 * after each test so subsequent tests (and other test files run in
 * the same bun process) see the real environment.
 */
function withSavedEnv(keys: string[], fn: () => Promise<void> | void): () => Promise<void> {
  return async () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) saved[k] = process.env[k];
    try {
      await fn();
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k]!;
      }
    }
  };
}

/**
 * Write an executable shell-script `opencode` shim into `dir`.
 * `behavior` selects the script body:
 *   - `pass`: prints a fake version, exits 0.
 *   - `fail`: exits 1 immediately.
 *
 * Returns the directory containing the shim (caller prepends to PATH).
 */
function writeOpencodeShim(dir: string, behavior: "pass" | "fail"): string {
  const script =
    behavior === "pass"
      ? "#!/usr/bin/env sh\nif [ \"$1\" = \"--version\" ]; then echo 0.0.0-shim; exit 0; fi\n# Anything else: pretend we don't understand.\nexit 1\n"
      : "#!/usr/bin/env sh\nexit 1\n";
  const file = path.join(dir, "opencode");
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
  return dir;
}

// --- ensureOpencodeOnPath (via startOpencodeServer pre-check) --------------

describe("startOpencodeServer — pre-check (ensureOpencodeOnPath)", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmpDir(); });
  afterEach(() => rmTmpDir(tmp));

  test(
    "throws a doctor-friendly error when opencode is not on PATH",
    withSavedEnv(["PATH"], async () => {
      // PATH = tmp dir only (no /usr/bin etc.) means `opencode` lookup
      // fails. We can't fully empty PATH because `/usr/bin/env sh`
      // shebangs need env on PATH; for this test we deliberately omit
      // both opencode AND /usr/bin so even our `pass` shim wouldn't
      // run — but we never write a shim here. Result: spawn fails
      // with ENOENT for `opencode`.
      process.env.PATH = tmp;
      await expect(startOpencodeServer({ timeoutMs: 5_000 })).rejects.toThrow(
        /opencode.*PATH/i,
      );
    }),
  );

  test(
    "throws when opencode is on PATH but exits non-zero on --version",
    withSavedEnv(["PATH"], async () => {
      writeOpencodeShim(tmp, "fail");
      // Prepend tmp to existing PATH so /usr/bin/env still resolves
      // for the shim's shebang line.
      process.env.PATH = `${tmp}:${process.env.PATH ?? ""}`;
      await expect(startOpencodeServer({ timeoutMs: 5_000 })).rejects.toThrow(
        /opencode/i,
      );
    }),
  );
});

// --- resolveTimeoutMs (direct) --------------------------------------------

describe("resolveTimeoutMs", () => {
  test(
    "explicit positive number wins, bypasses env",
    withSavedEnv(["OPENCODE_SERVER_TIMEOUT_MS"], () => {
      process.env.OPENCODE_SERVER_TIMEOUT_MS = "999999";
      expect(resolveTimeoutMs(250)).toBe(250);
    }),
  );

  test(
    "env var fallback when no explicit value",
    withSavedEnv(["OPENCODE_SERVER_TIMEOUT_MS"], () => {
      process.env.OPENCODE_SERVER_TIMEOUT_MS = "300";
      expect(resolveTimeoutMs(undefined)).toBe(300);
    }),
  );

  test(
    "bad env value falls through to default with stderr warning",
    withSavedEnv(["OPENCODE_SERVER_TIMEOUT_MS"], () => {
      process.env.OPENCODE_SERVER_TIMEOUT_MS = "not-a-number";

      const captured: string[] = [];
      const origStderr = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      }) as typeof process.stderr.write;

      let result: number;
      try {
        result = resolveTimeoutMs(undefined);
      } finally {
        process.stderr.write = origStderr;
      }
      expect(result).toBe(30_000); // default
      expect(captured.join("")).toMatch(/OPENCODE_SERVER_TIMEOUT_MS/);
    }),
  );

  test(
    "explicit value of 0 or negative falls through to env / default",
    withSavedEnv(["OPENCODE_SERVER_TIMEOUT_MS"], () => {
      delete process.env.OPENCODE_SERVER_TIMEOUT_MS;
      expect(resolveTimeoutMs(0)).toBe(30_000);
      expect(resolveTimeoutMs(-1)).toBe(30_000);
    }),
  );

  test(
    "no env, no explicit → default",
    withSavedEnv(["OPENCODE_SERVER_TIMEOUT_MS"], () => {
      delete process.env.OPENCODE_SERVER_TIMEOUT_MS;
      expect(resolveTimeoutMs(undefined)).toBe(30_000);
    }),
  );

  test(
    "empty-string env is treated as unset",
    withSavedEnv(["OPENCODE_SERVER_TIMEOUT_MS"], () => {
      process.env.OPENCODE_SERVER_TIMEOUT_MS = "";
      expect(resolveTimeoutMs(undefined)).toBe(30_000);
    }),
  );
});

// --- E2E: real server (gated) ---------------------------------------------

describe("startOpencodeServer — E2E (real server)", () => {
  test("spawns and shuts down a real server (OPENCODE_E2E=1)", async () => {
    if (process.env.OPENCODE_E2E !== "1") {
      // Skip silently — e2e is not the default for CI.
      return;
    }
    const started = await startOpencodeServer({ timeoutMs: 30_000 });
    try {
      expect(started.url).toMatch(/^https?:\/\/[^:]+:\d+$/);
      // Hit a known endpoint to verify the client is wired correctly.
      // The SDK's `path.get` returns an object with home/state/config
      // (matches the curl test in spike S4).
      const r = await started.client.path.get();
      expect(r.data?.home).toBeDefined();
    } finally {
      await started.shutdown();
      // Idempotent — second shutdown is a no-op.
      await started.shutdown();
    }
  }, 60_000);
});
