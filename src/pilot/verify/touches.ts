/**
 * Post-task touches enforcement.
 *
 * After a task's verify commands pass, the worker calls `enforceTouches`
 * to confirm the agent only edited files inside its declared `touches`
 * scope. Out-of-scope edits → mark task failed, preserve worktree for
 * inspection.
 *
 * This is the runtime counterpart to schema-level `touches:` validation
 * and `globsConflict` (`src/pilot/plan/globs.ts`). Schema validation
 * catches authoring mistakes; this catches agent mistakes.
 *
 * Algorithm:
 *
 *   1. Compute the diff names since `sinceSha` (`git.diffNamesSince`).
 *   2. Compile the allowed glob set with picomatch (dot:true).
 *   3. Any file path not matched by any allowed glob is a violation.
 *   4. Empty `allowed` + any diff = violation (the task is verify-only
 *      but the agent edited files anyway).
 *   5. No diff at all = ok (verify-only tasks pass cleanly).
 *
 * Why we don't use `globsConflict` here: that function tests whether
 * two GLOB SETS overlap (a probe-based approximation). Here we have
 * concrete file paths and need exact matching, which picomatch does
 * directly.
 *
 * Ship-checklist alignment: Phase C2 of `PILOT_TODO.md`.
 */

import picomatch from "picomatch";
import { diffNamesSince } from "../worktree/git.js";

// --- Public API ------------------------------------------------------------

export type TouchesResult =
  | { ok: true; changed: string[] }
  | { ok: false; changed: string[]; violators: string[] };

/**
 * Enforce that the changes in `worktree` since `sinceSha` only touched
 * files matched by `allowed` globs.
 *
 * `allowed` is the task's `touches` field (already schema-validated to
 * non-empty, repo-relative globs). An empty `allowed` array means "no
 * edits permitted".
 *
 * Returns:
 *   - `ok: true, changed` when zero violations (changed is the full
 *     change-set for the caller's logs).
 *   - `ok: false, changed, violators` when one or more files fall
 *     outside `allowed`. `violators` is a subset of `changed`.
 */
export async function enforceTouches(args: {
  worktree: string;
  sinceSha: string;
  allowed: ReadonlyArray<string>;
}): Promise<TouchesResult> {
  const changed = await diffNamesSince(args.worktree, args.sinceSha);
  if (changed.length === 0) {
    return { ok: true, changed: [] };
  }

  // Empty allowed + any diff = whole change-set is violations.
  if (args.allowed.length === 0) {
    return { ok: false, changed, violators: [...changed] };
  }

  const matchAllowed = picomatch([...args.allowed], { dot: true });
  const violators = changed.filter((p) => !matchAllowed(p));
  if (violators.length === 0) return { ok: true, changed };
  return { ok: false, changed, violators };
}

/**
 * Pure (no-fs) variant of `enforceTouches` that takes the change list
 * directly. Useful for unit tests and for the worker to apply the same
 * logic without a redundant `git diff` call (when it already has the
 * change list from a parallel inspection).
 */
export function enforceTouchesPure(args: {
  changed: ReadonlyArray<string>;
  allowed: ReadonlyArray<string>;
}): TouchesResult {
  const changed = [...args.changed];
  if (changed.length === 0) return { ok: true, changed: [] };
  if (args.allowed.length === 0) {
    return { ok: false, changed, violators: changed };
  }
  const match = picomatch([...args.allowed], { dot: true });
  const violators = changed.filter((p) => !match(p));
  if (violators.length === 0) return { ok: true, changed };
  return { ok: false, changed, violators };
}
