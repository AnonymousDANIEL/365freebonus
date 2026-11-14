import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

// Run the real additive migration against isolated SQLite files. The fixture
// contains opaque credential/PIN/session values, never production data.
const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-join-gate-migration-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
writeFileSync(path.join(fixture, 'sqlite.js'), ts.transpileModule(
  readFileSync(new URL('../app/lib/sqlite.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
).outputText);
const require = createRequire(import.meta.url);
const { getSqlite } = require(path.join(fixture, 'sqlite.js'));
const previousDataDir = process.env.DATA_DIR;
const gateTables = ['settings', 'members', 'jobs', 'candidates', 'discovery', 'events']
  .map(name => `telegram_join_gate_${name}`);

function closeDatabase() {
  const filename = path.join(process.env.DATA_DIR, 'directory.sqlite');
  globalThis.__directorySqlite?.get(filename)?.close();
  globalThis.__directorySqlite?.delete(filename);
}
function snapshot(db, tables) {
  return tables.map(name => ({ name,
    schema: db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name).sql,
    rows: db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map(row => ({ ...row })),
  }));
}
test.beforeEach(() => { process.env.DATA_DIR = mkdtempSync(path.join(fixture, 'case-')); });
test.afterEach(closeDatabase);
test.after(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  rmSync(fixture, { recursive: true, force: true });
});

