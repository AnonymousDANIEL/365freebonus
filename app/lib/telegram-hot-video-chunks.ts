import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { HOT_VIDEO_MAX_BYTES, HotVideoError, hotVideoStorageDirectory, registerHotVideo, reserveHotVideoUpload } from "./telegram-hot-videos";

export const HOT_VIDEO_CHUNK_BYTES = 1024 * 1024;
const TTL_MS = 10 * 60_000, LEASE_MS = 120_000, READ_MS = 90_000, MAX_CHUNKS = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Session = { id: string; request_id: string; title: string; original_name: string; bytes: number; received_bytes: number;
  created_at: number; updated_at: number; state: string; lease_id: string; lease_until: number };
type Saved = { id: string; bytes: number; file_name: string; deleted_at: number };
type StartInput = { requestId: string; title: string; originalName: string; bytes: number };
type Claim = { session: Session; leaseId: string };
type Phase = "open" | "read" | "write" | "fsync" | "ack" | "complete";
const FILE_ERROR = "已保存的视频片段不完整，请取消后重新上传。";
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function validId(id: string) { if (typeof id !== "string" || !UUID.test(id)) throw new HotVideoError("上传编号无效。", 400); }
function paths(id: string) {
  validId(id); const folder = hotVideoStorageDirectory();
  return { folder, part: path.join(folder, `${id}.part`), final: path.join(folder, `${id}.mp4`) };
}
function session(db: DatabaseSync, id: string): Session | undefined {
  return db.prepare("SELECT * FROM telegram_hot_video_upload_sessions WHERE id=?").get(id) as Session | undefined;
}
function saved(db: DatabaseSync, id: string): Saved | undefined {
  return db.prepare("SELECT id,bytes,file_name,deleted_at FROM telegram_hot_videos WHERE id=?").get(id) as Saved | undefined;
}
function finished(db: DatabaseSync, value: Session): boolean {
  const video = saved(db, value.id);
  if (!video) return false;
  if (video.deleted_at) throw new HotVideoError("这个视频已从后台删除，请重新选择视频。", 410);
  if (video.bytes !== value.bytes || video.file_name !== `${value.id}.mp4`) throw new HotVideoError(FILE_ERROR, 409);
  return true;
}
function status(value: Session, complete: boolean) {
  return { id: value.id, requestId: value.request_id, bytes: value.bytes, receivedBytes: complete ? value.bytes : value.received_bytes,
    chunkBytes: HOT_VIDEO_CHUNK_BYTES, state: complete ? "complete" as const : "uploading" as const,
    expiresAt: complete ? null : value.updated_at + TTL_MS, videoId: complete ? value.id : null };
}
function requireSession(db: DatabaseSync, id: string): Session {
  validId(id); const value = session(db, id);
  if (!value) throw new HotVideoError("上传会话不存在，请重新选择视频。", 404);
  return value;
}
function requireLive(value: Session, now: number) {
  if (value.state !== "uploading" || value.updated_at <= now - TTL_MS) throw new HotVideoError("上传已过期或取消，请重新上传。", 410);
}
function removeUnregistered(db: DatabaseSync, value: Session, nextState: "cancelled" | "expired") {
  if (saved(db, value.id)) return;
  const file = paths(value.id);
  for (const filename of [file.part, file.final]) {
    try { unlinkSync(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new HotVideoError("暂时无法清理上传，请稍后重试。", 503); }
  }
  db.prepare("DELETE FROM telegram_hot_video_uploads WHERE id=?").run(value.id);
  db.prepare("DELETE FROM telegram_hot_video_upload_chunks WHERE upload_id=?").run(value.id);
  db.prepare("UPDATE telegram_hot_video_upload_sessions SET state=?,lease_id='',lease_until=0 WHERE id=?").run(nextState, value.id);
}
function cleanupExpired(db: DatabaseSync, now: number) {
  transaction(db, () => {
    const values = db.prepare(`SELECT * FROM telegram_hot_video_upload_sessions WHERE state='uploading' AND updated_at<=?
      AND lease_until<=? ORDER BY updated_at LIMIT 100`).all(now - TTL_MS, now) as Session[];
    for (const value of values) {
      if (saved(db, value.id)) {
        db.prepare("UPDATE telegram_hot_video_upload_sessions SET state='complete',lease_id='',lease_until=0 WHERE id=?").run(value.id);
        db.prepare("DELETE FROM telegram_hot_video_uploads WHERE id=?").run(value.id);
      } else removeUnregistered(db, value, "expired");
    }
  });
}
export function startHotVideoUpload(db: DatabaseSync, input: StartInput, clock = Date.now) {
  if (!input || typeof input.requestId !== "string" || !UUID.test(input.requestId) || !Number.isSafeInteger(input.bytes) || input.bytes < 24 || input.bytes > HOT_VIDEO_MAX_BYTES)
    throw new HotVideoError("请选择有效的 MP4 视频，Telegram 原画上传上限为 2000 MB。", 413);
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 160 || /[\u0000-\u001f\u007f]/.test(input.title)
    || typeof input.originalName !== "string" || !input.originalName.trim() || input.originalName.length > 255
    || /[\u0000-\u001f\u007f/\\]/.test(input.originalName) || !/\.mp4$/i.test(input.originalName)) throw new HotVideoError("请检查视频名称和 MP4 文件名。", 400);
  const title = input.title.trim() || input.originalName.replace(/\.mp4$/i, "").slice(0, 160) || "Video";
  const previous = session(db, input.requestId);
  if (previous) {
    if (previous.bytes !== input.bytes || previous.title !== title || previous.original_name !== input.originalName) throw new HotVideoError("上传编号已用于另一个视频，请重新选择。", 409);
    if (finished(db, previous)) return status(previous, true);
    requireLive(previous, clock()); return status(previous, false);
  }
  cleanupExpired(db, clock());
  const file = paths(input.requestId); let created = false;
  try {
    reserveHotVideoUpload(db, { id: input.requestId, bytes: input.bytes }, clock, now => {
      const fd = openSync(file.part, "wx", 0o600); created = true;
      try { fsyncSync(fd); } finally { closeSync(fd); }
      db.prepare(`INSERT INTO telegram_hot_video_upload_sessions(id,request_id,title,original_name,bytes,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)`).run(input.requestId, input.requestId, title, input.originalName, input.bytes, now, now);
    });
  } catch (error) {
    if (created && !session(db, input.requestId) && !saved(db, input.requestId)) { try { unlinkSync(file.part); } catch { /* orphan sweep is bounded and private */ } }
    if (error instanceof HotVideoError) throw error;
    throw new HotVideoError("无法开始上传，请重新选择视频后重试。", 503);
  }
  return status(requireSession(db, input.requestId), false);
}
export function hotVideoUploadStatus(db: DatabaseSync, id: string, clock = Date.now) {
  const value = requireSession(db, id);
  if (finished(db, value)) return status(value, true);
  if (value.updated_at <= clock() - TTL_MS && value.lease_until <= clock()) {
    transaction(db, () => { const latest = requireSession(db, id); if (!saved(db, id) && latest.lease_until <= clock()) removeUnregistered(db, latest, "expired"); });
  }
  requireLive(requireSession(db, id), clock());
  return status(requireSession(db, id), false);
}
function claimSession(db: DatabaseSync, id: string, clock: () => number): Claim {
  return transaction(db, () => {
    const value = requireSession(db, id), now = clock(); requireLive(value, now);
    if (value.lease_until > now) throw new HotVideoError("上一片段仍在保存，请稍后继续上传。", 409);
    const reservation = db.prepare("SELECT bytes FROM telegram_hot_video_uploads WHERE id=?").get(id) as { bytes: number } | undefined;
    if (!reservation || reservation.bytes !== value.bytes) throw new HotVideoError("上传空间预留已过期，请重新上传。", 410);
    const leaseId = randomUUID();
    db.prepare("UPDATE telegram_hot_video_upload_sessions SET lease_id=?,lease_until=?,updated_at=? WHERE id=?").run(leaseId, now + LEASE_MS, now, id);
    db.prepare("UPDATE telegram_hot_video_uploads SET created_at=? WHERE id=?").run(now, id);
    return { session: { ...value, updated_at: now, lease_id: leaseId, lease_until: now + LEASE_MS }, leaseId };
  });
}
function owns(db: DatabaseSync, claim: Claim, clock: () => number) {
  const value = session(db, claim.session.id);
  return value?.state === "uploading" && value.lease_id === claim.leaseId && value.lease_until > clock() && value.received_bytes === claim.session.received_bytes && !saved(db, value.id);
}
function releaseLease(db: DatabaseSync, claim: Claim) {
  db.prepare("UPDATE telegram_hot_video_upload_sessions SET lease_id='',lease_until=0 WHERE id=? AND lease_id=?").run(claim.session.id, claim.leaseId);
}
function diagnostics(phase: Phase, error: unknown, receivedBytes: number, expectedBytes: number) {
  const code = error instanceof HotVideoError ? error.status : 503;
  const rawCode = (error as NodeJS.ErrnoException | undefined)?.code;
  const category = rawCode === "ENOSPC" ? "storage_full" : rawCode === "EACCES" || rawCode === "EPERM" ? "permission"
    : code === 408 ? "timeout" : code === 413 ? "size" : rawCode === "ENOENT" || rawCode === "ELOOP" ? "file_missing"
      : code === 400 || code === 415 ? "format" : "io";
  if (code === 409 || code === 404 || code === 410) return;
  console.warn("Telegram Hot video chunk upload failed.", JSON.stringify({ phase, receivedBytes, expectedBytes, status: code, errorCategory: category }));
}
async function readChunk(request: Request) {
  const contentType = (request.headers.get("content-type") || "").toLowerCase().split(";", 1)[0].trim();
  if (contentType && contentType !== "application/octet-stream") throw new HotVideoError("请使用视频分片上传。", 415);
  const rawLength = request.headers.get("content-length");
  const expected = rawLength === null ? null : /^\d+$/.test(rawLength) ? Number(rawLength) : NaN;
  if (expected !== null && (!Number.isSafeInteger(expected) || expected <= 0 || expected > HOT_VIDEO_CHUNK_BYTES)) throw new HotVideoError("每个视频片段最多 1 MiB。", 413);
  if (!request.body) throw new HotVideoError("视频片段为空。", 400);
  const reader = request.body.getReader(), chunks: Buffer[] = [], deadline = Date.now() + READ_MS; let size = 0;
  try {
    for (;;) {
      if (request.signal.aborted) throw new HotVideoError("片段上传已中断，请继续上传。", 408);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const item = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HotVideoError("片段上传超时，请继续上传。", 408)), Math.max(1, deadline - Date.now()));
      })]).finally(() => { if (timer) clearTimeout(timer); });
      if (item.done) break;
      size += item.value.byteLength;
      if (size > HOT_VIDEO_CHUNK_BYTES || expected !== null && size > expected) throw new HotVideoError("视频片段超过声明大小。", 413);
      chunks.push(Buffer.from(item.value));
    }
  } finally { reader.releaseLock(); }
  if (!size || expected !== null && size !== expected) throw new HotVideoError("视频片段未能完整接收，请继续上传。", 400);
  return Buffer.concat(chunks, size);
}
function reconcileFile(fd: number, acknowledged: number) {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size < acknowledged) throw new HotVideoError(FILE_ERROR, 410);
  if (stat.size > acknowledged) { ftruncateSync(fd, acknowledged); fsyncSync(fd); }
}
export async function appendHotVideoChunk(db: DatabaseSync, id: string, offset: number, request: Request, clock = Date.now) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new HotVideoError("视频分片位置无效。", 400);
  const value = requireSession(db, id);
  if (finished(db, value)) return status(value, true);
  if (offset > value.received_bytes || offset >= value.bytes) throw new HotVideoError("上传进度已改变，请重新读取进度。", 409);
  const claim = claimSession(db, id, clock), file = paths(id);
  let fd: number | undefined, phase: Phase = "open";
  try {
    fd = openSync(file.part, constants.O_RDWR | constants.O_NOFOLLOW);
    transaction(db, () => { if (!owns(db, claim, clock)) throw new HotVideoError("上传进度已改变，请重试。", 409); reconcileFile(fd!, claim.session.received_bytes); });
    phase = "read";
    const chunk = await readChunk(request), digest = createHash("sha256").update(chunk).digest("hex");
    if (offset + chunk.length > claim.session.bytes) throw new HotVideoError("视频片段超过文件大小。", 413);
    return transaction(db, () => {
      if (!owns(db, claim, clock)) throw new HotVideoError("上传已由其他请求接续，请重新读取进度。", 409);
      reconcileFile(fd!, claim.session.received_bytes);
      if (offset < claim.session.received_bytes) {
        const prior = db.prepare("SELECT bytes,sha256 FROM telegram_hot_video_upload_chunks WHERE upload_id=? AND offset=?").get(id, offset) as { bytes: number; sha256: string } | undefined;
        if (!prior || prior.bytes !== chunk.length || prior.sha256 !== digest || offset + chunk.length > claim.session.received_bytes) throw new HotVideoError("重复片段内容不一致，请重新读取进度。", 409);
        const actual = Buffer.alloc(chunk.length); let read = 0;
        while (read < actual.length) { const n = readSync(fd!, actual, read, actual.length - read, offset + read); if (!n) throw new HotVideoError(FILE_ERROR, 410); read += n; }
        if (createHash("sha256").update(actual).digest("hex") !== digest) throw new HotVideoError(FILE_ERROR, 410);
        releaseLease(db, claim); return status({ ...claim.session, updated_at: clock() }, false);
      }
      const count = db.prepare("SELECT COUNT(*) AS n FROM telegram_hot_video_upload_chunks WHERE upload_id=?").get(id) as { n: number };
      if (count.n >= MAX_CHUNKS) throw new HotVideoError("视频片段过多，请重新上传。", 413);
      phase = "write";
      let written = 0;
      while (written < chunk.length) { const n = writeSync(fd!, chunk, written, chunk.length - written, offset + written); if (!n) throw new HotVideoError("视频片段未能保存，请继续上传。", 503); written += n; }
      phase = "fsync"; fsyncSync(fd!);
      phase = "ack"; const now = clock(), received = offset + chunk.length;
      db.prepare("INSERT INTO telegram_hot_video_upload_chunks(upload_id,offset,bytes,sha256,created_at) VALUES(?,?,?,?,?)").run(id, offset, chunk.length, digest, now);
      db.prepare("UPDATE telegram_hot_video_upload_sessions SET received_bytes=?,updated_at=?,lease_id='',lease_until=0 WHERE id=? AND lease_id=?").run(received, now, id, claim.leaseId);
      db.prepare("UPDATE telegram_hot_video_uploads SET created_at=? WHERE id=?").run(now, id);
      return status({ ...claim.session, received_bytes: received, updated_at: now }, false);
    });
  } catch (error) {
    transaction(db, () => {
      const latest = session(db, id);
      if (latest?.lease_id !== claim.leaseId || saved(db, id)) return;
      if (fd !== undefined) { try { ftruncateSync(fd, latest.received_bytes); fsyncSync(fd); } catch { /* original error remains primary */ } }
      releaseLease(db, claim);
    });
    diagnostics(phase, error, claim.session.received_bytes, claim.session.bytes);
    if (error instanceof HotVideoError) throw error;
    throw new HotVideoError("片段连接中断或未能保存，请继续上传。", 503);
  } finally { if (fd !== undefined) closeSync(fd); }
}
async function verifiedFile(filename: string, expected: number) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expected) throw new HotVideoError(FILE_ERROR, 410);
    const header = Buffer.alloc(64), digest = createHash("sha256"); let received = 0;
    for await (const part of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      if (received < 64) chunk.copy(header, received, 0, Math.min(chunk.length, 64 - received));
      received += chunk.length; if (received > expected) throw new HotVideoError(FILE_ERROR, 410); digest.update(chunk);
    }
    if (received !== expected || received < 24 || header.toString("ascii", 4, 8) !== "ftyp" || header.readUInt32BE(0) < 16 || header.readUInt32BE(0) > expected)
      throw new HotVideoError("视频不是完整的 MP4 文件，请重新选择。", 400);
    return digest.digest("hex");
  } finally { await handle.close(); }
}
export async function finalizeHotVideoUpload(db: DatabaseSync, id: string, clock = Date.now) {
  const value = requireSession(db, id);
  if (finished(db, value)) return status(value, true);
  if (value.received_bytes !== value.bytes) throw new HotVideoError("视频尚未完整上传，请继续上传。", 409);
  const claim = claimSession(db, id, clock), file = paths(id); let phase: Phase = "open";
  try {
    let filename = file.part;
    try { lstatSync(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; filename = file.final; }
    phase = "complete";
    const sha256 = await verifiedFile(filename, value.bytes);
    transaction(db, () => {
      if (!owns(db, claim, clock)) throw new HotVideoError("上传状态已改变，请重新读取进度。", 409);
      if (filename === file.part) {
        try { lstatSync(file.final); throw new HotVideoError("视频保存目标已存在，请重新读取进度。", 409); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        renameSync(file.part, file.final);
        const directory = openSync(file.folder, constants.O_RDONLY); try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    });
    if (!owns(db, claim, clock)) throw new HotVideoError("上传状态已改变，请重新读取进度。", 409);
    registerHotVideo(db, { id, title: value.title, originalName: value.original_name, fileName: `${id}.mp4`, bytes: value.bytes, sha256 }, clock);
    // The video row is the completion authority. No error after this commit may
    // delete its file; GET/finalize can recover even if this bookkeeping fails.
    try {
      transaction(db, () => {
        db.prepare("UPDATE telegram_hot_video_upload_sessions SET state='complete',received_bytes=bytes,updated_at=?,lease_id='',lease_until=0 WHERE id=?").run(clock(), id);
        db.prepare("DELETE FROM telegram_hot_video_upload_chunks WHERE upload_id=?").run(id);
      });
    } catch { /* a confirmed video remains authoritative */ }
    return status(value, true);
  } catch (error) {
    if (saved(db, id)) return status(value, true);
    releaseLease(db, claim); diagnostics(phase, error, value.received_bytes, value.bytes);
    if (error instanceof HotVideoError) throw error;
    throw new HotVideoError("视频暂时未能保存，请继续完成上传。", 503);
  }
}
export function cancelHotVideoUpload(db: DatabaseSync, id: string, clock = Date.now) {
  transaction(db, () => {
    const value = requireSession(db, id);
    if (saved(db, id)) throw new HotVideoError("视频已保存，请到视频列表删除。", 409);
    if (value.state === "cancelled" || value.state === "expired") return;
    if (value.lease_until > clock()) throw new HotVideoError("上一片段仍在处理，请稍后取消。", 409);
    removeUnregistered(db, value, "cancelled");
  });
}
