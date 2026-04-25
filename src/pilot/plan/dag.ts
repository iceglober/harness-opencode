/**
 * DAG validation for `pilot.yaml` plans.
 *
 * The schema (`schema.ts`) checks that each task is well-formed in
 * isolation. This module enforces the cross-task invariants that make a
 * plan executable as a DAG:
 *
 *   - **No duplicate IDs** — every `task.id` must be unique within the
 *     plan, otherwise `depends_on` references are ambiguous.
 *   - **No dangling deps** — every entry in `task.depends_on` must
 *     resolve to a task in the same plan.
 *   - **No self-loops** — `T1 depends on T1` is rejected even though it's
 *     a degenerate cycle.
 *   - **No cycles** — the dep graph must be acyclic. Detected via DFS
 *     with a recursion stack; reports the offending cycle path.
 *
 * On success, returns a topological ordering (`topo: string[]`). The
 * scheduler (Phase E2) consumes this for ready-set computation; tests
 * use it to assert deterministic ordering.
 *
 * Topological order is determined by Kahn's algorithm with two-key
 * stable tiebreaks:
 *
 *   1. Tasks declared earlier in the plan come before tasks declared
 *      later when both have the same in-degree at a given step.
 *      (We iterate the original task array order.)
 *
 * This means a plan author can influence the apparent run order by
 * reordering tasks in their YAML — useful for human readability without
 * adding artificial dependencies.
 *
 * What this module does NOT do:
 *   - Glob conflict detection (lives in `globs.ts`).
 *   - Schema validation (the input is assumed already-schema-valid).
 *
 * Ship-checklist alignment: Phase A3 of `PILOT_TODO.md`.
 */

import type { Plan, PlanTask } from "./schema.js";

// --- Public types ----------------------------------------------------------

export type DagOk = {
  ok: true;
  /** Task IDs in dependency-respecting order. */
  topo: string[];
};

export type DagErr = {
  ok: false;
  errors: Array<DagError>;
};

/**
 * Discriminated error variant. Each kind carries the minimal info needed
 * to produce a useful CLI message.
 */
export type DagError =
  | { kind: "duplicate-id"; id: string; indexes: number[] }
  | { kind: "self-loop"; id: string }
  | { kind: "dangling-dep"; from: string; missing: string }
  | { kind: "cycle"; path: string[] };

export type DagResult = DagOk | DagErr;

// --- Public API ------------------------------------------------------------

/**
 * Validate the dependency graph of a plan. Returns a discriminated union;
 * never throws on bad input.
 *
 * Behavior:
 *   - Always reports duplicate IDs, self-loops, and dangling deps in
 *     full (does not stop at the first error within these categories).
 *   - Once any of those are present, skips cycle detection (cycles are
 *     ill-defined when the node set has duplicates or dangling refs).
 *   - On a clean graph, runs Kahn's topo sort and returns the order.
 *
 * The split — "report all the cheap errors, then the expensive one" —
 * is deliberate. Plan authors fix one batch of errors per validate
 * cycle; making them iterate twice for a one-character typo is rude.
 */
export function validateDag(plan: Plan): DagResult {
  const errors: DagError[] = [];
  const tasks = plan.tasks;

  // --- Pass 1: duplicate IDs -----------------------------------------
  const idIndexes = new Map<string, number[]>();
  for (let i = 0; i < tasks.length; i++) {
    const id = tasks[i]!.id;
    const existing = idIndexes.get(id);
    if (existing) {
      existing.push(i);
    } else {
      idIndexes.set(id, [i]);
    }
  }
  for (const [id, indexes] of idIndexes) {
    if (indexes.length > 1) {
      errors.push({ kind: "duplicate-id", id, indexes });
    }
  }

  // --- Pass 2: self-loops + dangling deps ----------------------------
  const idSet = new Set(idIndexes.keys());
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (dep === t.id) {
        errors.push({ kind: "self-loop", id: t.id });
        continue;
      }
      if (!idSet.has(dep)) {
        errors.push({ kind: "dangling-dep", from: t.id, missing: dep });
      }
    }
  }

  // If we already have errors of the structural kind, don't run cycle
  // detection — its results would be meaningless on a malformed graph
  // (e.g. duplicate IDs make adjacency lists ambiguous).
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // --- Pass 3: cycle detection (DFS) ---------------------------------
  // We only run this when the graph is otherwise clean. Build adjacency
  // from dep → dependent (Kahn-friendly direction) and outDegree by node.
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const t of tasks) {
    inDegree.set(t.id, 0);
    adjacency.set(t.id, []);
  }
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      adjacency.get(dep)!.push(t.id);
      inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);
    }
  }

  // DFS-based cycle detection that captures the actual cycle path. Kahn's
  // algorithm tells us a cycle exists (residual nodes with in-degree > 0)
  // but doesn't trivially produce the path. DFS does.
  const cyclePath = findCyclePath(tasks, adjacency);
  if (cyclePath) {
    errors.push({ kind: "cycle", path: cyclePath });
    return { ok: false, errors };
  }

  // --- Pass 4: topological sort (Kahn) -------------------------------
  // Stable: process roots in declared task-order. This makes test
  // assertions deterministic without forcing alphabetic ordering.
  const ready: string[] = [];
  const indegSnapshot = new Map(inDegree);
  for (const t of tasks) {
    if (indegSnapshot.get(t.id) === 0) ready.push(t.id);
  }

  const topo: string[] = [];
  while (ready.length > 0) {
    // Shift (FIFO) preserves declared order among ready nodes.
    const id = ready.shift()!;
    topo.push(id);
    for (const dependent of adjacency.get(id) ?? []) {
      const newDeg = (indegSnapshot.get(dependent) ?? 0) - 1;
      indegSnapshot.set(dependent, newDeg);
      if (newDeg === 0) ready.push(dependent);
    }
  }

  // Sanity: if topo doesn't cover all nodes, there was a cycle we
  // missed — which would be a bug in findCyclePath. Treat as a hard
  // error rather than silently omitting nodes.
  if (topo.length !== tasks.length) {
    return {
      ok: false,
      errors: [
        {
          kind: "cycle",
          path: tasks
            .filter((t) => !topo.includes(t.id))
            .map((t) => t.id),
        },
      ],
    };
  }

  return { ok: true, topo };
}

