/**
 * Fixture-based tests for src/cli/merge-config.ts.
 * Ports the 6 scenarios from test/merge-opencode-json.sh + adds scenario 7
 * (hashline-preserved).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mergeConfig, seedConfig } from "../src/cli/merge-config.js";

const FIXTURES = path.join(import.meta.dir, "fixtures", "merge-config");
const SRC_JSON = JSON.parse(fs.readFileSync(path.join(FIXTURES, "src.json"), "utf8"));

function loadFixture(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-config-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeDst(content: any): string {
  const p = path.join(tmpDir, "opencode.json");
  fs.writeFileSync(p, JSON.stringify(content, null, 2) + "\n");
  return p;
}

describe("merge-config", () => {
  it("scenario-1-vanilla: missing keys are added", () => {
    const input = loadFixture("scenario-1-vanilla.input");
    const expected = loadFixture("scenario-1-vanilla.expected");
    const dstPath = writeDst(input);

    const result = mergeConfig(SRC_JSON, dstPath);
    expect(result.changed).toBe(true);

    const actual = JSON.parse(fs.readFileSync(dstPath, "utf8"));
    expect(actual).toEqual(expected);

    // Backup created
    const baks = fs.readdirSync(tmpDir).filter((f) => f.includes(".bak."));
    expect(baks.length).toBe(1);

    // No tempfile debris
    const tmps = fs.readdirSync(tmpDir).filter((f) => f.includes(".merge.tmp."));
    expect(tmps.length).toBe(0);
  });

  it("scenario-2-heavily-customized: user keys preserved, missing keys added", () => {
    const input = loadFixture("scenario-2-heavily-customized.input");
    const expected = loadFixture("scenario-2-heavily-customized.expected");
    const dstPath = writeDst(input);

    const result = mergeConfig(SRC_JSON, dstPath);
    expect(result.changed).toBe(true);

    const actual = JSON.parse(fs.readFileSync(dstPath, "utf8"));
    expect(actual).toEqual(expected);
  });

  it("scenario-3-has-external-directory-object: object deep-merged", () => {
    const input = loadFixture("scenario-3-has-external-directory-object.input");
    const expected = loadFixture("scenario-3-has-external-directory-object.expected");
    const dstPath = writeDst(input);

    const result = mergeConfig(SRC_JSON, dstPath);
    expect(result.changed).toBe(true);

    const actual = JSON.parse(fs.readFileSync(dstPath, "utf8"));
    expect(actual).toEqual(expected);
  });

  it("scenario-4-scalar-collision: scalar wins, warning emitted, other keys still merge", () => {
    const input = loadFixture("scenario-4-scalar-collision.input");
    const expected = loadFixture("scenario-4-scalar-collision.expected");
    const dstPath = writeDst(input);

    const result = mergeConfig(SRC_JSON, dstPath);
    // Scalar collision + other additions → changed=true
    expect(result.changed).toBe(true);
    expect(result.warnings.some((w) => w.includes("WARN: scalar-vs-object"))).toBe(true);

    const actual = JSON.parse(fs.readFileSync(dstPath, "utf8"));
    expect(actual).toEqual(expected);
  });

  it("scenario-5-malformed: throws on invalid JSON, no write", () => {
    const dstPath = path.join(tmpDir, "opencode.json");
    fs.writeFileSync(dstPath, "{ invalid json }");

    expect(() => mergeConfig(SRC_JSON, dstPath)).toThrow(/invalid JSON/i);

    // File unchanged
    expect(fs.readFileSync(dstPath, "utf8")).toBe("{ invalid json }");
    // No backup
    const baks = fs.readdirSync(tmpDir).filter((f) => f.includes(".bak."));
    expect(baks.length).toBe(0);
  });

  it("scenario-6-old-memory-block: no additions needed → changed=false", () => {
    const input = loadFixture("scenario-6-old-memory-block.input");
    const dstPath = writeDst(input);
    const originalContent = fs.readFileSync(dstPath, "utf8");

    const result = mergeConfig(SRC_JSON, dstPath);
    expect(result.changed).toBe(false);

    // File unchanged
    expect(fs.readFileSync(dstPath, "utf8")).toBe(originalContent);
    // No backup
    const baks = fs.readdirSync(tmpDir).filter((f) => f.includes(".bak."));
    expect(baks.length).toBe(0);
  });

  it("scenario-7-hashline-preserved: opencode-hashline in plugin array is preserved when we add our entry", () => {
    const input = {
      "$schema": "https://opencode.ai/config.json",
      plugin: ["opencode-hashline"],
    };
    const dstPath = writeDst(input);

    const srcWithOurPlugin = {
      ...SRC_JSON,
      plugin: ["@glrs-dev/harness-opencode"],
    };

    const result = mergeConfig(srcWithOurPlugin, dstPath);
    expect(result.changed).toBe(true);

    const actual = JSON.parse(fs.readFileSync(dstPath, "utf8"));
    // Both plugins present
    expect(actual.plugin).toContain("opencode-hashline");
    expect(actual.plugin).toContain("@glrs-dev/harness-opencode");
    // Order: existing first, new appended
    expect(actual.plugin[0]).toBe("opencode-hashline");
  });

  it("dry-run: returns changed=true with bakPath='(dry-run)' but does not write", () => {
    const input = loadFixture("scenario-1-vanilla.input");
    const dstPath = writeDst(input);
    const originalContent = fs.readFileSync(dstPath, "utf8");

    const result = mergeConfig(SRC_JSON, dstPath, true);
    expect(result.changed).toBe(true);
    if (result.changed) {
      expect(result.bakPath).toBe("(dry-run)");
    }

    // File unchanged
    expect(fs.readFileSync(dstPath, "utf8")).toBe(originalContent);
    // No backup
    const baks = fs.readdirSync(tmpDir).filter((f) => f.includes(".bak."));
    expect(baks.length).toBe(0);
  });

  it("seedConfig: creates file with content when dst does not exist", () => {
    const dstPath = path.join(tmpDir, "new-dir", "opencode.json");
    const content = { plugin: ["@glrs-dev/harness-opencode"] };

    seedConfig(content as any, dstPath);

    expect(fs.existsSync(dstPath)).toBe(true);
    const actual = JSON.parse(fs.readFileSync(dstPath, "utf8"));
    expect(actual).toEqual(content);
  });
});
