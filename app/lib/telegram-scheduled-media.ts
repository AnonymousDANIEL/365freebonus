import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { lstat, mkdir, open, readdir, statfs, unlink } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import sharp from "sharp";
import { getDataDirectory } from "./sqlite";
import { telegramScheduledMediaFileRequest } from "./telegram-bot";
import { readHotVideoMetadata } from "./telegram-hot-video-mp4";
import type { ScheduledMessageMedia } from "./telegram-scheduled-messages-types";

const MIB = 1024 * 1024;
const CHUNK_BYTES = 4 * MIB;
const FREE_BYTES = 64 * MIB;
const RETAIN_UNATTACHED_MS = 24 * 60 * 60_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MEDIA = {
  "image/jpeg": { kind: "photo", extension: "jpg", maxBytes: 10 * MIB },
  "image/png": { kind: "photo", extension: "png", maxBytes: 10 * MIB },
  "image/gif": { kind: "animation", extension: "gif", maxBytes: 20 * MIB },
  "video/mp4": { kind: "video", extension: "mp4", maxBytes: 50 * MIB },
} as const;
type Mime = keyof typeof MEDIA;
type StoredMedia = ScheduledMessageMedia & { mime: Mime };
const invalidMedia = () => new ScheduledMessageMediaError(415, "请选择完整的 JPG、PNG、GIF 或 MP4 文件。");
const invalidChunk = () => new ScheduledMessageMediaError(409, "上传进度已改变，请重新选择文件。");
const noSpace = () => new ScheduledMessageMediaError(507, "媒体储存空间不足，请清理不需要的定时计划后再试。");

export class ScheduledMessageMediaError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function isMime(value: string): value is Mime {
  return Object.hasOwn(MEDIA, value);
}
function directory() { return path.join(getDataDirectory(), "telegram-scheduled-media"); }
function mediaPath(id: string) { return path.join(directory(), `${id}.bin`); }
function partialPath(id: string) { return path.join(directory(), `${id}.part`); }
function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function readStoredMedia(db: DatabaseSync, id: string): StoredMedia | null {
  if (!UUID.test(id)) return null;
  const row = db.prepare("SELECT id,kind,name,bytes,mime FROM telegram_scheduled_message_media WHERE id=?").get(id) as StoredMedia | undefined;
  return row && isMime(row.mime) && row.kind === MEDIA[row.mime].kind && Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= MEDIA[row.mime].maxBytes
    ? row : null;
}
function publicMedia(row: StoredMedia): ScheduledMessageMedia {
  return { id: row.id, kind: row.kind, name: row.name, bytes: row.bytes };
}
export function readScheduledMessageMedia(db: DatabaseSync, id: string): ScheduledMessageMedia | null {
  const row = readStoredMedia(db, id);
  return row ? publicMedia(row) : null;
}

const cleanupTimes = new Map<string, number>();
async function cleanupUnattached(db: DatabaseSync, now: number) {
  const dir = directory();
  if (now - (cleanupTimes.get(dir) ?? -Infinity) < 15 * 60_000) return;
  cleanupTimes.set(dir, now);
  const cutoff = now - RETAIN_UNATTACHED_MS;
  const expired = db.prepare(`DELETE FROM telegram_scheduled_message_media AS m
    WHERE created_at < ? AND NOT EXISTS(SELECT 1 FROM telegram_scheduled_message_plans p WHERE p.media_id=m.id AND p.deleted_at=0)
      AND NOT EXISTS(SELECT 1 FROM telegram_scheduled_message_deliveries d WHERE d.media_id=m.id AND d.status IN ('pending','sending','unknown'))
    RETURNING id`).all(cutoff) as { id: string }[];
  await Promise.all(expired.filter(row => UUID.test(row.id)).map(row => unlink(mediaPath(row.id)).catch(() => undefined)));
  // A process crash can leave a partial or unregistered file. Recent uploads
  // and all registered media are still eligible for replay and preview.
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name);
    const id = path.basename(entry.name, extension);
    if (!UUID.test(id) || (extension !== ".part" && extension !== ".bin")) continue;
    const name = extension === ".part" ? partialPath(id) : mediaPath(id);
    const metadata = await lstat(name).catch(() => null);
    if (!metadata || metadata.mtimeMs >= cutoff) continue;
    // Recheck under the same lock used by chunk writes and registration.
    inTransaction(db, () => {
      if (extension === ".bin" && db.prepare("SELECT 1 FROM telegram_scheduled_message_media WHERE id=?").get(id)) return;
      let fd;
      try {
        fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW);
        if (fstatSync(fd).mtimeMs < cutoff) unlinkSync(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } finally { if (fd !== undefined) closeSync(fd); }
    });
  }
}

async function readChunk(request: Request, expected: number): Promise<Buffer> {
  const length = request.headers.get("content-length");
  if (!request.body || length !== null && length !== String(expected)) throw invalidChunk();
  const reader = request.body.getReader();
  const body = Buffer.allocUnsafe(expected);
  let offset = 0;
  const expire = setTimeout(() => void reader.cancel("Upload timeout").catch(() => undefined), 55_000);
  expire.unref();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (offset + next.value.byteLength > expected) throw invalidChunk();
      body.set(next.value, offset);
      offset += next.value.byteLength;
    }
    if (offset !== expected || request.signal.aborted) throw invalidChunk();
    return body;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { clearTimeout(expire); reader.releaseLock(); }
}

