// pilot-plan-slug.test.ts — unit tests for src/pilot/plan/slug.ts.
//
// Covers all four input shapes called out in PILOT_TODO.md A2:
//   - Linear ID
//   - Linear project (treated as free-form — Linear projects don't have
//     a canonical URL or stable ID we'd recognize, so we don't special-case them)
//   - GitHub URL/issue
//   - Free-form input
// Plus collision suffixing and edge cases (empty input, only-special-chars).
//
// Pure function tests — no filesystem.

import { describe, test, expect } from "bun:test";
import { deriveSlug, resolveUniqueSlug } from "../src/pilot/plan/slug.js";

// --- Linear-style IDs ------------------------------------------------------

describe("deriveSlug — Linear-style IDs", () => {
  test("lowercases ENG-1234 verbatim", () => {
    expect(deriveSlug("ENG-1234")).toBe("eng-1234");
  });

  test("lowercases multi-segment team prefix (BACKEND-7)", () => {
    expect(deriveSlug("BACKEND-7")).toBe("backend-7");
  });

  test("accepts mixed-digit team prefix (M3-99)", () => {
    expect(deriveSlug("M3-99")).toBe("m3-99");
  });

  test("rejects lowercase 'eng-1234' as a Linear ID (falls through to free-form)", () => {
    // eng-1234 is already kebab-case; the slugifier just lowercases. It
    // does NOT match the strict-uppercase Linear pattern, so the path it
    // takes is the free-form one. End result is the same lowercase string.
    expect(deriveSlug("eng-1234")).toBe("eng-1234");
  });

  test("rejects ID with too short prefix (single letter team like 'A-1' is OK; '-1' is not)", () => {
    expect(deriveSlug("A-1")).toBe("a-1");
  });

  test("rejects ID without trailing digits (falls through to free-form)", () => {
    // "ENG-XYZ" has the right shape minus the digits — falls through.
    // Free-form output: "eng-xyz".
    expect(deriveSlug("ENG-XYZ")).toBe("eng-xyz");
  });

  test("does NOT accept full sentence containing a Linear-shaped substring", () => {
    // The Linear regex is anchored, so this falls to free-form.
    expect(deriveSlug("fix ENG-1234 properly")).toBe("fix-eng-1234-properly");
  });
});

// --- GitHub URLs -----------------------------------------------------------

describe("deriveSlug — GitHub URLs", () => {
  test("issues URL → '<repo>-issue-<n>'", () => {
    expect(
      deriveSlug("https://github.com/anomalyco/opencode/issues/42"),
    ).toBe("opencode-issue-42");
  });

  test("pulls URL → '<repo>-pr-<n>'", () => {
    expect(
      deriveSlug("https://github.com/anomalyco/harness-opencode/pull/123"),
    ).toBe("harness-opencode-pr-123");
  });

  test("github.com without protocol still matches", () => {
    expect(deriveSlug("github.com/owner/foo-bar/issues/7")).toBe(
      "foo-bar-issue-7",
    );
  });

  test("repo name with non-alphanumeric chars is kebab-cased", () => {
    expect(
      deriveSlug("https://github.com/owner/My_Cool.Repo/issues/1"),
    ).toBe("my-cool-repo-issue-1");
  });

  test("case-insensitive 'Pull' / 'Issues'", () => {
    expect(
      deriveSlug("https://github.com/o/r/Issues/5"),
    ).toBe("r-issue-5");
    expect(
      deriveSlug("https://github.com/o/r/Pull/5"),
    ).toBe("r-pr-5");
  });

  test("non-issue-or-pull github URL falls through to free-form", () => {
    // /tree/<branch> is neither issues nor pull — free-form.
    const slug = deriveSlug("https://github.com/owner/repo/tree/main");
    expect(slug).toMatch(/github-com-owner-repo-tree-main/);
  });
});

// --- Free-form text --------------------------------------------------------

