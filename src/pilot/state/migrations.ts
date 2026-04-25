/**
 * Schema migrations for the pilot state SQLite database.
 *
 * One migration per `MIGRATIONS` array entry. The runner records applied
 * versions in a `_migrations` table and applies pending migrations in
 * order on every `applyMigrations()` call. This means:
 *
 *   - First-time open: every migration runs.
 *   - Existing DB on a newer pilot version: only the missing migrations run.
 *   - Existing DB on the same pilot version: zero work.
 *
 * Why a hand-rolled migrations table instead of `PRAGMA user_version`:
 *   - `user_version` is a single integer; we want a per-migration audit
 *     trail (timestamps) for support cases where a user's DB ends up
 *     half-migrated after a SIGKILL.
 *   - `_migrations` makes it trivial to add an "applied_at" column and
 *     write a "downgrade" tool later if we ever need one. We don't ship
 *     downgrades in v0.1, but the audit trail is cheap insurance.
 *
 * The DB file is per-run (`<runDir>/state.db`), so cross-version
 * migrations are extremely rare in practice — a user would have to:
 *
 *   1. Run `pilot build` on pilot v0.1 (creates DB with v1 schema).
 *   2. Upgrade to a hypothetical pilot v0.2 with v2 schema.
 *   3. Run `pilot resume` against the same run.
 *
 * Even so, the architecture supports it cleanly. In v0.1, only `v1`
 * exists; the runner is exercised on every fresh DB.
 *
 * Why all-in-one strings (no SQL files):
 *   - The harness ships as a tarball; loading SQL files at runtime
 *     requires `readFile` + path resolution against `dist/`. Inline
 *     strings work everywhere — bundled, dev mode, tests — without an
 *     extra build step. The migrations are short.
 *
 * Schema correctness alignment: Phase B1 of `PILOT_TODO.md`.
 */

import type { Database } from "bun:sqlite";

// --- Migration record type -------------------------------------------------

export type Migration = {
  /**
   * Monotonically increasing version. v0.1 starts at 1; new migrations
   * append. NEVER reorder or renumber — once a migration ships, its
   * version is permanent.
   */
  version: number;

  /** Short human-readable description. Stored alongside `applied_at`. */
  description: string;

  /**
   * SQL to apply. May contain multiple statements separated by `;`.
   * Run inside a transaction by `applyMigrations`.
   */
  sql: string;
};

// --- The migrations themselves ---------------------------------------------

/**
 * v1 — initial schema (Phase B1). See `PILOT_TODO.md` B1 for column
 * definitions.
 *
 * Tables:
 *   - `runs`: one row per `pilot build` invocation. `id` is a ULID; the
 *     plan's path and slug are denormalized for fast `pilot status`
 *     lookups without re-reading the YAML.
 *   - `tasks`: one row per (run, task) pair. Composite PK so the same
 *     task ID can appear across runs (each in its own run). `attempts`
 *     counts how many times the worker has tried this task. `session_id`,
 *     `branch`, `worktree_path` are populated when work begins.
 *   - `events`: append-only audit log. Auto-incrementing PK lets
 *     `pilot logs` reconstruct chronological order without trusting
 *     wall-clock `ts` (which can stutter on NTP slewing).
 *   - `_migrations`: this module's own bookkeeping.
 *
 * All `*_at` columns store epoch milliseconds (number) for cheap
 * comparisons and JSON serialization. SQLite's `INTEGER` type handles
 * 53-bit safe-integer range, more than enough for ms timestamps.
 *
 * `payload` in `events` is a TEXT column (JSON-encoded). We don't use
 * SQLite's JSON1 functions yet — keeps the v0.1 DB readable from any
 * SQLite client.
 */
const V1_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT    NOT NULL PRIMARY KEY,
  plan_path     TEXT    NOT NULL,
  plan_slug     TEXT    NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT    NOT NULL CHECK (status IN ('pending','running','completed','aborted','failed'))
);

