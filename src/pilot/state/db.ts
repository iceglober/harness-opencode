/**
 * Open and configure the pilot state SQLite database.
 *
 * Wraps `bun:sqlite` with the concerns that should be one-time-per-open:
 *   - Run pending migrations (`applyMigrations`).
 *   - Enable `PRAGMA foreign_keys = ON` (off by default in SQLite for
 *     historical reasons; we want our `tasks → runs` and
 *     `events → runs` cascades to work).
 *   - Enable `PRAGMA journal_mode = WAL` for durability + concurrent
 *     reads while the worker is writing. Pilot is single-writer (one
 *     worker, one CLI process), but `pilot status` / `pilot logs` read
 *     the same DB from a separate process — WAL keeps those snappy
 *     even mid-build.
 *   - `synchronous = NORMAL` — the standard "WAL safe" durability tier.
 *     We accept losing the LAST few transactions on a power-cut for
 *     a 2-3x write-throughput win.
 *
 * `openStateDb(path)` is the single entry point. It creates the parent
 * directory only if `path` is a regular path (not `:memory:`), assumes
 * the caller used `getStateDbPath()` to derive the path otherwise.
 *
 * Test affordance: callers can pass `:memory:` for in-process tests
 * that don't want to touch the filesystem.
 *
 * Ship-checklist alignment: Phase B1 of `PILOT_TODO.md`.
 */

import { Database } from "bun:sqlite";
import { applyMigrations } from "./migrations.js";

// --- Public API ------------------------------------------------------------

export type OpenedDb = {
  /** The opened, migrated database. Caller owns the close. */
  db: Database;
  /** Versions applied during this open call (empty if up-to-date). */
  newlyApplied: number[];
  /** Convenience: closes the db handle. */
  close: () => void;
};

/**
 * Open the SQLite database at `path` (or `:memory:`), apply pending
 * migrations, configure PRAGMAs, and return the handle.
 *
 * `path` is opened with `create: true` — file is created on first open.
 * Caller must ensure parent directory exists (`getStateDbPath` does this
 * via `getRunDir`).
 *
 * Throws if migrations fail; partial migrations are rolled back per
 * `applyMigrations`. The handle is not returned in that case — the
 * function rethrows after attempting `db.close()` on the way out.
 */
export function openStateDb(path: string): OpenedDb {
  const db = new Database(path, { create: true });

  // PRAGMAs MUST be set before migrations so foreign keys are enforced
  // during any future migration that touches them.
  // `:memory:` doesn't benefit from WAL (no disk file), but the PRAGMA
  // is harmless on memory DBs.
  try {
    db.run("PRAGMA foreign_keys = ON");
    if (path !== ":memory:") {
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA synchronous = NORMAL");
    }
  } catch (err) {
    db.close();
    throw new Error(
      `openStateDb: failed to set PRAGMAs on ${JSON.stringify(path)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let newlyApplied: number[];
  try {
    newlyApplied = applyMigrations(db);
  } catch (err) {
    db.close();
    throw err;
  }

  return {
    db,
    newlyApplied,
    close: () => db.close(),
  };
}