/**
 * Render a `DagError` as a single-line human-readable message. Used by
 * `pilot validate` and tests.
 */
export function formatDagError(err: DagError): string {
  switch (err.kind) {
    case "duplicate-id":
      return `duplicate task id ${JSON.stringify(err.id)} at indexes [${err.indexes.join(", ")}]`;
    case "self-loop":
      return `task ${JSON.stringify(err.id)} depends on itself`;
    case "dangling-dep":
      return `task ${JSON.stringify(err.from)} depends on missing task ${JSON.stringify(err.missing)}`;
    case "cycle":
      return `cycle detected: ${err.path.join(" → ")} → ${err.path[0]}`;
  }
}

// --- Internals -------------------------------------------------------------

/**
 * Find a single cycle path in the dep graph using DFS with three-color
 * coloring (white = unvisited, gray = on current path, black = fully
 * processed). When we hit a gray node, we've found a back-edge — the
 * cycle is the gray-stack slice from the back-edge target to the
 * current node.
 *
 * Returns the cycle path as an array of IDs (length >= 1, all distinct
 * within the cycle). The caller renders it as `A → B → C → A`.
 *
 * Returns null if no cycle exists.
 *
 * NB: `adjacency` is keyed by *dep* (predecessor) and points to
 * dependents. We DFS the OPPOSITE direction (each task's `depends_on`)
 * because that matches plan-author intuition: "cycle goes T1 → T2 →
 * T1" reads as "T1 depends on T2 which depends on T1", and we want the
 * rendered path to follow that arrow.
 */
function findCyclePath(
  tasks: ReadonlyArray<PlanTask>,
  adjacency: Map<string, string[]>,
): string[] | null {
  // Reconstruct the dependency-direction adjacency from the input — the
  // `adjacency` arg passed in points the OTHER way. We could refactor
  // the caller, but keeping the Kahn adjacency intact and building this
  // ad-hoc is clearer.
  void adjacency;
  const depAdj = new Map<string, string[]>();
  for (const t of tasks) depAdj.set(t.id, [...t.depends_on]);

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const t of tasks) color.set(t.id, WHITE);

  // Iterative DFS to avoid blowing the JS stack on degenerate-deep
  // chains. Stack frames carry the node and a child-cursor.
  const stack: Array<{ node: string; cursor: number }> = [];
  const onStackOrder: string[] = [];

  // Try every node as a DFS root — necessary for disconnected graphs.
  for (const t of tasks) {
    if (color.get(t.id) !== WHITE) continue;
    stack.push({ node: t.id, cursor: 0 });
    color.set(t.id, GRAY);
    onStackOrder.push(t.id);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const children = depAdj.get(frame.node) ?? [];

      if (frame.cursor >= children.length) {
        // Done with this node: turn black, pop, drop from path.
        color.set(frame.node, BLACK);
        stack.pop();
        onStackOrder.pop();
        continue;
      }

      const child = children[frame.cursor++]!;
      const childColor = color.get(child) ?? WHITE;

      if (childColor === BLACK) continue;

      if (childColor === GRAY) {
        // Back-edge → cycle. Slice path from child back to current node.
        const cycleStart = onStackOrder.indexOf(child);
        if (cycleStart === -1) {
          // Should be impossible — gray means on stack — but defensive.
          return [child];
        }
        return onStackOrder.slice(cycleStart);
      }

      // White: descend.
      color.set(child, GRAY);
      onStackOrder.push(child);
      stack.push({ node: child, cursor: 0 });
    }
  }

  return null;
}
