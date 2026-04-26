/**
 * Append-only event log accessors.
 *
 * The events table is the durable audit trail of every interesting
 * state change during a run: task started, task verify failed, fix
 * prompt sent, etc. `pilot logs` reads it back; `pilot status` reads
 * counts.
 *
 * Events are STRICTLY append-only. Never update or delete — if a state
 * transition was wrong, log a *new* event recording the correction.
 *
 * Ship-checklist alignment: Phase B2 of `PILOT_TODO.md`.
 */

import type { Database } from "bun:sqlite";
import type { EventRow } from "./types.js";

// --- Public API ------------------------------------------------------------

/**
 * Append a single event. `payload` is JSON-serialized via `JSON.stringify`
 * — pass any structured value the caller wants to log. Strings and
 * numbers work too; they're stringified verbatim by JSON encoding.
 *
 * `taskId` is optional: events scoped to the run (e.g. "run started",
 * "server up") use `null`. Per-task events name the task.
 *
 * `now` is injectable for deterministic tests; production callers
 * usually omit it.
 */
export function appendEvent(
  db: Database,
  args: {
    runId: string;
    taskId?: string | null;
    kind: string;
    payload: unknown;
    now?: number;
  },
): void {
  const ts = args.now ?? Date.now();
  let payloadStr: string;
  try {
    payloadStr = JSON.stringify(args.payload ?? null);
  } catch (err) {
    // JSON.stringify throws on circular refs and BigInt. Log a degraded
    // payload rather than losing the event — the kind is usually enough
    // for debugging.
    payloadStr = JSON.stringify({
      _error: "payload not JSON-serializable",
      message: err instanceof Error ? err.message : String(err),
    });
  }
  db.run(
    `INSERT INTO events (run_id, task_id, ts, kind, payload) VALUES (?, ?, ?, ?, ?)`,
    [args.runId, args.taskId ?? null, ts, args.kind, payloadStr],
  );
  // Fan out to live subscribers. Subscribers observe events in
  // insertion order after they're durably persisted, so a subscriber
  // failure cannot drop an event that the DB already recorded.
  // Iterate over a snapshot so a subscriber calling unsubscribe()
  // during dispatch doesn't corrupt the loop.
  if (eventSubscribers.length > 0) {
    const snapshot = eventSubscribers.slice();
    for (const sub of snapshot) {
      try {
        sub({
          runId: args.runId,
          taskId: args.taskId ?? null,
          kind: args.kind,
          payload: args.payload,
          ts,
        });
      } catch {
        // Swallow subscriber errors — the event is already in the DB;
        // we must not fail the worker because a live logger threw.
      }
    }
  }
}

// --- Live event subscription -----------------------------------------------
//
// Optional fan-out for callers (e.g. `pilot build`'s streaming logger) that
// want to observe events as they're written. Subscription is process-global
// and lives at module scope because `appendEvent` is called from the worker
// via direct import; prop-drilling a callback through `runWorker` would touch
// 20+ call sites and bleed worker internals into every caller.
//
// Subscribers run synchronously after the DB insert. They should be fast and
// must not throw (they can, but exceptions are swallowed).

export type EventSubscriber = (event: {
  runId: string;
  taskId: string | null;
  kind: string;
  payload: unknown;
  ts: number;
}) => void;

const eventSubscribers: EventSubscriber[] = [];

/**
 * Register a subscriber that receives every event written via
 * `appendEvent` from now until the returned unsubscribe is called.
 *
 * Returns an idempotent unsubscribe function.
 */
export function subscribeToEvents(sub: EventSubscriber): () => void {
  eventSubscribers.push(sub);
  return () => {
    const i = eventSubscribers.indexOf(sub);
    if (i !== -1) eventSubscribers.splice(i, 1);
  };
}

/**
 * Read events for a run, in insertion order (id ASC). Optional task
 * filter narrows to per-task events. Returns the raw rows (with
 * `payload` as a JSON string) — caller decodes.
 */
export function readEvents(
  db: Database,
  args: { runId: string; taskId?: string; limit?: number },
): EventRow[] {
  const limit = args.limit ?? 10_000;
  if (args.taskId !== undefined) {
    return db
      .query(
        "SELECT * FROM events WHERE run_id=? AND task_id=? ORDER BY id LIMIT ?",
      )
      .all(args.runId, args.taskId, limit) as EventRow[];
  }
  return db
    .query("SELECT * FROM events WHERE run_id=? ORDER BY id LIMIT ?")
    .all(args.runId, limit) as EventRow[];
}

/**
 * Convenience: same as `readEvents` but JSON-decodes `payload`.
 *
 * Returns `unknown` per payload because the schema is event-kind-dependent
 * — the worker writes diverse shapes. Callers that know the kind should
 * narrow with a runtime check before use.
 */
export function readEventsDecoded(
  db: Database,
  args: { runId: string; taskId?: string; limit?: number },
): Array<Omit<EventRow, "payload"> & { payload: unknown }> {
  return readEvents(db, args).map((e) => ({
    ...e,
    payload: tryParseJson(e.payload),
  }));
}

// --- Internals -------------------------------------------------------------

/**
 * Parse a JSON string; return `null` on failure. The events table only
 * ever has JSON-encoded payloads (we control the writer), but if a row
 * was hand-edited we'd rather show `null` than crash the CLI.
 */
function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
