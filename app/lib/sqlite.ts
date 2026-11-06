import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";

const databases = globalThis as typeof globalThis & { __directorySqlite?: Map<string, DatabaseSync> };
const migrated = new WeakSet<DatabaseSync>();

export function getDataDirectory(): string {
  return path.resolve(process.env.DATA_DIR || path.join(process.cwd(), ".data"));
}

function migrate(db: DatabaseSync) {
  if (migrated.has(db)) return;
  const readVersion = () => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (readVersion() < 2) {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Read again inside the write lock, so concurrent process starts cannot
      // apply the same ALTER statements twice.
      const version = readVersion();
      if (version === 0) db.exec(`
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
      PRAGMA user_version = 1;`);
      if (version < 2) db.exec(`
        ALTER TABLE site_settings ADD COLUMN cover_image_url TEXT NOT NULL DEFAULT '';
        ALTER TABLE site_settings ADD COLUMN avatar_image_url TEXT NOT NULL DEFAULT '';
        PRAGMA user_version = 2;
      `);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  migrated.add(db);
}

export function getSqlite(): DatabaseSync {
  const directory = getDataDirectory();
  const filename = path.join(directory, "directory.sqlite");
  databases.__directorySqlite ??= new Map();
  const existing = databases.__directorySqlite.get(filename);
  if (existing) { migrate(existing); return existing; }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  try {
    chmodSync(filename, 0o600);
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    migrate(db);
  } catch (error) { db.close(); throw error; }
  databases.__directorySqlite.set(filename, db);
  return db;
}
