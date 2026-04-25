# S5 — Picomatch glob intersection

**Question:** Prototype `globsConflict(globsA, globsB)` for the v0.3 worktree-pool conflict scheduler. Pick an implementation strategy.

**Verdict:** **Probe-based bidirectional matching works.** All 10 plan-cited test cases pass. Acceptable false-positive rate for a curated `pilot.yaml`.

## Strategy

Pure picomatch — no filesystem touched. For each glob in either set, generate
"probe" paths from its literal prefix (and a few synthetic deep paths for
`**`-suffixed globs), then test each probe against both compiled matchers.
Two globs conflict iff at least one probe matches both.

```ts
import picomatch from "picomatch";

function probesFromGlob(g: string): string[] {
  const probes = new Set<string>([g]);
  const literalPrefix = g.replace(/[*?{[].*$/, "").replace(/\/$/, "");
  if (literalPrefix.length > 0) {
    probes.add(literalPrefix);
    probes.add(literalPrefix + "/file.ts");
    probes.add(literalPrefix + "/sub/dir/file.ts");
    probes.add(literalPrefix + "/foo.test.ts");
  }
  if (g.endsWith("/**") || g.endsWith("**")) {
    probes.add(g.replace(/\*\*$/, "deep/file.ts"));
  }
  return [...probes];
}

export function globsConflict(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const matchA = picomatch(a, { dot: true });
  const matchB = picomatch(b, { dot: true });
  for (const g of [...a, ...b]) {
    for (const probe of probesFromGlob(g)) {
      if (matchA(probe) && matchB(probe)) return true;
    }
  }
  return false;
}
```

## Test results

Run via `bun spike.ts` against picomatch 4.0.4. All 10 cases from the plan
passed:

```
PASS  identical: true
PASS  src/** vs src/api/** (subset): true
PASS  disjoint subdirs: false
PASS  test glob vs src file: false
PASS  test glob vs matching test file: true
PASS  empty allowed never conflicts: false
PASS  empty allowed (b) never conflicts: false
PASS  two distinct files: false
PASS  identical file: true
PASS  disjoint top-level dirs: false

10/10 passed
```

## False-positive analysis

The strategy produces conservative results — it errs toward "conflict" when
the probe set happens to land inside both globs. Examples that will yield
false positives in the final code:

- `src/api/v1/**` vs `src/api/v2/**`: both match the probe `src/api/`-derived
  paths if probes happen to land in either subtree. v0.1 tolerates this:
  serializing two non-conflicting tasks costs latency, not correctness.

For v0.3 (parallel scheduling), if false-positive serialization becomes a
real bottleneck, escalate to a proper formal-language intersection
algorithm (e.g. converting globs to regex automata and computing language
intersection emptiness). Don't do that now.

## False-negative analysis

The strategy is sound for v0.1's expected glob shapes (directory prefixes
ending in `/**`, single files, simple wildcards). It could miss conflicts
if an exotic glob (e.g. `src/{api,web}/**/foo.{ts,tsx}`) happens to share
an actual matching path that no probe lands on. This is theoretical for the
expected `touches:` field shape; the schema (Phase A4) can lock down the
allowed glob grammar to keep probe coverage exhaustive.

## Action items for Phase A4

1. Add `picomatch` and `@types/picomatch` to runtime deps.
2. `src/pilot/plan/globs.ts` implements `globsConflict` and `validateTouchSet`
   per the spike code above.
3. Test file `test/pilot-globs.test.ts` covers the 10 cases listed.
4. Consider a `validateGlobShape` that rejects truly exotic patterns (brace
   expansions with multiple alternatives, character classes inside path
   segments) until v0.3 needs them.
