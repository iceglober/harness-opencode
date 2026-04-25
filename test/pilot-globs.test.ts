// pilot-globs.test.ts — coverage of src/pilot/plan/globs.ts.
//
// All cases listed in PILOT_TODO.md A4 plus a handful of sanity checks
// that lock in the spike's findings.
//
// Pure function tests — no fixture files needed.

import { describe, test, expect } from "bun:test";
import {
  globsConflict,
  validateTouchSet,
  findTouchConflicts,
} from "../src/pilot/plan/globs.js";

// --- globsConflict ---------------------------------------------------------

describe("globsConflict — PILOT_TODO test cases", () => {
  test("identical globs conflict", () => {
    expect(globsConflict(["src/**"], ["src/**"])).toBe(true);
  });

  test("src/** vs src/api/** conflict (subset)", () => {
    expect(globsConflict(["src/**"], ["src/api/**"])).toBe(true);
  });

  test("src/api/** vs src/web/** do NOT conflict (disjoint subdirs)", () => {
    expect(globsConflict(["src/api/**"], ["src/web/**"])).toBe(false);
  });

  test("**/*.test.ts vs src/foo.ts do NOT conflict (test glob vs non-test file)", () => {
    expect(globsConflict(["**/*.test.ts"], ["src/foo.ts"])).toBe(false);
  });

  test("empty `touches` never conflicts (lhs empty)", () => {
    expect(globsConflict([], ["src/**"])).toBe(false);
  });

  test("empty `touches` never conflicts (rhs empty)", () => {
    expect(globsConflict(["src/**"], [])).toBe(false);
  });

  test("both empty → no conflict", () => {
    expect(globsConflict([], [])).toBe(false);
  });
});

describe("globsConflict — additional cases", () => {
  test("identical concrete files conflict", () => {
    expect(globsConflict(["src/foo.ts"], ["src/foo.ts"])).toBe(true);
  });

  test("two distinct concrete files do not conflict", () => {
    expect(globsConflict(["src/foo.ts"], ["src/bar.ts"])).toBe(false);
  });

  test("disjoint top-level dirs do not conflict", () => {
    expect(globsConflict(["docs/**"], ["src/**"])).toBe(false);
  });

  test("**/*.test.ts vs src/foo.test.ts conflicts (test glob captures matching file)", () => {
    expect(globsConflict(["**/*.test.ts"], ["src/foo.test.ts"])).toBe(true);
  });

  test("multiple globs on either side — any pair matching = conflict", () => {
    expect(
      globsConflict(["docs/**", "src/api/**"], ["src/web/**", "src/api/v1.ts"]),
    ).toBe(true);
  });

  test("multiple disjoint globs on both sides do not conflict", () => {
    expect(
      globsConflict(["docs/**", "examples/**"], ["src/**", "test/**"]),
    ).toBe(false);
  });

  test("dotfile glob matches dotfiles (dot:true)", () => {
    // .gitignore vs **/* should conflict (.gitignore is a dotfile that
    // **/* should match because dot:true).
    expect(globsConflict([".gitignore"], ["**"])).toBe(true);
  });

  test("nested glob in glob (src/**/*.ts vs src/foo/bar.ts)", () => {
    expect(globsConflict(["src/**/*.ts"], ["src/foo/bar.ts"])).toBe(true);
  });
});

// --- validateTouchSet ------------------------------------------------------

describe("validateTouchSet", () => {
  test("ok: empty list", () => {
    expect(validateTouchSet([])).toEqual({ ok: true });
  });

  test("ok: simple globs", () => {
    expect(
      validateTouchSet(["src/**", "test/**/*.test.ts", "docs/foo.md"]),
    ).toEqual({ ok: true });
  });

  test("ok: brace expansion (well-formed)", () => {
    expect(validateTouchSet(["src/{api,web}/**"])).toEqual({ ok: true });
  });

  test("ok: character class (well-formed)", () => {
    expect(validateTouchSet(["src/[abc]/foo.ts"])).toEqual({ ok: true });
  });
});

// --- findTouchConflicts ----------------------------------------------------

describe("findTouchConflicts", () => {
  test("returns empty for tasks with disjoint touches", () => {
    expect(
      findTouchConflicts([
        { id: "T1", touches: ["src/api/**"] },
        { id: "T2", touches: ["src/web/**"] },
        { id: "T3", touches: ["docs/**"] },
      ]),
    ).toEqual([]);
  });

  test("flags overlapping pair", () => {
    expect(
      findTouchConflicts([
        { id: "T1", touches: ["src/**"] },
        { id: "T2", touches: ["src/api/**"] },
      ]),
    ).toEqual([{ a: "T1", b: "T2" }]);
  });

  test("flags multiple overlapping pairs", () => {
    const conflicts = findTouchConflicts([
      { id: "T1", touches: ["src/**"] },
      { id: "T2", touches: ["src/api/**"] },
      { id: "T3", touches: ["src/web/**"] },
    ]);
    // T1 conflicts with both T2 and T3. T2 and T3 are disjoint.
    expect(conflicts).toHaveLength(2);
    expect(conflicts).toContainEqual({ a: "T1", b: "T2" });
    expect(conflicts).toContainEqual({ a: "T1", b: "T3" });
  });

  test("does NOT report (b, a) when (a, b) is reported (deduped)", () => {
    const conflicts = findTouchConflicts([
      { id: "T1", touches: ["src/**"] },
      { id: "T2", touches: ["src/api/**"] },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual({ a: "T1", b: "T2" });
  });

  test("respects declaration order — earlier id is `a`", () => {
    const conflicts = findTouchConflicts([
      { id: "Z", touches: ["src/**"] },
      { id: "A", touches: ["src/api/**"] },
    ]);
    expect(conflicts[0]).toEqual({ a: "Z", b: "A" });
  });

  test("empty-touches tasks never appear in conflicts", () => {
    const conflicts = findTouchConflicts([
      { id: "T1", touches: [] },
      { id: "T2", touches: ["src/**"] },
    ]);
    expect(conflicts).toEqual([]);
  });

  test("single task never conflicts with itself", () => {
    const conflicts = findTouchConflicts([
      { id: "T1", touches: ["src/**"] },
    ]);
    expect(conflicts).toEqual([]);
  });
});
