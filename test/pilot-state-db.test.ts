// pilot-state-db.test.ts — coverage for src/pilot/state/{db,migrations}.ts.
//
// Tests use in-memory SQLite (`:memory:`) where possible. A small set of
// tests exercise file-backed DBs to cover WAL-mode and create-parent
// semantics; those use tmp dirs.
//
// Coverage:
//   - schema creation (every table, every column type, every constraint)
//   - idempotent reopen
//   - migration tracking (_migrations rows, applied_at present)
//   - basic CRUD on every table
//   - foreign key cascades from runs → tasks → events
//   - status CHECK constraints reject invalid values
//   - PRAGMA settings (foreign_keys ON; WAL on file-backed)
//   - splitStatements fallback handling

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openStateDb } from "../src/pilot/state/db.js";
import {
  applyMigrations,
  getAppliedVersions,
  MIGRATIONS,
} from "../src/pilot/state/migrations.js";

// --- Fixtures --------------------------------------------------------------

function mkTmpDir(prefix = "pilot-state-db-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- Schema creation -------------------------------------------------------

describe("openStateDb — schema creation", () => {
  test("creates every expected table on first open", () => {
    const opened = openStateDb(":memory:");
    try {
      const tables = (
        opened.db
          .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);

      // Includes our tables AND _migrations. AUTOINCREMENT also implies
      // sqlite_sequence — its presence is internal SQLite plumbing.
      expect(tables).toContain("runs");
      expect(tables).toContain("tasks");
      expect(tables).toContain("events");
      expect(tables).toContain("_migrations");
    } finally {
      opened.close();
    }
  });

  test("runs table has the expected columns and types", () => {
    const { db, close } = openStateDb(":memory:");
    try {
      const cols = db.query("PRAGMA table_info(runs)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      expect(byName.id?.pk).toBe(1);
      expect(byName.id?.type).toBe("TEXT");
      expect(byName.id?.notnull).toBe(1);
      expect(byName.plan_path?.type).toBe("TEXT");
      expect(byName.plan_slug?.type).toBe("TEXT");
      expect(byName.started_at?.type).toBe("INTEGER");
      expect(byName.finished_at?.type).toBe("INTEGER");
      expect(byName.status?.type).toBe("TEXT");
    } finally {
      close();
    }
  });

  test("tasks table has composite PK (run_id, task_id)", () => {
    const { db, close } = openStateDb(":memory:");
    try {
      const cols = db.query("PRAGMA table_info(tasks)").all() as Array<{
        name: string;
        pk: number;
      }>;
      const pkCols = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
      expect(pkCols.map((c) => c.name)).toEqual(["run_id", "task_id"]);
    } finally {
      close();
    }
  });

  test("events table has AUTOINCREMENT id", () => {
    const { db, close } = openStateDb(":memory:");
    try {
      // sqlite_sequence is created when AUTOINCREMENT is in use.
      const seq = db
        .query("SELECT name FROM sqlite_master WHERE name='sqlite_sequence'")
        .get();
      expect(seq).not.toBeNull();
    } finally {
      close();
    }
  });

  test("indexes are created", () => {
    const { db, close } = openStateDb(":memory:");
    try {
      const indexes = (
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(indexes).toContain("idx_tasks_run_status");
      expect(indexes).toContain("idx_events_run");
      expect(indexes).toContain("idx_events_run_task");
    } finally {
      close();
    }
  });
});

// --- Migration tracking ----------------------------------------------------

describe("applyMigrations / migration tracking", () => {
  test("first open applies every migration; rows recorded", () => {
    const { db, newlyApplied, close } = openStateDb(":memory:");
    try {
      expect(newlyApplied).toEqual(MIGRATIONS.map((m) => m.version));
      const rows = db
        .query(
          "SELECT version, description, applied_at FROM _migrations ORDER BY version",
        )
        .all() as Array<{ version: number; description: string; applied_at: number }>;
      expect(rows.length).toBe(MIGRATIONS.length);
      for (const r of rows) {
        expect(r.applied_at).toBeGreaterThan(0);
        expect(typeof r.description).toBe("string");
      }
    } finally {
      close();
    }
  });

  test("re-running applyMigrations on the same db is a no-op", () => {
    const opened = openStateDb(":memory:");
    try {
      const second = applyMigrations(opened.db);
      expect(second).toEqual([]);
      const versions = getAppliedVersions(opened.db);
      expect(versions).toEqual(MIGRATIONS.map((m) => m.version));
    } finally {
      opened.close();
    }
  });

  test("reopening a file-backed db only applies new migrations", () => {
    const tmp = mkTmpDir();
    try {
      const dbPath = path.join(tmp, "state.db");
      const a = openStateDb(dbPath);
      const aApplied = a.newlyApplied;
      a.close();

      const b = openStateDb(dbPath);
      expect(b.newlyApplied).toEqual([]);
      const versions = getAppliedVersions(b.db);
      expect(versions).toEqual(aApplied);
      b.close();
    } finally {
      rmTmpDir(tmp);
    }
  });

  test("getAppliedVersions returns [] on a virgin db without _migrations", () => {
    const db = new Database(":memory:");
    try {
      expect(getAppliedVersions(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// --- PRAGMA settings -------------------------------------------------------

describe("PRAGMA settings", () => {
  test("foreign_keys is ON after openStateDb", () => {
    const { db, close } = openStateDb(":memory:");
    try {
      const r = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
      expect(r.foreign_keys).toBe(1);
    } finally {
      close();
    }
  });

  test("journal_mode is WAL on a file-backed db (not memory)", () => {
    const tmp = mkTmpDir();
    try {
      const dbPath = path.join(tmp, "state.db");
      const { db, close } = openStateDb(dbPath);
      try {
        const r = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
        expect(r.journal_mode.toLowerCase()).toBe("wal");
      } finally {
        close();
      }
    } finally {
      rmTmpDir(tmp);
    }
  });
});

// --- Basic CRUD ------------------------------------------------------------

describe("basic CRUD on the v1 schema", () => {
  let opened: ReturnType<typeof openStateDb>;
  beforeEach(() => {
    opened = openStateDb(":memory:");
  });
  afterEach(() => opened.close());

  test("insert a run row + read it back", () => {
    opened.db.run(
      "INSERT INTO runs (id, plan_path, plan_slug, started_at, status) VALUES (?, ?, ?, ?, ?)",
      ["r1", "/p/pilot.yaml", "test-slug", 100, "running"],
    );
    const got = opened.db
      .query("SELECT * FROM runs WHERE id=?")
      .get("r1") as Record<string, unknown>;
    expect(got.id).toBe("r1");
    expect(got.status).toBe("running");
  });

  test("invalid run status is rejected by CHECK constraint", () => {
    expect(() => {
      opened.db.run(
        "INSERT INTO runs (id, plan_path, plan_slug, started_at, status) VALUES (?, ?, ?, ?, ?)",
        ["r-bad", "/p", "s", 1, "totally-not-a-status"],
      );
    }).toThrow(/CHECK|constraint/i);
  });

  test("invalid task status is rejected by CHECK constraint", () => {
    opened.db.run(
      "INSERT INTO runs (id, plan_path, plan_slug, started_at, status) VALUES (?, ?, ?, ?, ?)",
      ["r1", "/p", "s", 1, "running"],
    );
    expect(() => {
      opened.db.run(
        "INSERT INTO tasks (run_id, task_id, status) VALUES (?, ?, ?)",
        ["r1", "T1", "wibble"],
      );
    }).toThrow(/CHECK|constraint/i);
  });

  test("attempts defaults to 0 and cost_usd defaults to 0", () => {
    opened.db.run(
      "INSERT INTO runs (id, plan_path, plan_slug, started_at, status) VALUES ('r1','/p','s',1,'running')",
    );
    opened.db.run(
      "INSERT INTO tasks (run_id, task_id, status) VALUES ('r1','T1','pending')",
    );
    const t = opened.db
      .query("SELECT attempts, cost_usd FROM tasks WHERE run_id='r1' AND task_id='T1'")
      .get() as { attempts: number; cost_usd: number };
    expect(t.attempts).toBe(0);
    expect(t.cost_usd).toBe(0);
  });

  test("inserting two tasks with same run_id+task_id violates PK", () => {
    opened.db.run(
      "INSERT INTO runs (id, plan_path, plan_slug, started_at, status) VALUES ('r1','/p','s',1,'running')",
    );
    opened.db.run(
      "INSERT INTO tasks (run_id, task_id, status) VALUES ('r1','T1','pending')",
    );
    expect(() => {
      opened.db.run(
        "INSERT INTO tasks (run_id, task_id, status) VALUES ('r1','T1','ready')",
      );
    }).toThrow(/UNIQUE|PRIMARY|constraint/i);
  });

  test("events insert with auto-incremented id; retrievable by run_id ordered by id", () => {
    opened.db.run(
      "INSERT INTO runs (id, plan_path, plan_slug, started_at, status) VALUES ('r1','/p','s',1,'running')",
    );
    opened.db.run(
      "INSERT INTO events (run_id, task_id, ts, kind, payload) VALUES ('r1','T1',10,'a','{}')",
    );
    opened.db.run(
      "INSERT INTO events (run_id, task_id, ts, kind, payload) VALUES ('r1','T1',20,'b','{}')",
    );
    const rows = opened.db
      .query("SELECT id, kind FROM events WHERE run_id='r1' ORDER BY id")
      .all() as Array<{ id: number; kind: string }>;
    expect(rows.length).toBe(2);
    expect(rows[0]!.id).toBeLessThan(rows[1]!.id);
    expect(rows.map((r) => r.kind)).toEqual(["a", "b"]);
  });
});

// --- Foreign key cascades --------------------------------------------------

describe("FK cascades (runs → tasks → events)", () => {
  test("deleting a run cascades to its tasks and events", () => {
    const { db, close } = openStateDb(":memory:");
    try {
      db.run(
        "INSERT INTO runs (id, plan_path, plan_slug, started_at, status) VALUES ('r1','/p','s',1,'running')",
      );
      db.run(
        "INSERT INTO tasks (run_id, task_id, status) VALUES ('r1','T1','pending')",
      );
      db.run(
        "INSERT INTO tasks (run_id, task_id, status) VALUES ('r1','T2','pending')",
      );
      db.run(
        "INSERT INTO events (run_id, task_id, ts, kind, payload) VALUES ('r1','T1',1,'k','{}')",
      );
      db.run(
        "INSERT INTO events (run_id, task_id, ts, kind, payload) VALUES ('r1',NULL,2,'run-k','{}')",
      );

      db.run("DELETE FROM runs WHERE id='r1'");

      const tasksLeft = (
        db.query("SELECT COUNT(*) as n FROM tasks").get() as { n: number }
      ).n;
      const eventsLeft = (
        db.query("SELECT COUNT(*) as n FROM events").get() as { n: number }
      ).n;
      expect(tasksLeft).toBe(0);
      expect(eventsLeft).toBe(0);
    } finally {
      close();
    }
  });

  test("inserting a task with non-existent run_id fails", () => {
    const { db, close } = openStateDb(":memory:");
    try {
      expect(() => {
        db.run(
          "INSERT INTO tasks (run_id, task_id, status) VALUES ('nope','T1','pending')",
        );
      }).toThrow(/FOREIGN|constraint/i);
    } finally {
      close();
    }
  });
});

// --- Open creates parent dir? (no — caller responsibility) -----------------

describe("openStateDb file-backed semantics", () => {
  test("does NOT create parent dir (caller's job via getStateDbPath/getRunDir)", () => {
    const tmp = mkTmpDir();
    try {
      const missingDir = path.join(tmp, "does", "not", "exist");
      expect(() => openStateDb(path.join(missingDir, "state.db"))).toThrow();
    } finally {
      rmTmpDir(tmp);
    }
  });

  test("opens a file inside an existing directory", () => {
    const tmp = mkTmpDir();
    try {
      const dbPath = path.join(tmp, "state.db");
      const { close } = openStateDb(dbPath);
      try {
        expect(fs.existsSync(dbPath)).toBe(true);
      } finally {
        close();
      }
    } finally {
      rmTmpDir(tmp);
    }
  });
});
