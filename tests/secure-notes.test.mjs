import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { scryptSync, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const fixture = mkdtempSync(path.join(tmpdir(), 'secure-notes-'));
const root = new URL('..', import.meta.url);
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
for (const name of ['app/lib/sqlite', 'app/lib/auth-core', 'app/lib/session-store', 'app/lib/admin-credentials', 'app/lib/directory', 'app/lib/secure-notes', 'app/api/admin/_security', 'app/api/admin/notes/_security', 'app/api/admin/notes/route', 'app/api/admin/notes/vault/route', 'app/api/admin/notes/[id]/route', 'app/api/auth/logout/route']) {
  const target = path.join(fixture, `${name}.js`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, ts.transpileModule(readFileSync(new URL(`${name}.ts`, root), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText);
}
mkdirSync(path.join(fixture, 'node_modules/next'), { recursive: true });
writeFileSync(path.join(fixture, 'node_modules/next/headers.js'), 'exports.cookies=async()=>({get:name=>globalThis.__secureNotesCookies?.[name]?{value:globalThis.__secureNotesCookies[name]}:undefined});');
writeFileSync(path.join(fixture, 'node_modules/next/server.js'), 'exports.NextResponse={json(value,options){const response=Response.json(value,options);response.cookies={set(name,value,options){response.headers.append("set-cookie",`${name}=${value}; Path=${options.path}; Max-Age=${options.maxAge}; HttpOnly${options.secure?"; Secure":""}; SameSite=${options.sameSite}`);}};return response;}};');
writeFileSync(path.join(fixture, 'app/chatgpt-auth.js'), 'exports.authorized=true;exports.getChatGPTUser=async()=>exports.authorized?{userId:"admin"}:null;');
const require = createRequire(import.meta.url);
const sqlite = require(path.join(fixture, 'app/lib/sqlite.js'));
const auth = require(path.join(fixture, 'app/lib/auth-core.js'));
const sessions = require(path.join(fixture, 'app/lib/session-store.js'));
const credentials = require(path.join(fixture, 'app/lib/admin-credentials.js'));
const notes = require(path.join(fixture, 'app/lib/secure-notes.js'));
const guard = require(path.join(fixture, 'app/chatgpt-auth.js'));
const routes = require(path.join(fixture, 'app/api/admin/notes/route.js'));
const vaultRoute = require(path.join(fixture, 'app/api/admin/notes/vault/route.js'));
const itemRoute = require(path.join(fixture, 'app/api/admin/notes/[id]/route.js'));
const logoutRoute = require(path.join(fixture, 'app/api/auth/logout/route.js'));
const origin = 'https://notes-fixture.example';
const envNames = ['DATA_DIR','APP_URL','ADMIN_USERNAME','ADMIN_PASSWORD_HASH','SESSION_SECRET','NODE_ENV'];
const previousEnv = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
const password = 'fixture-long-admin-password';
const salt = '0123456789abcdef0123456789abcdef';
const passwordHash = `scrypt$${salt}$${scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex')}`;
const pin = '583729';
let admin;
function session() {
  const issued = auth.issueSession(credentials.getAdminAuthConfig());
  sessions.saveSession(issued.payload);
  return issued;
}
function request(method, value = {}, headers = {}) {
  return new Request(`${origin}/api/admin/notes`, { method, headers: { origin, 'content-type':'application/json', ...headers }, ...(method === 'GET' ? {} : { body: JSON.stringify(value) }) });
}
const setup = () => notes.setupNotesVault({ pin, confirmPin:pin, currentPassword:password }, admin.payload);
const params = id => ({ params:Promise.resolve({ id:String(id) }) });
function closeDatabase() {
  const filename = path.join(process.env.DATA_DIR, 'directory.sqlite');
  globalThis.__directorySqlite?.get(filename)?.close();
  globalThis.__directorySqlite?.delete(filename);
}
function acceptCookie(response) {
  const cookie = response.headers.get('set-cookie');
  if (cookie) globalThis.__secureNotesCookies[notes.NOTES_COOKIE] = cookie.split(';')[0].split('=')[1];
}
test.beforeEach(() => {
  process.env.DATA_DIR = mkdtempSync(path.join(fixture, 'case-'));
  process.env.APP_URL = origin;
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD_HASH = passwordHash;
  process.env.SESSION_SECRET = 'fixture-secure-notes-secret-longer-than-32-characters';
  process.env.NODE_ENV = 'production';
  guard.authorized = true;
  admin = session();
  globalThis.__secureNotesCookies = { [auth.SESSION_COOKIE]:admin.token };
});
test.afterEach(closeDatabase);
test.after(() => {
  for (const [key,value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key]=value; }
  delete globalThis.__secureNotesCookies;
  rmSync(fixture, { recursive:true, force:true });
});

test('all notes routes require both admin identity and a valid active signed session; writes require origin and JSON', async () => {
  guard.authorized=false;
  assert.equal((await vaultRoute.GET()).status,401);
  assert.equal((await routes.GET(request('GET'))).status,401);
  assert.equal((await routes.POST(request('POST',{ title:'Hidden',body:'Secret' }))).status,401);
  assert.equal((await itemRoute.DELETE(request('DELETE'),params(1))).status,401);
  guard.authorized=true;
  globalThis.__secureNotesCookies[auth.SESSION_COOKIE]='forged';
  assert.equal((await vaultRoute.GET()).status,401);
  globalThis.__secureNotesCookies[auth.SESSION_COOKIE]=admin.token;
  assert.equal((await vaultRoute.POST(request('POST',{action:'setup'},{origin:'https://attacker.example'}))).status,403);
  assert.equal((await vaultRoute.POST(request('POST',{action:'setup'},{'content-type':'text/plain'}))).status,415);
  assert.equal((await routes.GET(request('GET'))).status,423);
  const locked = await vaultRoute.GET();
  assert.deepEqual(await locked.json(),{configured:false,unlocked:false,expiresAt:null});
  assert.equal(locked.headers.get('cache-control'),'no-store');
});

test('setup verifies the current password, validates a confirmed6–12 digit PIN, and stores only a salted peppered hash', async () => {
  for (const bad of [{pin:'123',confirmPin:'123'}, {pin:'abc123',confirmPin:'abc123'}, {pin,confirmPin:'111111'}]) {
    await assert.rejects(notes.setupNotesVault({...bad,currentPassword:password},admin.payload),{status:400});
  }
  await assert.rejects(notes.setupNotesVault({pin,confirmPin:pin,currentPassword:'wrong'},admin.payload),{status:400});
  const {token,status}=await setup();
  assert.equal(status.unlocked,true);
  assert.equal(token.length,43);
  const row=sqlite.getSqlite().prepare("SELECT * FROM notes_vault_settings").get();
  assert.match(row.pin_hash,/^scrypt\$[a-f0-9]{64}\$[a-f0-9]{128}$/);
  assert.notEqual(row.pin_hash,pin);
  const unlock=sqlite.getSqlite().prepare("SELECT * FROM notes_vault_unlocks").get();
  assert.notEqual(unlock.token_hash,token);
  assert.equal(unlock.token_hash,createHash('sha256').update(token).digest('hex'));
  await assert.rejects(setup(),{status:409});
});

test('notes are encrypted at rest, never returned while locked, and survive a database reopen', async () => {
  const {token}=await setup();
  const saved=notes.saveSecureNote({title:'Private note title',body:'Confidential fixture content'},admin.payload,token);
  const row=sqlite.getSqlite().prepare('SELECT * FROM secure_notes WHERE id=?').get(saved.id);
  assert.equal(Object.values(row).join(' ').includes(saved.title),false);
  assert.equal(Object.values(row).join(' ').includes(saved.body),false);
  assert.equal(notes.listSecureNotes(admin.payload,token).notes[0].body,saved.body);
  assert.throws(()=>notes.listSecureNotes(admin.payload),{status:423});
  assert.throws(()=>notes.saveSecureNote({title:'Hidden',body:'blocked'},admin.payload),{status:423});
  closeDatabase();
  assert.equal(notes.listSecureNotes(admin.payload,token).notes[0].title,saved.title);
  notes.lockNotesVault(admin.payload,token);
  assert.throws(()=>notes.listSecureNotes(admin.payload,token),{status:423});
  assert.equal(notes.getVaultStatus(admin.payload,token).unlocked,false);
});

test('remembered authorization survives natural8h admin expiry and re-login until the exact12h idle boundary', async () => {
  const {token,status}=await setup();
  const createdAt=Date.now();
  assert.equal(notes.NOTES_UNLOCK_MS,12*60*60*1000);
  assert.ok(status.expiresAt>admin.payload.exp*1000);
  const other=session();
  assert.equal(notes.getVaultStatus(other.payload,token).unlocked,true);
  const realNow=Date.now;
  try {
    Date.now=()=>createdAt+9*60*60*1000;
    assert.equal(auth.verifySession(admin.token,credentials.getAdminAuthConfig()),null);
    const relogin=session();
    assert.equal(sessions.sessionIsActive(admin.payload),false);
    assert.equal(sqlite.getSqlite().prepare('SELECT COUNT(*) AS count FROM notes_vault_unlocks').get().count,1);
    assert.equal(notes.getVaultStatus(relogin.payload,token).unlocked,true);
    Date.now=()=>status.expiresAt-1;
    assert.equal(notes.getVaultStatus(relogin.payload,token).unlocked,true);
    Date.now=()=>status.expiresAt;
    assert.equal(notes.getVaultStatus(relogin.payload,token).unlocked,false);
    assert.throws(()=>notes.listSecureNotes(relogin.payload,token),{status:423});
    assert.equal(notes.recordNotesActivity(relogin.payload,token).unlocked,false);
  } finally {Date.now=realNow;}
});

test('real activity slides idle expiry; passive reads never extend it and expired tokens cannot be revived', async () => {
  const {token,status}=await setup();
  notes.saveSecureNote({title:'Read without touch',body:'Passive'},admin.payload,token);
  const initial=Date.now();
  const realNow=Date.now;
  try {
    Date.now=()=>initial+60*60*1000;
    assert.equal(notes.getVaultStatus(admin.payload,token).expiresAt,status.expiresAt);
    assert.equal(notes.listSecureNotes(admin.payload,token).expiresAt,status.expiresAt);
    assert.equal(sqlite.getSqlite().prepare('SELECT expires_at FROM notes_vault_unlocks').get().expires_at,status.expiresAt);
    const renewed=notes.recordNotesActivity(admin.payload,token);
    assert.equal(renewed.expiresAt,Date.now()+notes.NOTES_UNLOCK_MS);
    assert.ok(renewed.expiresAt>status.expiresAt);
    Date.now=()=>renewed.expiresAt;
    const relogin=session();
    assert.equal(notes.recordNotesActivity(relogin.payload,token).unlocked,false);
    assert.equal(sqlite.getSqlite().prepare('SELECT expires_at FROM notes_vault_unlocks').get().expires_at,renewed.expiresAt);
    assert.equal(notes.recordNotesActivity(relogin.payload,undefined).unlocked,false);
  } finally {Date.now=realNow;}
});

test('remember token cannot replace active admin authentication or survive a changed credential fingerprint', async () => {
  const {token}=await setup();
  sessions.revokeSession(admin.payload);
  assert.throws(()=>notes.getVaultStatus(admin.payload,token),{status:401});
  assert.throws(()=>notes.recordNotesActivity(admin.payload,token),{status:401});
  const other=session();
  assert.equal(notes.getVaultStatus(other.payload,token).unlocked,true);
  // Bootstrap password hashes can change without changing the session HMAC key.
  // The remembered notes binding must include the current password hash too.
  const changedSalt='abcdef0123456789abcdef0123456789';
  process.env.ADMIN_PASSWORD_HASH=`scrypt$${changedSalt}$${scryptSync('new-fixture-password',Buffer.from(changedSalt,'hex'),64).toString('hex')}`;
  assert.equal(notes.getVaultStatus(other.payload,token).unlocked,false);
  assert.equal(notes.recordNotesActivity(other.payload,token).unlocked,false);
});

test('PIN change revokes every unlocked session while preserving encrypted notes and disallows oldPIN', async () => {
  const first=await setup();
  notes.saveSecureNote({title:'Keep me',body:'Persist after PINchange'},admin.payload,first.token);
  const other=session();
  const second=await notes.unlockNotesVault({pin},other.payload);
  const changed=await notes.changeNotesPin({currentPin:pin,newPin:'826431',confirmPin:'826431'},admin.payload,first.token);
  assert.equal(changed.unlocked,false);
  assert.equal(notes.getVaultStatus(other.payload,second.token).unlocked,false);
  await assert.rejects(notes.unlockNotesVault({pin},admin.payload),{status:400});
  const reopened=await notes.unlockNotesVault({pin:'826431'},admin.payload);
  assert.equal(notes.listSecureNotes(admin.payload,reopened.token).notes[0].body,'Persist after PINchange');
});

test('wrongPIN attempts have a global persistent atomic limit, including simultaneous requests from different sessions', async () => {
  const {token}=await setup();
  notes.lockNotesVault(admin.payload,token);
  const other=session();
  const attempts=await Promise.allSettled(Array.from({length:12},(_,i)=>notes.unlockNotesVault({pin:'111111'},i%2?other.payload:admin.payload)));
  assert.equal(attempts.filter(r=>r.status==='rejected'&&r.reason.status===400).length,8);
  assert.equal(attempts.filter(r=>r.status==='rejected'&&r.reason.status===429).length,4);
  closeDatabase();
  await assert.rejects(notes.unlockNotesVault({pin},admin.payload),{status:429});
  const row=sqlite.getSqlite().prepare('SELECT * FROM notes_vault_attempts').get();
  const reopened=await notes.unlockNotesVault({pin},admin.payload,row.expires_at+1);
  assert.equal(reopened.status.unlocked,true);
});

test('manual lock wins over an unlock still verifyingPIN and revocation wins over an in-flight setup', async () => {
  const created=await setup();
  notes.lockNotesVault(admin.payload,created.token);
  const pending=notes.unlockNotesVault({pin},admin.payload);
  notes.lockNotesVault(admin.payload);
  await assert.rejects(pending,{status:423});
  const unlocked=await notes.unlockNotesVault({pin},admin.payload);
  assert.equal(unlocked.status.unlocked,true);
  notes.lockNotesVault(admin.payload);
  assert.equal(notes.getVaultStatus(admin.payload,unlocked.token).unlocked,false);
});

test('admin session revoked while PIN verification awaits cannot create a usable unlock', async () => {
  await setup();
  const pending=notes.unlockNotesVault({pin},admin.payload);
  sessions.revokeSession(admin.payload);
  await assert.rejects(pending,{status:401});
});

test('CRUD uses revisions to protect concurrent edits and delete; pagination and validation are bounded', async () => {
  const {token}=await setup();
  const original=notes.saveSecureNote({title:'Original',body:'First'},admin.payload,token);
  const updated=notes.saveSecureNote({title:'Updated',body:'Second',expectedRevision:original.revision},admin.payload,token,original.id);
  assert.notEqual(updated.revision,original.revision);
  assert.throws(()=>notes.saveSecureNote({title:'Overwrite',body:'Stale',expectedRevision:original.revision},admin.payload,token,original.id),{status:409});
  assert.throws(()=>notes.deleteSecureNote({expectedRevision:original.revision},admin.payload,token,original.id),{status:409});
  assert.equal(notes.listSecureNotes(admin.payload,token).notes[0].body,'Second');
  for(const invalid of [{title:'',body:'x'},{title:'a'.repeat(101),body:'x'},{title:'Valid',body:'x'.repeat(8001)}]) assert.throws(()=>notes.saveSecureNote(invalid,admin.payload,token),{status:400});
  for(let i=0;i<22;i++) notes.saveSecureNote({title:`Note${i}`,body:''},admin.payload,token);
  assert.equal(notes.listSecureNotes(admin.payload,token).notes.length,20);
  assert.equal(notes.listSecureNotes(admin.payload,token,2).notes.length,3);
  notes.deleteSecureNote({expectedRevision:updated.revision},admin.payload,token,original.id);
  assert.equal(notes.listSecureNotes(admin.payload,token).total,22);
});

test('ciphertext swap/tamper and missing encryption secret fail closed without corrupting stored notes', async () => {
  const {token}=await setup();
  const a=notes.saveSecureNote({title:'First',body:'Private A'},admin.payload,token);
  const b=notes.saveSecureNote({title:'Second',body:'Private B'},admin.payload,token);
  const db=sqlite.getSqlite();
  const original=db.prepare('SELECT body_ciphertext FROM secure_notes WHERE id=?').get(b.id).body_ciphertext;
  const foreign=db.prepare('SELECT body_ciphertext FROM secure_notes WHERE id=?').get(a.id).body_ciphertext;
  db.prepare('UPDATE secure_notes SET body_ciphertext=? WHERE id=?').run(foreign,b.id);
  assert.throws(()=>notes.listSecureNotes(admin.payload,token),{status:503});
  db.prepare('UPDATE secure_notes SET body_ciphertext=? WHERE id=?').run(original,b.id);
  assert.equal(notes.listSecureNotes(admin.payload,token).total,2);
  const oldSecret=process.env.SESSION_SECRET;
  process.env.SESSION_SECRET='different-fixture-secret-longer-than32-characters';
  assert.throws(()=>notes.listSecureNotes(admin.payload,token),{status:423});
  process.env.SESSION_SECRET=oldSecret;
  assert.equal(notes.listSecureNotes(admin.payload,token).total,2);
});

test('API cookies are HttpOnly Secure scoped; locked routes disclose no titles and streamed writes recheck the vault', async () => {
  const response=await vaultRoute.POST(request('POST',{action:'setup',pin,confirmPin:pin,currentPassword:password}));
  assert.equal(response.status,200);
  assert.match(response.headers.get('set-cookie'),/HttpOnly/);
  assert.match(response.headers.get('set-cookie'),/SameSite=Strict/);
  assert.match(response.headers.get('set-cookie'),/; Secure/);
  assert.match(response.headers.get('set-cookie'),/Path=\/api;/);
  assert.match(response.headers.get('set-cookie'),/directory_notes_remember=/);
  acceptCookie(response);
  const created=await routes.POST(request('POST',{title:'Sensitive title',body:'Secret body'}));
  assert.equal(created.status,201);
  assert.equal(created.headers.get('cache-control'),'no-store');
  const note=(await created.json()).note;
  const stale=await itemRoute.PUT(request('PUT',{title:'No overwrite',body:'Private',expectedRevision:'00000000-0000-0000-0000-000000000000'}),params(note.id));
  assert.equal(stale.status,409);
  let controller;
  const stream=new ReadableStream({start(c){controller=c;}});
  const streamingRequest=new Request(`${origin}/api/admin/notes`,{method:'POST',headers:{origin,'content-type':'application/json'},body:stream,duplex:'half'});
  const writing=routes.POST(streamingRequest);
  await new Promise(resolve=>setImmediate(resolve));
  const locked=await vaultRoute.POST(request('POST',{action:'lock'}));
  assert.equal(locked.status,200);
  controller.enqueue(new TextEncoder().encode(JSON.stringify({title:'Must not save',body:'Late secret'})));
  controller.close();
  assert.equal((await writing).status,423);
  const listing=await routes.GET(request('GET'));
  assert.equal(listing.status,423);
  assert.equal(JSON.stringify(await listing.json()).includes('Sensitive title'),false);
  const reopened=await vaultRoute.POST(request('POST',{action:'unlock',pin}));
  acceptCookie(reopened);
  assert.equal((await routes.GET(request('GET'))).status,200);
  assert.equal(sqlite.getSqlite().prepare('SELECT COUNT(*) AS count FROM secure_notes').get().count,1);
});

test('migration14 removes former website credentials and preserves unrelated tables', () => {
  closeDatabase();
  const legacyDir=mkdtempSync(path.join(fixture,'legacy-'));
  const filename=path.join(legacyDir,'directory.sqlite');
  const legacy=new DatabaseSync(filename);
  legacy.exec("CREATE TABLE admin_sessions(id_hash TEXT PRIMARY KEY,username TEXT,expires_at INTEGER); CREATE TABLE telegram_keyword_rules(id INTEGER PRIMARY KEY AUTOINCREMENT,keyword TEXT NOT NULL,keyword_key TEXT NOT NULL,match_mode TEXT NOT NULL,response TEXT NOT NULL,UNIQUE(keyword_key,match_mode)); CREATE TABLE telegram_promotion_settings(id TEXT PRIMARY KEY,private_enabled INTEGER NOT NULL DEFAULT 0,chat_bot_token_ciphertext TEXT NOT NULL DEFAULT '',token_ciphertext TEXT NOT NULL DEFAULT ''); CREATE TABLE telegram_private_contacts(user_id INTEGER PRIMARY KEY); CREATE TABLE telegram_promotion_outbox(brand_id TEXT PRIMARY KEY,revision TEXT NOT NULL DEFAULT ''); CREATE TABLE website_logins(id INTEGER PRIMARY KEY,password_ciphertext TEXT); INSERT INTO website_logins VALUES(1,'old-encrypted-credential'); CREATE TABLE brands(marker TEXT); INSERT INTO brands VALUES('keep-brand'); CREATE TABLE site_settings(marker TEXT); INSERT INTO site_settings VALUES('keep-settings'); PRAGMA user_version=12;");
  legacy.close();
  const oldDir=process.env.DATA_DIR;
  process.env.DATA_DIR=legacyDir;
  const db=sqlite.getSqlite();
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,20);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='website_logins'").get(),undefined);
  assert.equal(db.prepare('SELECT marker FROM brands').get().marker,'keep-brand');
  assert.equal(db.prepare('SELECT marker FROM site_settings').get().marker,'keep-settings');
  closeDatabase();
  process.env.DATA_DIR=oldDir;
});

test('activity API renews only a valid remember cookie and passiveGET never emits a renewal', async () => {
  const initial=await vaultRoute.POST(request('POST',{action:'setup',pin,confirmPin:pin,currentPassword:password}));
  acceptCookie(initial);
  const cookie=globalThis.__secureNotesCookies[notes.NOTES_COOKIE];
  const status=await initial.json();
  const realNow=Date.now;
  try {
    Date.now=()=>status.expiresAt-notes.NOTES_UNLOCK_MS+1000;
    const passive=await vaultRoute.GET();
    assert.equal(passive.headers.get('set-cookie'),null);
    assert.equal((await passive.json()).expiresAt,status.expiresAt);
    const active=await vaultRoute.POST(request('POST',{action:'activity'}));
    const renewed=await active.json();
    assert.equal(renewed.unlocked,true);
    assert.equal(renewed.expiresAt,Date.now()+notes.NOTES_UNLOCK_MS);
    assert.match(active.headers.get('set-cookie'),new RegExp(`^${notes.NOTES_COOKIE}=${cookie}; Path=/api;`));
    assert.equal(renewed.token,undefined);
    Date.now=()=>renewed.expiresAt;
    const relogin=session();
    globalThis.__secureNotesCookies[auth.SESSION_COOKIE]=relogin.token;
    const expired=await vaultRoute.POST(request('POST',{action:'activity'}));
    assert.equal(expired.status,200);
    assert.equal((await expired.json()).unlocked,false);
    assert.equal(expired.headers.get('set-cookie'),null);
    delete globalThis.__secureNotesCookies[notes.NOTES_COOKIE];
    const absent=await vaultRoute.POST(request('POST',{action:'activity'}));
    assert.equal((await absent.json()).unlocked,false);
    assert.equal(absent.headers.get('set-cookie'),null);
  } finally {Date.now=realNow;}
});

test('manual lock after re-login and explicitlogout revoke exact tokens issued by an older session', async () => {
  const {token}=await setup();
  const relogin=session();
  notes.lockNotesVault(relogin.payload,token);
  assert.equal(notes.getVaultStatus(admin.payload,token).unlocked,false);
  const reopened=await notes.unlockNotesVault({pin},admin.payload);
  globalThis.__secureNotesCookies={ [auth.SESSION_COOKIE]:relogin.token,[notes.NOTES_COOKIE]:reopened.token };
  const logout=await logoutRoute.POST(request('POST'));
  assert.equal(logout.status,200);
  assert.equal(sessions.sessionIsActive(relogin.payload),false);
  assert.equal(notes.getVaultStatus(admin.payload,reopened.token).unlocked,false);
  assert.match(logout.headers.get('set-cookie'),/directory_notes_remember=; Path=\/api; Max-Age=0/);
  assert.match(logout.headers.get('set-cookie'),/directory_notes_unlock=; Path=\/api\/admin\/notes; Max-Age=0/);
});

test('logout with missing or expired admin cookie still revokes its exact remember cookie; pendingunlock cannot win', async () => {
  const {token}=await setup();
  globalThis.__secureNotesCookies={ [notes.NOTES_COOKIE]:token };
  assert.equal((await logoutRoute.POST(request('POST'))).status,200);
  assert.equal(notes.getVaultStatus(admin.payload,token).unlocked,false);
  const resumed=await notes.unlockNotesVault({pin},admin.payload);
  globalThis.__secureNotesCookies={ [auth.SESSION_COOKIE]:admin.token,[notes.NOTES_COOKIE]:resumed.token };
  const pending=notes.unlockNotesVault({pin},admin.payload);
  await logoutRoute.POST(request('POST'));
  await assert.rejects(pending,{status:401});
  const other=session();
  assert.equal(notes.getVaultStatus(other.payload,resumed.token).unlocked,false);
});

test('administrator password change revokes remembered authorization without changing the PIN or note encryption', async () => {
  const {token}=await setup();
  notes.saveSecureNote({title:'Keep encrypted',body:'Afterpasswordchange'},admin.payload,token);
  const before=sqlite.getSqlite().prepare('SELECT * FROM notes_vault_settings').get();
  const expected=credentials.getAdminAuthConfig();
  await credentials.changeAdminPassword({currentPassword:password,newPassword:'changed-fixture-password',confirmPassword:'changed-fixture-password'},admin.payload,expected);
  assert.equal(sqlite.getSqlite().prepare('SELECT COUNT(*) AS count FROM notes_vault_unlocks').get().count,0);
  assert.equal(sqlite.getSqlite().prepare('SELECT pin_hash FROM notes_vault_settings').get().pin_hash,before.pin_hash);
  const relogin=session();
  assert.equal(notes.getVaultStatus(relogin.payload,token).unlocked,false);
  const reopened=await notes.unlockNotesVault({pin},relogin.payload);
  assert.equal(notes.listSecureNotes(relogin.payload,reopened.token).notes[0].body,'Afterpasswordchange');
});

test('migration14 revokes v13 ephemeral unlocks while preserving existing PIN and encrypted note ciphertext', async () => {
  const {token}=await setup();
  const saved=notes.saveSecureNote({title:'Migration title',body:'Migrationprivate'},admin.payload,token);
  const db=sqlite.getSqlite();
  const vaultBefore=db.prepare('SELECT * FROM notes_vault_settings').get();
  const noteBefore=db.prepare('SELECT * FROM secure_notes WHERE id=?').get(saved.id);
  db.exec("DROP TABLE telegram_relay_media_keys; DROP TABLE telegram_relay_outbox; DROP TABLE telegram_relay_state; ALTER TABLE telegram_promotion_settings DROP COLUMN relay_enabled; ALTER TABLE telegram_promotion_settings DROP COLUMN relay_chat_id; ALTER TABLE telegram_promotion_settings DROP COLUMN relay_started_at; ALTER TABLE telegram_promotion_settings DROP COLUMN relay_revision; DROP TABLE telegram_private_brand_updates; DROP TABLE telegram_private_updates_state; ALTER TABLE telegram_promotion_settings DROP COLUMN private_updates_enabled; ALTER TABLE telegram_promotion_settings DROP COLUMN private_updates_started_at; ALTER TABLE telegram_promotion_settings DROP COLUMN private_updates_revision; ALTER TABLE telegram_private_contacts DROP COLUMN updates_enabled; ALTER TABLE telegram_private_contacts DROP COLUMN updates_started_at; ALTER TABLE telegram_promotion_outbox DROP COLUMN created_at; DROP TABLE telegram_private_followups; ALTER TABLE telegram_promotion_settings DROP COLUMN private_followup_enabled; ALTER TABLE telegram_promotion_settings DROP COLUMN private_followup_message; ALTER TABLE telegram_promotion_settings DROP COLUMN private_followup_started_at; ALTER TABLE telegram_promotion_settings DROP COLUMN private_followup_revision; ALTER TABLE telegram_keyword_rules DROP COLUMN show_button; DROP TABLE notes_vault_unlocks; CREATE TABLE notes_vault_unlocks(token_hash TEXT PRIMARY KEY,session_hash TEXT NOT NULL REFERENCES admin_sessions(id_hash) ON DELETE CASCADE,vault_revision TEXT NOT NULL,expires_at INTEGER NOT NULL); CREATE INDEX secure_notes_unlock_expiry ON notes_vault_unlocks(expires_at); PRAGMA user_version=13;");
  db.prepare('INSERT INTO notes_vault_unlocks VALUES(?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),auth.sessionIdHash(admin.payload.jti),vaultBefore.revision,Date.now()+900000);
  closeDatabase();
  const reopened=sqlite.getSqlite();
  assert.equal(reopened.prepare('PRAGMA user_version').get().user_version,20);
  assert.deepEqual(reopened.prepare('SELECT * FROM notes_vault_settings').get(),vaultBefore);
  assert.deepEqual(reopened.prepare('SELECT * FROM secure_notes WHERE id=?').get(saved.id),noteBefore);
  assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM notes_vault_unlocks').get().count,0);
  assert.equal(reopened.prepare('PRAGMA foreign_key_list(notes_vault_unlocks)').all().length,0);
  const unlocked=await notes.unlockNotesVault({pin},admin.payload);
  assert.equal(notes.listSecureNotes(admin.payload,unlocked.token).notes[0].body,'Migrationprivate');
});
