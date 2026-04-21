/**
 * Regression test: install.sh is the redirect stub (not the old installer),
 * and update.sh / uninstall.sh are deleted.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(import.meta.dir, "..");

describe("no-install-sh", () => {
  it("update.sh does not exist", () => {
    expect(fs.existsSync(path.join(ROOT, "update.sh"))).toBe(false);
  });

  it("uninstall.sh does not exist", () => {
    expect(fs.existsSync(path.join(ROOT, "uninstall.sh"))).toBe(false);
  });

  it("install.sh is the redirect stub (≤15 lines, contains migration URL, contains exit 0)", () => {
    const installPath = path.join(ROOT, "install.sh");
    expect(fs.existsSync(installPath)).toBe(true);

    const content = fs.readFileSync(installPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");

    // Structural checks (not byte-exact hash — trailing-whitespace resilient)
    expect(content.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(content).toContain("exit 0");
    expect(content).toContain("glorious-opencode");
    expect(lines.length).toBeLessThanOrEqual(15);
  });
});
