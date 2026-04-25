/**
 * Regression test: `install --pin` writes the actual package.json version,
 * not a stale hardcoded constant.
 *
 * History: install.ts originally held a `const PACKAGE_VERSION = "0.1.0"`
 * with a `// updated by release pipeline` comment. The release pipeline
 * never actually updated it, so `--pin` injected a phantom version that
 * didn't match any published artifact. Fix: read the version from
 * package.json at runtime.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { install } from "../src/cli/install.ts";

const ROOT = path.join(import.meta.dir, "..");

function readPackageVersion(): string {
  const raw = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
  return JSON.parse(raw).version as string;
}

describe("install --pin version sync", () => {
  it("reads version from package.json (no hardcoded constant drift)", () => {
    // The source MUST NOT contain a hardcoded version literal matching
    // `PACKAGE_VERSION = "x.y.z"`. If someone reintroduces one it'll go
    // stale again.
    const src = fs.readFileSync(
      path.join(ROOT, "src/cli/install.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/const\s+PACKAGE_VERSION\s*=\s*["']\d/);
  });

  it("install({ pin: true, dryRun: true }) logs the live package.json version", async () => {
    const expectedVersion = readPackageVersion();

    // Redirect console so dry-run output is capturable.
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    // The install function reads ~/.config/opencode/opencode.json. In CI
    // this path may not exist; seed a tmp XDG_CONFIG_HOME so we don't
    // depend on the developer's local config.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-install-"));
    const prevXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = tmpHome;

    try {
      await install({ pin: true, dryRun: true });
    } finally {
      console.log = origLog;
      if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = prevXdg;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }

    const joined = logs.join("\n");
    expect(joined).toContain(`@glrs-dev/harness-opencode@${expectedVersion}`);
  });
});