CREATE TABLE IF NOT EXISTS tasks (
  run_id          TEXT    NOT NULL,
  task_id         TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('pending','ready','running','succeeded','failed','blocked','aborted')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  session_id      TEXT,
  branch          TEXT,
  worktree_path   TEXT,
  started_at      INTEGER,
  finished_at     INTEGER,
  cost_usd        REAL    NOT NULL DEFAULT 0,
  last_error      TEXT,
  PRIMARY KEY (run_id, task_id),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_run_status ON tasks(run_id, status);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT    NOT NULL,
  task_id   TEXT,
  ts        INTEGER NOT NULL,
  kind      TEXT    NOT NULL,
  payload   TEXT    NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_events_run_task ON events(run_id, task_id, id);
`.trim();

/**
 * Ordered migrations. APPEND-ONLY — never reorder or delete entries.
 */
export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    description: "initial pilot schema (runs/tasks/events)",
    sql: V1_SQL,
  },
];

// --- Apply runner ----------------------------------------------------------

/**
 * Bring the DB up to the latest schema. Idempotent: if the DB is
 * already at the latest version, this is a no-op.
 *
 * Steps:
 *   1. Ensure `_migrations` table exists. Done outside any migration
 *      transaction because we need the table itself to record the rest.
 *   2. Read applied versions.
 *   3. Apply each pending migration inside its own transaction. If a
 *      migration's SQL throws, the transaction rolls back and the
 *      function rethrows — the DB is left at the previous version
 *      (no half-applied state).
 *
 * Returns the list of versions applied during THIS call (for logs and
 * tests). On a fully-current DB, returns `[]`.
 */
export function applyMigrations(db: Database): number[] {
  // Step 1: bookkeeping table.
  db.run(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version    INTEGER NOT NULL PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  // Step 2: read what's already applied.
  const applied = new Set(
    (db.query("SELECT version FROM _migrations").all() as Array<{
      version: number;
    }>).map((r) => r.version),
  );

  // Step 3: apply pending in version order. Each in its own transaction.
  const newlyApplied: number[] = [];
  const sorted = [...MIGRATIONS].sort((a, b) => a.version - b.version);

  for (const m of sorted) {
    if (applied.has(m.version)) continue;

    // bun:sqlite's `transaction` wraps a function in BEGIN/COMMIT and
    // rolls back automatically on throw.
    const tx = db.transaction(() => {
      // `db.exec` runs multi-statement SQL; `db.run` would only run
      // the first. Many migrations need multiple CREATEs.
      try {
        // Some bun versions expose `exec`; others only `run`. Try
        // `exec` and fall back to splitting on semicolons (not
        // bulletproof for SQL with embedded semicolons in strings,
        // but our migration SQL has none).
        const dbAny = db as unknown as { exec?: (sql: string) => void };
        if (typeof dbAny.exec === "function") {
          dbAny.exec(m.sql);
        } else {
          for (const stmt of splitStatements(m.sql)) {
            db.run(stmt);
          }
        }
      } catch (err) {
        throw new Error(
          `migration v${m.version} (${m.description}) failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      db.run(
        "INSERT INTO _migrations (version, description, applied_at) VALUES (?, ?, ?)",
        [m.version, m.description, Date.now()],
      );
    });
    tx();
    newlyApplied.push(m.version);
  }

  return newlyApplied;
}

/**
 * Read the list of applied migration versions. Pure read; for tests and
 * `pilot logs` introspection.
 */
export function getAppliedVersions(db: Database): number[] {
  // If `_migrations` doesn't exist yet (DB never opened by us), return [].
  const exists = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'",
    )
    .get();
  if (!exists) return [];
  const rows = db
    .query("SELECT version FROM _migrations ORDER BY version")
    .all() as Array<{ version: number }>;
  return rows.map((r) => r.version);
}

// --- Internals -------------------------------------------------------------

/**
 * Split a SQL string into top-level statements at unquoted semicolons.
 * Handles single-quoted strings (with `''` doubled-up escapes) and
 * line comments (`--`). Does NOT handle multi-line `/* ... *\/`
 * comments (we don't use them in migrations).
 *
 * Used as a fallback when `db.exec` isn't available on this bun version.
 */
function splitStatements(sql: string): string[] {
  const stmts: string[] = [];
  let buf = "";
  let inString = false;
  let inLineComment = false;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    const next = sql[i + 1];

    if (inLineComment) {
      buf += c;
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inString) {
      buf += c;
      if (c === "'") {
        // doubled-up '' is an escaped quote — keep inString.
        if (next === "'") {
          buf += next;
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }
    // not in string, not in comment
    if (c === "-" && next === "-") {
      inLineComment = true;
      buf += c;
      continue;
    }
    if (c === "'") {
      inString = true;
      buf += c;
      continue;
    }
    if (c === ";") {
      const trimmed = buf.trim();
      if (trimmed.length > 0) stmts.push(trimmed);
      buf = "";
      continue;
    }
    buf += c;
  }
  const tail = buf.trim();
  if (tail.length > 0) stmts.push(tail);
  return stmts;
}
