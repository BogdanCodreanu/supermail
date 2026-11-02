import { readdirSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { seedGroups } from './seed.js';

export type DB = Database.Database;

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

function schemaVersion(db: DB): number {
  const hasKv = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kv'").get();
  if (!hasKv) return 0;
  const v = db.prepare("SELECT value FROM kv WHERE key='schema_version'").pluck().get() as string | undefined;
  return v ? Number(v) : 0;
}

function migrate(db: DB): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  let current = schemaVersion(db);
  for (const file of files) {
    const version = Number(file.slice(0, file.indexOf('_')));
    if (version <= current) continue;
    const sql = readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO kv(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(String(version));
    })();
    current = version;
  }
}

export function openDb(file: string | ':memory:'): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  seedGroups(db);
  return db;
}
