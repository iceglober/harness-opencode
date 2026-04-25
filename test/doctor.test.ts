// doctor.test.ts — smoke coverage for `bunx ... doctor`.
//
// The doctor function is mostly subprocess side effects + colorized
// console output. We capture stdout and assert on its presence/shape;
// the actual which/version subprocess outputs depend on the host so
// we don't pin them.
//
// New in this commit (Phase I3): the "Pilot subsystem" section that
// checks git worktree availability, bash, and the registered pilot
// agents. This file's primary purpose is to lock in those checks.

import { describe, test, expect } from "bun:test";
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
    expect(r.stdout).toMatch(/Pilot subsystem/);
  });

  test("checks for git", () => {
    const r = captured(() => doctor());
    // Either an OK or fail line for git should appear (depending on host).
    expect(r.stdout).toMatch(/git/);
  });

  test("checks for bash (verify-runner)", () => {
    const r = captured(() => doctor());
    expect(r.stdout).toMatch(/bash.*verify-runner|bash not found/i);
  });

  test("attempts pilot agent list check", () => {
    const r = captured(() => doctor());
    // Either we found the agents (ok), warned that they're missing,
    // or skipped (couldn't run `opencode agent list`).
    expect(r.stdout).toMatch(
      /pilot-builder|pilot-planner|skipping pilot agent registration check/,
    );
  });
});