function chunkMatches(fd: number, offset: number, chunk: Buffer) {
  const existing = Buffer.allocUnsafe(chunk.length);
  for (let read = 0; read < existing.length;) {
    const n = readSync(fd, existing, read, existing.length - read, offset + read);
    if (!n) return false;
    read += n;
  }
  return existing.equals(chunk);
}

function writeChunk(id: string, start: number, chunk: Buffer): number {
  const file = partialPath(id);
  const fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW | (start === 0 ? constants.O_CREAT : 0), 0o600);
  try {
    const current = fstatSync(fd);
    if (!current.isFile() || start > current.size) throw invalidChunk();
    const overlap = Math.min(current.size - start, chunk.length);
    if (overlap > 0 && !chunkMatches(fd, start, chunk.subarray(0, overlap))) throw invalidChunk();
    try {
      for (let written = overlap; written < chunk.length;) {
        const n = writeSync(fd, chunk, written, chunk.length - written, start + written);
        if (!n) throw new Error("Unable to write media.");
        written += n;
      }
      if (overlap < chunk.length) fsyncSync(fd);
    } catch (error) { ftruncateSync(fd, current.size); throw error; }
    return Math.max(current.size, start + chunk.length);
  } finally { closeSync(fd); }
}

async function inspectMedia(file: string, size: number, declared: string): Promise<Mime> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const head = Buffer.alloc(16), tail = Buffer.alloc(1);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== size || size < head.length) throw invalidMedia();
    if ((await handle.read(head, 0, head.length, 0)).bytesRead !== head.length ||
      (await handle.read(tail, 0, 1, size - 1)).bytesRead !== 1) throw invalidMedia();
  } finally { await handle.close(); }
  const signature = head.toString("ascii", 0, 6);
  const mime = head[0] === 0xff && head[1] === 0xd8 ? "image/jpeg"
    : head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
    : ["GIF87a", "GIF89a"].includes(signature) && tail[0] === 0x3b ? "image/gif"
    : head.toString("ascii", 4, 8) === "ftyp" ? "video/mp4" : null;
  if (!mime || declared !== "application/octet-stream" && mime !== declared) throw invalidMedia();
  if (size > MEDIA[mime].maxBytes) throw new ScheduledMessageMediaError(413, "文件超过此媒体类型的上传大小上限。");
  try {
    if (mime === "video/mp4") await readHotVideoMetadata(file, size);
    else {
      const image = sharp(file, { animated: false, sequentialRead: true, limitInputPixels: 24_000_000 }).timeout({ seconds: 4 });
      const metadata = await image.metadata();
      const { width, height } = metadata;
      const format = IMAGE_FORMAT[mime];
      if (metadata.format !== format || !width || !height || width * height > 24_000_000 ||
        mime !== "image/gif" && (width + height > 10_000 || Math.max(width, height) / Math.min(width, height) > 20))
        throw invalidMedia();
      await image.resize(1, 1).toBuffer();
    }
  } catch { throw invalidMedia(); }
  return mime;
}
const IMAGE_FORMAT = { "image/jpeg": "jpeg", "image/png": "png", "image/gif": "gif" } as const;

function attachmentName(name: string, mime: Mime) {
  const original = name.split(/[\\/]/u).at(-1)?.replace(/[\p{Cc}\p{Cf}]/gu, "").trim() ?? "";
  const basename = original.replace(/\.[^.]*$/u, "").slice(0, 190).trim() || MEDIA[mime].kind;
  return `${basename}.${MEDIA[mime].extension}`;
}

