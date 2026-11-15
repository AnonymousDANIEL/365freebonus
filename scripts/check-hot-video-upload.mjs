#!/usr/bin/env node
// Optional transport integration check. Requires local ffmpeg and installed npm
// dependencies; it creates a disposable Next app and never uses production auth,
// data, credentials, channels or worker instrumentation.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maximumBytes = 120 * 1024 * 1024, chunkBytes = 1024 * 1024;
const fixture = await mkdtemp(path.join(tmpdir(), 'hot-video-next-http-'));
const data = path.join(fixture, 'private-data');
let child, serverLog = '', exitCode = null, db;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function write(relative, contents) {
  const destination = path.join(fixture, relative); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, contents);
}
function phase(value) { process.stdout.write(`${value}\n`); }
async function freePort() {
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}
async function stopServer() {
  if (!child || exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  for (let wait = 0; wait < 50 && exitCode === null; wait++) await delay(100);
  if (exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

try {
  const required = [
    'app/api/admin/telegram/hot-videos/route.ts',
    'app/api/admin/telegram/hot-videos/uploads/route.ts',
    'app/api/admin/telegram/hot-videos/uploads/[id]/route.ts',
    'app/api/admin/telegram/hot-videos/uploads/[id]/complete/route.ts',
    'app/api/admin/_security.ts', 'app/lib/auth-core.ts', 'app/lib/sqlite.ts',
    'app/lib/telegram-hot-video-limits.ts', 'app/lib/telegram-hot-videos.ts', 'app/lib/telegram-hot-video-chunks.ts',
  ];
  for (const filename of required) await write(filename, await readFile(path.join(root, filename)));
  const { dependencies, devDependencies } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await write('package.json', JSON.stringify({ private: true, type: 'module', dependencies, devDependencies }));
  await symlink(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
  await write('next.config.mjs', await readFile(path.join(root, 'next.config.mjs')));
  await write('app/layout.tsx', 'export default function Layout({children}:{children:React.ReactNode}){return <html><body>{children}</body></html>;}');
  await write('app/page.tsx', 'export default function Page(){return <main>Isolated upload transport fixture</main>;}');
  await write('app/chatgpt-auth.ts', 'export async function getChatGPTUser(){return {userId:"fixture-admin",displayName:"Fixture",email:"",fullName:null};}');
  await write('app/lib/directory.ts', 'export class PromotionValidationError extends Error{};export class SettingsValidationError extends Error{};');
  await write('app/lib/telegram-hot-video-native.ts', 'export async function sendLargeHotVideo(){throw new Error("Upload fixture must never send a channel message");}');
  await write('app/lib/telegram-bot.ts', `
declare global {var __uploadIntegrationTelegramCalls:number|undefined;}
const disabled=async(..._args:unknown[])=>{globalThis.__uploadIntegrationTelegramCalls=(globalThis.__uploadIntegrationTelegramCalls||0)+1;throw Error('Telegram disabled in isolated upload check');};
export const telegramRequest=disabled;export const telegramVideoFileRequest=disabled;
`);
  await write('app/lib/telegram-promotions.ts', `
import {getSqlite} from './sqlite';import {hotVideoStatus} from './telegram-hot-videos';
export const telegramHotVideoStatus=()=>hotVideoStatus(getSqlite());
const disabled=async(..._args:unknown[])=>{throw Error('Sending disabled in isolated upload check');};
export const saveTelegramHotVideoSettings=disabled;export const queueTelegramHotVideo=disabled;
export const updateTelegramHotVideo=disabled;export const deleteTelegramHotVideo=disabled;export const cancelTelegramHotVideoJob=disabled;
`);
  await write('app/api/health/route.ts', 'export function GET(){return Response.json({ok:true,telegramCalls:(globalThis as typeof globalThis & {__uploadIntegrationTelegramCalls?:number}).__uploadIntegrationTelegramCalls||0});}');

  const seed = path.join(fixture, 'one-black-frame.mp4');
  const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i',
    'color=c=black:s=16x16:r=1:d=1', '-frames:v', '1', '-threads', '1', '-c:v', 'libx264', '-movflags', '+faststart', seed], { encoding: 'utf8' });
  if (generated.error || generated.status !== 0) throw Error(`This optional check requires ffmpeg with libx264: ${generated.error?.message || generated.stderr}`);
  const frame = await readFile(seed), video = Buffer.alloc(maximumBytes);
  assert.ok(frame.length < maximumBytes - 8); frame.copy(video);
  video.writeUInt32BE(maximumBytes - frame.length, frame.length); video.write('free', frame.length + 4, 'ascii');
  const wantedHash = createHash('sha256').update(video).digest('hex');
  phase('Prepared a valid private 120 MiB MP4 fixture.');

  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', fixture, '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: fixture, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', DATA_DIR: data, APP_URL: base, SESSION_SECRET: 'isolated-upload-check-secret-not-production' },
  });
  child.on('exit', code => { exitCode = code ?? -1; });
  const collect = chunk => { serverLog = (serverLog + chunk.toString()).slice(-100000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (exitCode !== null) throw Error(`Isolated Next server exited early (${exitCode}).`);
    try { const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) }); if (response.ok) { ready = true; break; } } catch { /* Wait for local compilation only. */ }
    await delay(500);
  }
  assert.ok(ready, 'isolated Next server must become ready');
  const endpoint = `${base}/api/admin/telegram/hot-videos`;
  async function json(url, method = 'GET', body, extraHeaders = {}) {
    const response = await fetch(url, { method, headers: { Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
    const text = await response.text(); let value;
    try { value = JSON.parse(text); } catch { throw Error(`${method} returned non-JSON (${response.status}): ${text.slice(0, 300)}`); }
    assert.ok(response.ok, `${method} failed (${response.status}): ${JSON.stringify(value)}`);
    assert.equal(response.headers.get('cache-control'), 'no-store'); return value;
  }
  async function chunk(uploadId, offset, bytes) {
    const response = await fetch(`${endpoint}/uploads/${uploadId}`, { method: 'PUT', headers: {
      Origin: base, 'Content-Type': 'application/octet-stream', 'X-Video-Offset': String(offset),
    }, body: bytes, signal: AbortSignal.timeout(60000) });
    const value = await response.json(); assert.ok(response.ok, `chunk failed (${response.status}): ${JSON.stringify(value)}`);
    assert.equal(response.headers.get('cache-control'), 'no-store'); return value;
  }
  async function waitForOffset(uploadId, expected) {
    let observed;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(`${endpoint}/uploads/${uploadId}`, { headers: { Origin: base }, signal: AbortSignal.timeout(5000) });
      if (response.ok) { observed = await response.json(); if (observed.receivedBytes === expected) return observed; }
      await delay(100);
    }
    assert.fail(`aborted chunk must return to committed offset ${expected}; observed ${JSON.stringify(observed)}`);
  }
  async function interruptChunk(uploadId, offset) {
    await new Promise((resolve, reject) => {
      let closed = false;
      const outgoing = httpRequest(`${endpoint}/uploads/${uploadId}`, { method: 'PUT', headers: {
        Origin: base, 'Content-Type': 'application/octet-stream', 'X-Video-Offset': String(offset), 'Content-Length': String(chunkBytes),
      } }, response => { response.resume(); response.on('end', () => { if (!closed) { closed = true; reject(Error(`partial chunk unexpectedly responded ${response.statusCode}`)); } }); });
      outgoing.on('error', error => { if (!closed) { closed = true; if (error.code === 'ECONNRESET') resolve(); else reject(error); } });
      outgoing.write(video.subarray(offset, offset + 128 * 1024), () => setTimeout(() => outgoing.destroy(), 100));
      outgoing.setTimeout(10000, () => outgoing.destroy(Error('Local partial chunk test timed out')));
    });
  }

  const requestId = randomUUID(), metadata = { requestId, title: 'Private integration black frame', originalName: 'black-frame.mp4', bytes: video.length };
  const started = await json(`${endpoint}/uploads`, 'POST', metadata);
  assert.equal(started.id, requestId); assert.equal(started.receivedBytes, 0); assert.equal(started.chunkBytes, chunkBytes); assert.equal(started.state, 'uploading');
  const repeatedStart = await json(`${endpoint}/uploads`, 'POST', metadata); assert.equal(repeatedStart.id, started.id);
  phase('Started one resumable upload through actual Next HTTP routes.');

  let state = await chunk(started.id, 0, video.subarray(0, chunkBytes)); assert.equal(state.receivedBytes, chunkBytes);
  // Simulate a lost acknowledgement by ignoring a successful chunk response and
  // sending its identical offset/body again: committed bytes must not double.
  const duplicate = await chunk(started.id, 0, video.subarray(0, chunkBytes)); assert.equal(duplicate.receivedBytes, chunkBytes);
  await interruptChunk(started.id, chunkBytes);
  state = await waitForOffset(started.id, chunkBytes); assert.equal(state.state, 'uploading');
  phase('Verified lost-ack duplicate and real mid-request disconnect/resume.');

  for (let offset = chunkBytes; offset < video.length; offset += chunkBytes) {
    state = await chunk(started.id, offset, video.subarray(offset, Math.min(offset + chunkBytes, video.length)));
    assert.equal(state.receivedBytes, Math.min(offset + chunkBytes, video.length));
  }
  assert.equal(state.receivedBytes, maximumBytes);
  const status = await json(`${endpoint}/uploads/${started.id}/complete`, 'POST', {});
  assert.equal(status.videos.length, 1); assert.equal(status.jobs.length, 0); assert.equal(status.enabled, false);
  const completedAgain = await json(`${endpoint}/uploads/${started.id}/complete`, 'POST', {});
  assert.equal(completedAgain.videos.length, 1); assert.equal(completedAgain.videos[0].id, status.videos[0].id);
  const finished = await json(`${endpoint}/uploads/${started.id}`); assert.equal(finished.state, 'complete'); assert.equal(finished.videoId, status.videos[0].id);
  const finalStatus = await json(endpoint); assert.equal(finalStatus.videos.length, 1); assert.equal(finalStatus.jobs.length, 0);
  const health = await (await fetch(`${base}/api/health`)).json(); assert.equal(health.telegramCalls, 0);

  db = new DatabaseSync(path.join(data, 'directory.sqlite'), { readOnly: true });
  const rows = db.prepare('SELECT id,file_name,bytes,sha256 FROM telegram_hot_videos WHERE deleted_at=0').all();
  assert.equal(rows.length, 1); assert.equal(rows[0].bytes, maximumBytes); assert.equal(rows[0].sha256, wantedHash);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM telegram_hot_video_jobs').get().count, 0);
  const stored = path.join(data, 'hot-videos', rows[0].file_name);
  assert.equal((await stat(stored)).size, maximumBytes); assert.equal((await stat(stored)).mode & 0o777, 0o600);
  assert.equal(createHash('sha256').update(await readFile(stored)).digest('hex'), wantedHash);
  assert.deepEqual(await readdir(path.dirname(stored)), [rows[0].file_name]);
  phase('PASS: 120 MiB stored once with exact SHA, private permissions, idempotent completion and zero channel jobs/calls.');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  if (serverLog) process.stderr.write(`\nIsolated Next log:\n${serverLog.slice(-14000)}\n`);
  process.exitCode = 1;
} finally {
  db?.close(); await stopServer(); await rm(fixture, { recursive: true, force: true });
}