test('v25 join-gate migration preserves every old table, credentials, PIN, sessions, cursors, queues and daily identities', () => {
  const db = getSqlite();
  for (const name of gateTables) db.exec(`DROP TABLE "${name}"`);
  db.exec(`
    INSERT INTO brands(id,name,slug,category,tagline,description,color,icon)
      VALUES('existing-brand','Existing','existing','All','Existing tagline','Existing description','#123456','sparkles');
    INSERT INTO site_settings(id,name,eyebrow,headline,description,announcement)
      VALUES('primary','Existing site','Existing eyebrow','Existing headline','Existing description','Existing notice');
    INSERT INTO admin_sessions(id_hash,username,expires_at) VALUES('session-hash','fixture-admin',1800000000000);
    INSERT INTO admin_credentials(id,password_hash,updated_at) VALUES('primary','opaque-admin-hash',1234);
    INSERT INTO notes_vault_settings(id,pin_hash,revision,created_at,updated_at)
      VALUES('primary','opaque-pin-hash','vault-revision',11,12);
    INSERT INTO notes_vault_sessions(session_hash,generation) VALUES('session-hash','remember-generation');
    INSERT INTO notes_vault_unlocks(token_hash,session_hash,credential_fingerprint,vault_revision,expires_at)
      VALUES('unlock-hash','session-hash','credential-fingerprint','vault-revision',1800000000000);
    INSERT INTO secure_notes(title_ciphertext,body_ciphertext,revision,created_at,updated_at)
      VALUES('opaque-note-title','opaque-note-body','note-revision',13,14);
    INSERT INTO telegram_promotion_settings(id,enabled,chat_id,token_ciphertext,chat_bot_token_ciphertext,
      private_enabled,private_updates_enabled,private_followup_enabled,private_followup_message,relay_enabled,relay_revision)
      VALUES('primary',1,'-1007000000','opaque-brand-cipher','opaque-chat-cipher',1,1,1,'Existing followup',1,'relay-generation');
    INSERT INTO telegram_welcome_state(id,revision,next_offset,last_polled_at,next_poll_at,lease_id,lease_until)
      VALUES('primary','welcome-generation',990001,1700000000000,1700000001000,'welcome-lease',1700000030000);
    UPDATE telegram_relay_state SET revision='relay-generation',bot_id=12345678,next_offset=880001,
      last_polled_at=1700000001000,poll_lease_id='relay-poll-lease',poll_lease_until=1700000060000,
      send_lease_id='relay-send-lease',send_lease_until=1700000060000 WHERE id='primary';
    INSERT INTO telegram_relay_outbox(id,source_chat_id,source_message_id,fingerprint,queued_at,revision,
      media_kind,file_id,file_unique_id,caption,caption_entities,status,message_id,sent_at,
      caption_edit_attempted_at,caption_edit_outcome,caption_edit_recheck_count)
      VALUES(710,-1008000000,444,'existing-media-fingerprint',1700000000000,'relay-generation',
      'photo','opaque-file','opaque-media-identity','Original caption','[]','sent',772,1700000005000,
      1700000006000,'account_preserved',1);
    INSERT INTO telegram_relay_outbox(id,source_chat_id,source_message_id,fingerprint,queued_at,revision,
      media_kind,file_id,file_unique_id,caption,caption_entities,status,media_bytes)
      VALUES(711,-1008000000,445,'pending-media-fingerprint',1700000001000,'relay-generation',
      'video','opaque-pending-file','opaque-pending-media','Pending caption','[]','pending',X'000102ff');
    INSERT INTO telegram_relay_media_keys(day_key,media_key,outbox_id)
      VALUES('2026-11-14','content:photo:existing-media-hash',710),('2026-11-15','content:photo:existing-media-hash',710);
    INSERT INTO telegram_private_contacts(user_id,updates_enabled,updates_started_at) VALUES(701,0,1700000000000);
    INSERT INTO telegram_private_followups(chat_id,revision,settings_revision,status,opted_out,due_at)
      VALUES(701,'followup-generation','settings-generation','cancelled',1,1700003600000);
    CREATE TABLE telegram_personal_account(id TEXT PRIMARY KEY,config_ciphertext TEXT,session_ciphertext TEXT,generation TEXT);
    INSERT INTO telegram_personal_account VALUES('primary','opaque-api-config','opaque-personal-session','account-generation');
    CREATE TABLE telegram_personal_sources(chat_id INTEGER PRIMARY KEY,last_message_id INTEGER,selected INTEGER,peer_ciphertext TEXT);
    INSERT INTO telegram_personal_sources VALUES(-1009000000,551,1,'opaque-peer');
    UPDATE sqlite_sequence SET seq=9000 WHERE name='telegram_relay_outbox';
    PRAGMA user_version=25;
  `);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
  const before = snapshot(db, tables);
  closeDatabase();
  const migrated = getSqlite();
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 26);
  assert.deepEqual(snapshot(migrated, tables), before);
  for (const name of gateTables) {
    assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
    assert.equal(migrated.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count, 0,
      'migration must not enroll, approve or remove a user or silently activate the gate');
  }
  assert.equal(migrated.prepare("SELECT seq FROM sqlite_sequence WHERE name='telegram_relay_outbox'").get().seq, 9000);
});

test('reopening or replaying the additive migration never clears persisted gate work or settings', () => {
  const db = getSqlite();
  db.exec(`INSERT INTO telegram_join_gate_settings(id,enabled,target_chat_id,revision,token_hash,invite_link)
      VALUES('primary',1,-1001111111,'configured-generation','opaque-token-hash','https://t.me/+fixture-approval');
    INSERT INTO telegram_join_gate_members(target_chat_id,user_id,revision,state,blocked_by_gate,checked_at)
      VALUES(-1001111111,701,'configured-generation','blocked',1,12345);
    INSERT INTO telegram_join_gate_jobs(user_id,revision,request_pending,notification_attempted,status,lease_id,lease_until)
      VALUES(701,'configured-generation',1,1,'working','existing-lease',1800000000000);
    INSERT INTO telegram_join_gate_events(token_hash,update_id,created_at) VALUES('opaque-token-hash',99001,12345);
    PRAGMA user_version=25;`);
  const before = snapshot(db, gateTables);
  closeDatabase();
  const migrated = getSqlite();
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 26);
  assert.deepEqual(snapshot(migrated, gateTables), before);
  closeDatabase();
  assert.deepEqual(snapshot(getSqlite(), gateTables), before);
});
