/**
 * Glob conflict detection for `pilot.yaml` `touches:` fields.
 *
 * Each task's `touches` list declares which paths the builder agent is
 * permitted to modify. For v0.1 (single-worker), conflicts between two
 * tasks' touch sets are NOT a hard error — the worker runs tasks serially,
 * so even overlapping touches can't race. The module is shipped now
 * because:
 *
 *   1. `pilot validate` should call out overlap warnings — overlap is a
 *      smell ("two tasks edit the same files; should they be merged or
 *      sequenced?") even when the runtime accepts it.
 *   2. v0.3 introduces multi-worker parallelism; the worktree-pool
 *      scheduler will refuse to run two conflicting tasks concurrently.
 *      Same algorithm, different consumer.
 *
 * Strategy (per `docs/pilot/spikes/s5-picomatch-globs-conflict.md`):
 * Probe-based bidirectional matching using picomatch. For each glob in
 * either set, generate candidate file paths from its literal prefix
 * (and synthetic deep paths for `**`-suffixed globs), then test each
 * probe against both compiled matchers. Two glob sets conflict iff at
 * least one probe matches both.
 *
 * Properties:
 *   - **Deterministic.** Same input → same answer.
 *   - **Pure.** No filesystem, no network.
 *   - **Conservative.** Errs toward "conflict" for ambiguous patterns;
 *     false-positives become serialization in v0.3, never correctness
 *     bugs.
 *
 * Known limitations (acceptable for v0.1):
 *   - May miss conflicts on exotic globs (brace alternation, character
 *     classes inside path segments) where no probe lands on a shared
 *     concrete path. Schema (`schema.ts`) only checks syntactic
 *     non-emptiness; if v0.3's parallelism reveals real false-negatives,
 *     escalate to a glob-to-regex automata-intersection algorithm.
 *
 * Ship-checklist alignment: Phase A4 of `PILOT_TODO.md`.
 */

import picomatch from "picomatch";

// --- Internals -------------------------------------------------------------

/**
 * Generate "probe" paths likely to land inside the file set described by
 * a glob. The strategy:
 *
 *   1. The literal prefix of the glob (everything before the first
 *      wildcard char). This catches `src/api/**` ⊃ `src/api/foo.ts`.
 *   2. The literal prefix + `/file.ts` and similar synthetic leaves.
 *      Catches `src/**` ⊃ `src/anything`.
 *   3. The glob itself as a probe — a file whose path equals the glob
 *      string verbatim. Catches identical-glob conflicts cheaply.
 *   4. For `/**`-suffixed globs, replace the suffix with a synthetic
 *      deep path so we cover patterns like `src/**` ∩ `src/api/**`.
 *
 * The output is a `Set<string>` (deduped) of strings to feed to
 * picomatch matchers. Coverage is not exhaustive — see module doc.
 */
function probesFromGlob(g: string): Set<string> {
  const probes = new Set<string>();
  probes.add(g);

  // Strip everything from the first wildcard char (`*`, `?`, `{`, `[`)
  // onward. The result is the longest concrete prefix.
  const literalPrefix = g.replace(/[*?{[].*$/, "").replace(/\/$/, "");
  if (literalPrefix.length > 0) {
    probes.add(literalPrefix);
    probes.add(`${literalPrefix}/file.ts`);
    probes.add(`${literalPrefix}/sub/dir/file.ts`);
    probes.add(`${literalPrefix}/foo.test.ts`);
  }

  // For globs ending in `**`, also probe a synthetic deep path. This is
  // the case that catches `src/**` ⊃ `src/api/**`: probing `src/api/**`
  // against picomatch(`src/**`) returns true via the deep-path probe.
  if (g.endsWith("/**") || g.endsWith("**")) {
    probes.add(g.replace(/\*\*$/, "deep/file.ts"));
    probes.add(g.replace(/\*\*$/, "x/y/z.ts"));
  }

  return probes;
}

/**
 * picomatch options used everywhere in this module. Centralized so a
 * future change (e.g. enabling `nocase` for case-insensitive
 * filesystems) is a one-line edit.
 *
 * `dot: true` — don't ignore dotfiles. Plans may legitimately touch
 * `.gitignore`, `.env`, etc.
 */
const PICOMATCH_OPTS: picomatch.PicomatchOptions = { dot: true };

// --- Public API ------------------------------------------------------------

/**
 * Test whether two glob sets have a non-empty intersection. Returns
 * `true` if at least one probe path matches a glob in BOTH sets.
 *
 * Edge cases:
 *   - Either set empty → no intersection (empty set ∩ X = ∅).
 *   - Identical sets → trivially conflict (every glob matches itself).
 *
 * Use this when scheduling parallel tasks (v0.3) or when validating
 * `pilot.yaml` for unintentional touch-set overlap.
 */
export function globsConflict(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length === 0 || b.length === 0) return false;

  const matchA = picomatch([...a], PICOMATCH_OPTS);
  const matchB = picomatch([...b], PICOMATCH_OPTS);

  for (const g of [...a, ...b]) {
    for (const probe of probesFromGlob(g)) {
      if (matchA(probe) && matchB(probe)) return true;
    }
  }
  return false;
}

/**
 * Check the wellformedness of a single touches list. Returns the first
 * problem found, or null if the list is well-formed.
 *
 * The schema layer already enforces basic checks (non-empty strings, no
 * leading slash). This function adds runtime checks that picomatch can
 * actually compile each pattern — picomatch throws on a small number of
 * malformed inputs (unbalanced brace expansions, etc.) and we want to
 * catch that in `pilot validate` rather than at first-task-run time.
 */
export function validateTouchSet(
  touches: ReadonlyArray<string>,
):
  | { ok: true }
  | { ok: false; index: number; pattern: string; message: string } {
  for (let i = 0; i < touches.length; i++) {
    const pattern = touches[i]!;
    try {
      // Compiling once is enough; picomatch fails fast on truly
      // malformed inputs (e.g. `[abc`, `{x,y`).
      picomatch(pattern, PICOMATCH_OPTS);
    } catch (err) {
      return {
        ok: false,
        index: i,
        pattern,
        message:
          err instanceof Error
            ? err.message
            : `picomatch rejected pattern: ${String(err)}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Find every pair of conflicting (`taskA`, `taskB`) within a plan's
 * tasks. Returns an array of `{ a, b }` pairs (deduped — `(T1, T2)` and
 * `(T2, T1)` count as one). Pairs are reported in declaration order:
 * `a` is the earlier-declared task, `b` the later.
 *
 * Empty touches list ⇒ task can't conflict with anything (it can't edit
 * any files). Tasks with `depends_on` chains can still report a
 * conflict — that's deliberate: even when sequenced via deps, edits to
 * the same files are usually a smell worth surfacing.
 *
 * The CLI's `pilot validate` consumes this to print warnings; the v0.3
 * scheduler will consume it to refuse parallel scheduling.
 */
export function findTouchConflicts(
  tasks: ReadonlyArray<{ id: string; touches: ReadonlyArray<string> }>,
): Array<{ a: string; b: string }> {
  const conflicts: Array<{ a: string; b: string }> = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!;
      const b = tasks[j]!;
      if (globsConflict(a.touches, b.touches)) {
        conflicts.push({ a: a.id, b: b.id });
      }
    }
  }
  return conflicts;
}
