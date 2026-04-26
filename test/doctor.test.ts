// doctor.test.ts — smoke coverage for `bunx ... doctor`.
//
// The doctor function is mostly subprocess side effects + colorized
// console output. We capture stdout and assert on its presence/shape;
// the actual which/version subprocess outputs depend on the host so
// we don't pin them.
//
// New (this PR): model-override validation check. We drive this by
// pointing the doctor's config-path resolver at a temp dir via
// XDG_CONFIG_HOME and writing fixture opencode.json files into it.
// That path is the same the runtime resolver (`getOpencodeConfigPath`)
// uses, so the test exercises the real doctor code path end-to-end.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { doctor } from "../src/cli/doctor.js";

function captured(fn: () => void): { stdout: string; stderr: string } {
  const out: string[] = [];
  const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  // doctor uses console.log; that goes through process.stdout.
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    out.push(args.join(" ") + "\n");
  };
  process.stderr.write = ((c: string | Uint8Array): boolean => {
    err.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    console.log = origLog;
    process.stdout.write = o;
    process.stderr.write = e;
  }
  return { stdout: out.join(""), stderr: err.join("") };
}

describe("doctor", () => {
  test("runs without throwing and prints the harness section header", () => {
    const r = captured(() => doctor());
    expect(r.stdout).toMatch(/Doctor.*@glrs-dev\/harness-opencode/);
  });

  test("prints the Pilot subsystem section", () => {
    const r = captured(() => doctor());
    // Either we see the pilot agents registered, a warning that they're missing,
    // or skipped (couldn't run `opencode agent list`).
    expect(r.stdout).toMatch(
      /pilot-builder|pilot-planner|skipping pilot agent registration check/,
    );
  });
});

describe("doctor — model-override validation", () => {
  let tmpDir: string;
  let origXdg: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "harness-doctor-models-"),
    );
    fs.mkdirSync(path.join(tmpDir, "opencode"), { recursive: true });
    origXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = tmpDir;
  });

  afterEach(() => {
    if (origXdg === undefined) {
      delete process.env["XDG_CONFIG_HOME"];
    } else {
      process.env["XDG_CONFIG_HOME"] = origXdg;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(cfg: unknown): void {
    fs.writeFileSync(
      path.join(tmpDir, "opencode", "opencode.json"),
      JSON.stringify(cfg, null, 2),
    );
  }

  test("flags pre-#100 legacy bedrock IDs with fix hint", () => {
    writeConfig({
      plugin: [
        [
          "@glrs-dev/harness-opencode",
          {
            models: {
              deep: ["bedrock/claude-opus-4"],
              mid: ["bedrock/claude-sonnet-4"],
            },
          },
        ],
      ],
    });

    const r = captured(() => doctor());

    // One red-X line per bad entry.
    expect(r.stdout).toContain(
      "invalid model override at plugin options.models.deep",
    );
    expect(r.stdout).toContain("bedrock/claude-opus-4");
    expect(r.stdout).toContain(
      "invalid model override at plugin options.models.mid",
    );
    expect(r.stdout).toContain("bedrock/claude-sonnet-4");

    // Suggestion + remediation hint present for each.
    expect(r.stdout).toContain(
      "amazon-bedrock/global.anthropic.claude-opus-4-7",
    );
    expect(r.stdout).toContain(
      "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
    );
    expect(r.stdout).toContain("remove this key, or replace with");
  });

  test("prints green check when all overrides are valid", () => {
    writeConfig({
      plugin: [
        [
          "@glrs-dev/harness-opencode",
          {
            models: {
              deep: ["anthropic/claude-opus-4-7"],
              mid: ["anthropic/claude-sonnet-4-6"],
              fast: ["anthropic/claude-haiku-4-5-20251001"],
            },
          },
        ],
      ],
    });

    const r = captured(() => doctor());
    expect(r.stdout).toContain("model overrides look valid");
    expect(r.stdout).not.toMatch(/invalid model override/);
  });

  test("stays silent about models when no overrides are configured", () => {
    writeConfig({
      plugin: ["@glrs-dev/harness-opencode"],
    });

    const r = captured(() => doctor());
    // No green check, no red X — the models section isn't reached at all.
    expect(r.stdout).not.toContain("model overrides look valid");
    expect(r.stdout).not.toContain("invalid model override");
  });

  test("surfaces bad IDs in legacy top-level harness.models too", () => {
    writeConfig({
      plugin: ["@glrs-dev/harness-opencode"],
      harness: { models: { deep: ["bedrock/claude-opus-4"] } },
    });

    const r = captured(() => doctor());
    expect(r.stdout).toContain(
      "invalid model override at harness.models (legacy).deep",
    );
    expect(r.stdout).toContain("bedrock/claude-opus-4");
  });
});
