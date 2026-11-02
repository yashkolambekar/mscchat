import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { log } from "./log.js";

type Migration = (db: DatabaseSync) => void;

const hasTable = (db: DatabaseSync, t: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const hasColumn = (db: DatabaseSync, t: string, c: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((x) => x.name === c);

/**
 * Append-only list. NEVER edit or reorder an existing entry: the index + 1 is the schema version
 * stored in `PRAGMA user_version`. Every step must be safe to run on a DB that already has its
 * changes (databases created before versioning existed start at user_version 0).
 */
const MIGRATIONS: Migration[] = [
  // v1: initial schema (first deployed release)
  (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        index_status TEXT NOT NULL DEFAULT 'pending',
        index_error TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS chat_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        doc_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`),
  // v2: optional expiry date (YYYY-MM-DD) on documents
  (db) => {
    if (!hasColumn(db, "documents", "expires_at")) db.exec("ALTER TABLE documents ADD COLUMN expires_at TEXT");
  },
  // v3: add the next change here.
];

export function migrate(db: DatabaseSync, dbPath: string) {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const target = MIGRATIONS.length;
  if (current > target)
    throw new Error(`DB is at schema v${current} but this app only knows v${target}. Deploy a newer version, do not run old code on a newer DB.`);
  if (current === target) return;

  // Back up an existing DB (not a brand new one) before touching it.
  if (hasTable(db, "documents") && existsSync(dbPath)) {
    const bak = `${dbPath}.bak-v${current}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
    log("migrate", `backup written to ${bak}`);
  }

  for (let i = current; i < target; i++) {
    log("migrate", `v${i} -> v${i + 1}`);
    db.exec("BEGIN");
    try {
      MIGRATIONS[i](db);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Migration to v${i + 1} failed, rolled back: ${e instanceof Error ? e.message : e}`);
    }
  }
}
