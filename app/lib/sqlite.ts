import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";

const databases = globalThis as typeof globalThis & { __directorySqlite?: Map<string, DatabaseSync> };

export function getSqlite(): DatabaseSync {
  const directory = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), ".data"));
  const filename = path.join(directory, "directory.sqlite");
  databases.__directorySqlite ??= new Map();
  const existing = databases.__directorySqlite.get(filename);
  if (existing) return existing;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version.user_version === 0) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS brands (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL, tagline TEXT NOT NULL, description TEXT NOT NULL,
        color TEXT NOT NULL, icon TEXT NOT NULL, image_url TEXT NOT NULL DEFAULT '',
        featured INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0, link TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS site_settings (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, eyebrow TEXT NOT NULL,
        headline TEXT NOT NULL, description TEXT NOT NULL, announcement TEXT NOT NULL,
        contact_url TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS admin_sessions (
        id_hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS login_attempts (
        ip_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS login_attempts_expiry ON login_attempts(expires_at);
      PRAGMA user_version = 1;
      COMMIT;`);
  }
  databases.__directorySqlite.set(filename, db);
  return db;
}