describe("deriveSlug — free-form text", () => {
  test("kebab-cases a sentence", () => {
    expect(deriveSlug("Add user authentication")).toBe(
      "add-user-authentication",
    );
  });

  test("collapses runs of separators", () => {
    expect(deriveSlug("foo  --  bar___baz")).toBe("foo-bar-baz");
  });

  test("strips leading and trailing separators", () => {
    expect(deriveSlug("  ---hello---  ")).toBe("hello");
  });

  test("handles unicode by stripping (ASCII-only output)", () => {
    expect(deriveSlug("Café résumé naïveté")).toBe("caf-r-sum-na-vet");
  });

  test("truncates very long inputs to ~50 chars", () => {
    const input =
      "this is a very long title that goes on and on and on and on and beyond";
    const slug = deriveSlug(input);
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug).toMatch(/^this-is-a-very-long-title/);
    // No trailing dash from a mid-word boundary.
    expect(slug.endsWith("-")).toBe(false);
  });

  test("handles all-numeric input", () => {
    expect(deriveSlug("12345")).toBe("12345");
  });

  test("handles input that becomes a single character after kebab-case", () => {
    expect(deriveSlug("a!@#")).toBe("a");
  });
});

// --- Edge cases ------------------------------------------------------------

describe("deriveSlug — edge cases", () => {
  test("throws on empty string", () => {
    expect(() => deriveSlug("")).toThrow(/empty/);
  });

  test("throws on whitespace-only input", () => {
    expect(() => deriveSlug("    ")).toThrow(/empty/);
  });

  test("throws on input with no slug-safe characters", () => {
    expect(() => deriveSlug("!@#$%")).toThrow(/no slug-safe/);
  });

  test("throws on non-string input", () => {
    // @ts-expect-error testing runtime behavior with bad input
    expect(() => deriveSlug(42)).toThrow(/string/);
    // @ts-expect-error testing runtime behavior with bad input
    expect(() => deriveSlug(null)).toThrow(/string/);
    // @ts-expect-error testing runtime behavior with bad input
    expect(() => deriveSlug(undefined)).toThrow(/string/);
  });
});

// --- resolveUniqueSlug -----------------------------------------------------

describe("resolveUniqueSlug", () => {
  test("returns base unchanged when not in the set", () => {
    expect(resolveUniqueSlug("foo", new Set())).toBe("foo");
    expect(resolveUniqueSlug("foo", new Set(["bar"]))).toBe("foo");
  });

  test("appends -2 when base is taken", () => {
    expect(resolveUniqueSlug("foo", new Set(["foo"]))).toBe("foo-2");
  });

  test("appends -3 when base AND -2 are taken", () => {
    expect(
      resolveUniqueSlug("foo", new Set(["foo", "foo-2"])),
    ).toBe("foo-3");
  });

  test("skips gaps — returns first free slot, not first integer", () => {
    // foo, foo-2, foo-3 all taken; foo-4 free → returns foo-4.
    expect(
      resolveUniqueSlug("foo", new Set(["foo", "foo-2", "foo-3"])),
    ).toBe("foo-4");
  });

  test("does not collide with similarly-prefixed but distinct slugs", () => {
    // "foo-bar" should not affect "foo".
    expect(resolveUniqueSlug("foo", new Set(["foo-bar", "foo-bar-2"]))).toBe(
      "foo",
    );
  });

  test("throws after 1000 collisions (sanity guard)", () => {
    const big = new Set<string>(["foo"]);
    for (let n = 2; n < 1000; n++) big.add(`foo-${n}`);
    expect(() => resolveUniqueSlug("foo", big)).toThrow(/1000/);
  });
});

// --- Integration: derive + resolve -----------------------------------------

describe("derive + resolve composition", () => {
  test("Linear ID stays stable; collisions get -2 suffix", () => {
    const base = deriveSlug("ENG-1234");
    expect(base).toBe("eng-1234");
    expect(resolveUniqueSlug(base, new Set(["eng-1234"]))).toBe("eng-1234-2");
  });

  test("free-form input collides cleanly", () => {
    const base = deriveSlug("Add user auth");
    expect(base).toBe("add-user-auth");
    expect(
      resolveUniqueSlug(base, new Set(["add-user-auth"])),
    ).toBe("add-user-auth-2");
  });

  test("github URL stays stable across calls", () => {
    const a = deriveSlug("https://github.com/o/r/issues/5");
    const b = deriveSlug("https://github.com/o/r/issues/5");
    expect(a).toBe(b);
  });
});