function completedUpload(row: StoredMedia, offset: number, chunk: Buffer) {
  let fd: number | undefined;
  try {
    fd = openSync(mediaPath(row.id), constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(fd);
    if (metadata.isFile() && metadata.size === row.bytes && chunkMatches(fd, offset, chunk)) return publicMedia(row);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
  throw invalidChunk();
}

/** Accept a stable upload UUID and sequential, replay-safe chunks within Next's body limit. */
export async function storeScheduledMessageMedia(db: DatabaseSync, request: Request): Promise<ScheduledMessageMedia | { id: string; received: number }> {
  const params = new URL(request.url).searchParams;
  const id = params.get("uploadId") ?? "", rawSize = params.get("size") ?? "", rawOffset = params.get("offset") ?? "";
  const declared = (request.headers.get("content-type") || "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
  if (declared !== "application/octet-stream" && !isMime(declared)) throw invalidMedia();
  const size = Number(rawSize), start = Number(rawOffset), max = isMime(declared) ? MEDIA[declared].maxBytes : MEDIA["video/mp4"].maxBytes;
  if (!UUID.test(id) || !/^[1-9]\d{0,8}$/u.test(rawSize) || !/^(?:0|[1-9]\d{0,8})$/u.test(rawOffset) || start >= size || start % CHUNK_BYTES !== 0)
    throw new ScheduledMessageMediaError(400, "上传资料不完整，请重新选择文件。");
  if (size > max) throw new ScheduledMessageMediaError(413, "文件超过此媒体类型的上传大小上限。");

  const replay = () => {
    const row = readStoredMedia(db, id);
    if (row && (row.bytes !== size || declared !== "application/octet-stream" && row.mime !== declared ||
      row.name !== attachmentName(params.get("name") ?? "", row.mime))) throw invalidChunk();
    return row;
  };
  const saved = replay();
  const chunk = await readChunk(request, Math.min(CHUNK_BYTES, size - start));
  if (saved) return completedUpload(saved, start, chunk);
  const dir = directory();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await cleanupUnattached(db, Date.now());
  const disk = await statfs(dir, { bigint: true });
  if (disk.bavail * disk.bsize < BigInt(chunk.length + FREE_BYTES)) throw noSpace();

  const progress = inTransaction(db, () => {
    const registered = replay();
    if (registered) return completedUpload(registered, start, chunk);
    try { return writeChunk(id, start, chunk); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw invalidChunk();
      if (code === "ENOSPC" || code === "EDQUOT") throw noSpace();
      throw error;
    }
  });
  if (typeof progress !== "number") return progress;
  if (progress < size) return { id, received: progress };
  if (progress !== size) throw invalidChunk();

  const partial = partialPath(id), destination = mediaPath(id);
  let mime: Mime;
  try { mime = await inspectMedia(partial, size, declared); }
  catch (error) {
    return inTransaction(db, () => {
      const registered = replay();
      if (registered) return completedUpload(registered, start, chunk);
      if (error instanceof ScheduledMessageMediaError) {
        try { unlinkSync(partial); } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
      }
      throw error;
    });
  }
  const row: StoredMedia = { id, kind: MEDIA[mime].kind, mime, bytes: size, name: attachmentName(params.get("name") ?? "", mime) };
  let renamed = false;
  try {
    return inTransaction(db, () => {
      const registered = replay();
      if (registered) return completedUpload(registered, start, chunk);
      renameSync(partial, destination);
      renamed = true;
      db.prepare("INSERT INTO telegram_scheduled_message_media(id,kind,name,bytes,mime,created_at) VALUES(?,?,?,?,?,?)")
        .run(id, row.kind, row.name, row.bytes, row.mime, Date.now());
      return publicMedia(row);
    });
  } catch (error) {
    if (renamed) await unlink(destination).catch(() => undefined);
    throw error;
  }
}

async function openStoredMedia(row: StoredMedia) {
  const handle = await open(mediaPath(row.id), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (stat.isFile() && stat.size === row.bytes) return handle;
  } catch { /* Missing or replaced media is handled before Telegram dispatch. */ }
  await handle.close().catch(() => undefined);
  return null;
}

export async function sendScheduledMessageMedia(db: DatabaseSync, token: string, chatId: number, caption: string, id: string) {
  const row = readStoredMedia(db, id);
  const handle = row && await openStoredMedia(row);
  if (!row || !handle || caption.length > 1024) {
    await handle?.close();
    return { ok: false, code: 400, retryAfter: 0 } as const;
  }
  await handle.close();
  return telegramScheduledMediaFileRequest(token, chatId, caption, {
    path: mediaPath(id), fileName: row.name, bytes: row.bytes, kind: row.kind, mime: row.mime,
  });
}

function previewRange(header: string, size: number): [number, number] | null {
  const match = /^bytes=(\d{0,12})-(\d{0,12})$/u.exec(header);
  if (!match || !match[1] && !match[2]) return null;
  const first = match[1], last = match[2];
  const start = first ? Number(first) : Math.max(0, size - Number(last));
  const end = first && last ? Math.min(size - 1, Number(last)) : size - 1;
  return start <= end && start < size ? [start, end] : null;
}

export async function scheduledMessageMediaPreview(db: DatabaseSync, id: string, rangeHeader: string | null): Promise<Response> {
  const row = readStoredMedia(db, id);
  if (!row) throw new ScheduledMessageMediaError(404, "找不到此附件。");
  const headers = new Headers({ "Cache-Control": "private, no-store", "Content-Type": row.mime, "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "same-origin",
    "Accept-Ranges": "bytes" });
  const range = rangeHeader ? previewRange(rangeHeader, row.bytes) : null;
  if (rangeHeader && !range) {
    headers.set("Content-Range", `bytes */${row.bytes}`);
    return new Response(null, { status: 416, headers });
  }
  const handle = await openStoredMedia(row);
  if (!handle) throw new ScheduledMessageMediaError(404, "找不到此附件。");
  const [start, end] = range ?? [0, row.bytes - 1];
  headers.set("Content-Length", String(end - start + 1));
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${row.bytes}`);
  try {
    const body = Readable.toWeb(handle.createReadStream({ autoClose: true, start, end })) as ReadableStream<Uint8Array>;
    return new Response(body, { status: range ? 206 : 200, headers });
  } catch (error) { await handle.close().catch(() => undefined); throw error; }
}
