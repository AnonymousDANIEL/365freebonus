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
  if (readVersion() < 19) {
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
      if (version < 3) db.exec(`
        ALTER TABLE brands ADD COLUMN promotion_days INTEGER DEFAULT NULL;
        ALTER TABLE brands ADD COLUMN promotion_expires_at INTEGER DEFAULT NULL;
        UPDATE brands SET category = 'All'
          WHERE category NOT IN ('All', 'Update', 'New');
        UPDATE brands SET promotion_days = NULL, promotion_expires_at = NULL
          WHERE category = 'All';
        PRAGMA user_version = 3;
      `);
      if (version < 4) {
        db.exec(`
          ALTER TABLE site_settings ADD COLUMN whatsapp_url TEXT NOT NULL DEFAULT '';
          ALTER TABLE site_settings ADD COLUMN whatsapp_enabled INTEGER NOT NULL DEFAULT 0 CHECK (whatsapp_enabled IN (0, 1));
          ALTER TABLE site_settings ADD COLUMN telegram_url TEXT NOT NULL DEFAULT '';
          ALTER TABLE site_settings ADD COLUMN telegram_enabled INTEGER NOT NULL DEFAULT 0 CHECK (telegram_enabled IN (0, 1));
          ALTER TABLE site_settings ADD COLUMN facebook_url TEXT NOT NULL DEFAULT '';
          ALTER TABLE site_settings ADD COLUMN facebook_enabled INTEGER NOT NULL DEFAULT 0 CHECK (facebook_enabled IN (0, 1));
        `);
        // Replace only the exact former defaults, once. Later CMS edits and
        // custom headlines/descriptions remain the owner's content.
        db.prepare("UPDATE site_settings SET headline = ? WHERE headline = ?").run(
          "365 Free Bonus\nFind your favourite.", "Discover more.\nFind your favourite.",
        );
        db.prepare("UPDATE site_settings SET description = ? WHERE description = ?").run(
          "Free bonus offers.\nFind your next favourite at 365 FreeBonus.",
          "Thoughtfully chosen brands and fresh ideas, all in one elegant space. Take a look around — your next favourite could be here.",
        );
        db.exec("PRAGMA user_version = 4;");
      }
      if (version < 5) db.exec(`
        ALTER TABLE brands ADD COLUMN promotion_starts_at INTEGER DEFAULT NULL;
        CREATE TABLE telegram_promotion_outbox (
          brand_id TEXT PRIMARY KEY REFERENCES brands(id) ON DELETE CASCADE,
          revision TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
          last_error TEXT NOT NULL DEFAULT '', sent_at INTEGER, message_id INTEGER
        );
        CREATE TABLE telegram_promotion_settings (
          id TEXT PRIMARY KEY, enabled INTEGER NOT NULL,
          chat_id TEXT NOT NULL, token_ciphertext TEXT NOT NULL
        );
        PRAGMA user_version = 5;
      `);
      if (version < 6) db.exec(`
        ALTER TABLE brands ADD COLUMN publish_at INTEGER DEFAULT NULL;
        PRAGMA user_version = 6;
      `);
      if (version < 7) db.exec(`
        ALTER TABLE telegram_promotion_settings ADD COLUMN promotion_message TEXT NOT NULL DEFAULT '';
        ALTER TABLE telegram_promotion_settings ADD COLUMN welcome_enabled INTEGER NOT NULL DEFAULT 0 CHECK (welcome_enabled IN (0, 1));
        ALTER TABLE telegram_promotion_settings ADD COLUMN welcome_chat_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE telegram_promotion_settings ADD COLUMN welcome_message TEXT NOT NULL DEFAULT '';
        ALTER TABLE telegram_promotion_settings ADD COLUMN welcome_started_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE telegram_promotion_settings ADD COLUMN welcome_revision TEXT NOT NULL DEFAULT '';
        CREATE TABLE telegram_welcome_state (
          id TEXT PRIMARY KEY, revision TEXT NOT NULL,
          next_offset INTEGER NOT NULL DEFAULT 0, last_polled_at INTEGER NOT NULL DEFAULT 0,
          next_poll_at INTEGER NOT NULL DEFAULT 0, lease_id TEXT NOT NULL DEFAULT '',
          lease_until INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0,
          last_error TEXT NOT NULL DEFAULT ''
        );
        PRAGMA user_version = 7;
      `);
      if (version < 8) db.exec(`
        ALTER TABLE telegram_promotion_settings ADD COLUMN chat_bot_token_ciphertext TEXT NOT NULL DEFAULT '';
        ALTER TABLE telegram_promotion_settings ADD COLUMN keyword_enabled INTEGER NOT NULL DEFAULT 0 CHECK (keyword_enabled IN (0, 1));
        ALTER TABLE telegram_promotion_settings ADD COLUMN keyword_started_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE telegram_welcome_state ADD COLUMN keyword_replies INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE telegram_keyword_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT NOT NULL, keyword_key TEXT NOT NULL,
          match_mode TEXT NOT NULL CHECK (match_mode IN ('exact', 'contains')),
          response TEXT NOT NULL, UNIQUE (keyword_key, match_mode)
        );
        UPDATE telegram_promotion_settings SET welcome_enabled = 0, welcome_started_at = 0, welcome_revision = '';
        DELETE FROM telegram_welcome_state;
        PRAGMA user_version = 8;
      `);
      if (version < 9) db.exec(`
        ALTER TABLE telegram_promotion_settings ADD COLUMN private_enabled INTEGER NOT NULL DEFAULT 0 CHECK (private_enabled IN (0, 1));
        ALTER TABLE telegram_promotion_settings ADD COLUMN private_started_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE telegram_promotion_settings ADD COLUMN private_start_message TEXT NOT NULL DEFAULT '';
        ALTER TABLE telegram_welcome_state ADD COLUMN private_replies INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE telegram_private_contacts (user_id INTEGER PRIMARY KEY);
        PRAGMA user_version = 9;
      `);
      if (version < 10) db.exec(`
        CREATE TABLE popup_notices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          image_url TEXT NOT NULL,
          link TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 99999)
        );
        CREATE INDEX popup_notices_public_order ON popup_notices(enabled, sort_order, id);
        PRAGMA user_version = 10;
      `);
      if (version < 11) db.exec(`
        CREATE TABLE admin_credentials (
          id TEXT PRIMARY KEY CHECK (id = 'primary'),
          password_hash TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        PRAGMA user_version = 11;
      `);
      if (version < 12) db.exec(`
        CREATE TABLE website_logins (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL, login_url TEXT NOT NULL, verify_url TEXT NOT NULL,
          success_text TEXT NOT NULL, username TEXT NOT NULL, password_ciphertext TEXT NOT NULL,
          session_ciphertext TEXT NOT NULL DEFAULT '',
          username_field TEXT NOT NULL DEFAULT '', password_field TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
          interval_minutes INTEGER NOT NULL DEFAULT 30 CHECK (interval_minutes BETWEEN 15 AND 1440),
          status TEXT NOT NULL DEFAULT 'idle', message TEXT NOT NULL DEFAULT '',
          last_attempt_at INTEGER, last_success_at INTEGER, next_attempt_at INTEGER NOT NULL DEFAULT 0,
          requested INTEGER NOT NULL DEFAULT 0, revision TEXT NOT NULL,
          lease_id TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX website_logins_due ON website_logins(next_attempt_at, lease_until);
        PRAGMA user_version = 12;
      `);
      if (version < 13) db.exec(`
        DROP TABLE IF EXISTS website_logins;
        CREATE TABLE notes_vault_settings (
          id TEXT PRIMARY KEY CHECK (id = 'primary'),
          pin_hash TEXT NOT NULL, revision TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE notes_vault_unlocks (
          token_hash TEXT PRIMARY KEY,
          session_hash TEXT NOT NULL REFERENCES admin_sessions(id_hash) ON DELETE CASCADE,
          vault_revision TEXT NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE INDEX secure_notes_unlock_expiry ON notes_vault_unlocks(expires_at);
        CREATE TABLE notes_vault_sessions (
          session_hash TEXT PRIMARY KEY REFERENCES admin_sessions(id_hash) ON DELETE CASCADE,
          generation TEXT NOT NULL
        );
        CREATE TABLE notes_vault_attempts (
          id TEXT PRIMARY KEY CHECK (id = 'primary'),
          attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE TABLE secure_notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title_ciphertext TEXT NOT NULL, body_ciphertext TEXT NOT NULL,
          revision TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        PRAGMA user_version = 13;
      `);
      if (version < 14) db.exec(`
        DROP TABLE notes_vault_unlocks;
        CREATE TABLE notes_vault_unlocks (
          token_hash TEXT PRIMARY KEY,
          session_hash TEXT NOT NULL,
          credential_fingerprint TEXT NOT NULL,
          vault_revision TEXT NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE INDEX secure_notes_unlock_expiry ON notes_vault_unlocks(expires_at);
        PRAGMA user_version = 14;
      `);
      if (version < 15) db.exec(`
        ALTER TABLE telegram_keyword_rules ADD COLUMN show_button INTEGER NOT NULL DEFAULT 1 CHECK (show_button IN (0, 1));
        PRAGMA user_version = 15;
      `);
      if (version < 16) db.exec(`
        ALTER TABLE telegram_promotion_settings ADD COLUMN private_followup_enabled INTEGER NOT NULL DEFAULT 0 CHECK (private_followup_enabled IN (0, 1));
        ALTER TABLE telegram_promotion_settings ADD COLUMN private_followup_message TEXT NOT NULL DEFAULT '';
        ALTER TABLE telegram_promotion_settings ADD COLUMN private_followup_started_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE telegram_promotion_settings ADD COLUMN private_followup_revision TEXT NOT NULL DEFAULT '';
        CREATE TABLE telegram_private_followups (
          chat_id INTEGER PRIMARY KEY,
          revision TEXT NOT NULL DEFAULT '', settings_revision TEXT NOT NULL DEFAULT '',
          customer_update_id INTEGER NOT NULL DEFAULT 0, customer_message_id INTEGER NOT NULL DEFAULT 0,
          customer_at INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'cancelled' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'unknown', 'cancelled')),
          attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
          lease_id TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
          last_error TEXT NOT NULL DEFAULT '', sent_at INTEGER,
          last_outbound_at INTEGER NOT NULL DEFAULT 0, last_outbound_message_id INTEGER NOT NULL DEFAULT 0,
          opted_out INTEGER NOT NULL DEFAULT 0 CHECK (opted_out IN (0, 1))
        );
        CREATE INDEX telegram_private_followups_due ON telegram_private_followups(status, next_attempt_at, due_at);
        PRAGMA user_version = 16;
      `);
      if (version < 17) {
        db.exec(`
          ALTER TABLE telegram_promotion_settings ADD COLUMN private_updates_enabled INTEGER NOT NULL DEFAULT 0 CHECK (private_updates_enabled IN (0, 1));
          ALTER TABLE telegram_promotion_settings ADD COLUMN private_updates_started_at INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE telegram_promotion_settings ADD COLUMN private_updates_revision TEXT NOT NULL DEFAULT '';
          ALTER TABLE telegram_private_contacts ADD COLUMN updates_enabled INTEGER NOT NULL DEFAULT 1 CHECK (updates_enabled IN (0, 1));
          ALTER TABLE telegram_private_contacts ADD COLUMN updates_started_at INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE telegram_promotion_outbox ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
          CREATE TABLE telegram_private_brand_updates (
            brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
            promotion_revision TEXT NOT NULL, user_id INTEGER NOT NULL,
            settings_revision TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'unknown', 'cancelled')),
            attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
            lease_id TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
            last_error TEXT NOT NULL DEFAULT '', sent_at INTEGER, message_id INTEGER,
            PRIMARY KEY (brand_id, promotion_revision, user_id)
          );
          CREATE INDEX telegram_private_brand_updates_due ON telegram_private_brand_updates(status, next_attempt_at);
          CREATE TABLE telegram_private_updates_state (
            id TEXT PRIMARY KEY CHECK (id = 'primary'),
            next_send_at INTEGER NOT NULL DEFAULT 0,
            lease_id TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0
          );
          INSERT INTO telegram_private_updates_state (id) VALUES ('primary');
          UPDATE telegram_private_contacts SET updates_enabled = 0 WHERE EXISTS (
            SELECT 1 FROM telegram_private_followups f WHERE f.chat_id = telegram_private_contacts.user_id AND f.opted_out = 1
          );
        `);
        // This owner-requested feature begins with future notices only. Existing
        // outbox rows remain timestamp zero so migration cannot announce history.
        db.prepare(`UPDATE telegram_promotion_settings SET private_updates_enabled = 1,
          private_updates_started_at = ?, private_updates_revision = lower(hex(randomblob(16)))
          WHERE private_enabled = 1 AND chat_bot_token_ciphertext <> ''`)
          .run(Date.now());
        db.exec("PRAGMA user_version = 17;");
      }
      if (version < 18) {
        db.exec(`
          ALTER TABLE telegram_promotion_settings ADD COLUMN relay_enabled INTEGER NOT NULL DEFAULT 0 CHECK (relay_enabled IN (0, 1));
          ALTER TABLE telegram_promotion_settings ADD COLUMN relay_chat_id TEXT NOT NULL DEFAULT '@join365freebonusgroup';
          ALTER TABLE telegram_promotion_settings ADD COLUMN relay_started_at INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE telegram_promotion_settings ADD COLUMN relay_revision TEXT NOT NULL DEFAULT '';
          CREATE TABLE telegram_relay_state (
            id TEXT PRIMARY KEY CHECK (id = 'primary'),
            revision TEXT NOT NULL DEFAULT '', bot_id INTEGER NOT NULL DEFAULT 0,
            next_offset INTEGER NOT NULL DEFAULT 0, last_polled_at INTEGER NOT NULL DEFAULT 0,
            next_poll_at INTEGER NOT NULL DEFAULT 0,
            poll_lease_id TEXT NOT NULL DEFAULT '', poll_lease_until INTEGER NOT NULL DEFAULT 0,
            send_lease_id TEXT NOT NULL DEFAULT '', send_lease_until INTEGER NOT NULL DEFAULT 0,
            next_send_at INTEGER NOT NULL DEFAULT 0,
            target_chat_id INTEGER NOT NULL DEFAULT 0, target_verified_at INTEGER NOT NULL DEFAULT 0,
            ready_until INTEGER NOT NULL DEFAULT 0,
            skipped_count INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT ''
          );
          INSERT INTO telegram_relay_state (id) VALUES ('primary');
          CREATE TABLE telegram_relay_outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_chat_id INTEGER NOT NULL, source_message_id INTEGER NOT NULL,
            media_group_id TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL,
            queued_at INTEGER NOT NULL, revision TEXT NOT NULL,
            media_kind TEXT NOT NULL CHECK (media_kind IN ('photo', 'animation')),
            file_id TEXT NOT NULL, file_unique_id TEXT NOT NULL, caption TEXT NOT NULL,
            has_spoiler INTEGER NOT NULL DEFAULT 0 CHECK (has_spoiler IN (0, 1)),
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'unknown', 'cancelled')),
            attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
            lease_id TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
            last_error TEXT NOT NULL DEFAULT '', sent_at INTEGER, message_id INTEGER,
            UNIQUE (source_chat_id, source_message_id)
          );
          CREATE UNIQUE INDEX telegram_relay_album ON telegram_relay_outbox(source_chat_id, media_group_id) WHERE media_group_id <> '';
          CREATE INDEX telegram_relay_due ON telegram_relay_outbox(status, next_attempt_at);
          CREATE INDEX telegram_relay_fingerprint ON telegram_relay_outbox(fingerprint, queued_at);
        `);
        // Enable the requested relay only for an already configured promotion
        // bot, beginning with new updates after this migration.
        db.prepare(`UPDATE telegram_promotion_settings SET relay_enabled = 1,
          relay_started_at = ?, relay_revision = lower(hex(randomblob(16)))
          WHERE token_ciphertext <> ''`).run(Date.now());
        db.exec("PRAGMA user_version = 18;");
      }
      if (version < 19) {
        db.exec(`
          ALTER TABLE telegram_relay_outbox ADD COLUMN origin TEXT NOT NULL DEFAULT 'bot';
          ALTER TABLE telegram_relay_outbox ADD COLUMN account_generation TEXT NOT NULL DEFAULT '';
          ALTER TABLE telegram_relay_outbox ADD COLUMN media_bytes BLOB;
          ALTER TABLE telegram_relay_outbox ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
          ALTER TABLE telegram_relay_outbox ADD COLUMN visual_hash TEXT NOT NULL DEFAULT '';
          ALTER TABLE telegram_relay_outbox ADD COLUMN media_prepared INTEGER NOT NULL DEFAULT 0;
          CREATE TABLE telegram_relay_media_keys (
            media_key TEXT PRIMARY KEY, outbox_id INTEGER NOT NULL
          );
          CREATE INDEX telegram_relay_media_key_job ON telegram_relay_media_keys(outbox_id);
          INSERT OR IGNORE INTO telegram_relay_media_keys(media_key,outbox_id)
            SELECT 'file:' || media_kind || ':' || file_unique_id, id
            FROM telegram_relay_outbox
            WHERE status IN ('pending','sending','sent','unknown') AND file_unique_id <> ''
            ORDER BY CASE status WHEN 'sent' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END,id;
          UPDATE telegram_relay_outbox SET status='cancelled'
            WHERE status='pending' AND EXISTS(SELECT 1 FROM telegram_relay_media_keys k
              WHERE k.media_key='file:' || telegram_relay_outbox.media_kind || ':' || telegram_relay_outbox.file_unique_id
                AND k.outbox_id<>telegram_relay_outbox.id);
          PRAGMA user_version = 19;
        `);
      }
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
