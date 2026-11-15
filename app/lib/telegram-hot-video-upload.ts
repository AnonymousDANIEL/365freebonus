import { createHash, randomUUID } from "node:crypto";
import { open, rename, statfs, unlink } from "node:fs/promises";
import path from "node:path";
import { getSqlite } from "./sqlite";
import { HotVideoError, hotVideoStorageDirectory, reserveHotVideoUpload, releaseHotVideoUpload, registerHotVideo } from "./telegram-hot-videos";

import { HOT_VIDEO_MAX_BYTES as MAX_BYTES } from "./telegram-hot-video-limits";
const FREE_BYTES = 64 * 1024 * 1024;
function header(request: Request, name: string, max: number) {
  const value = request.headers.get(name) || "";
  if (value.length > max * 12) throw new HotVideoError("视频名称过长。", 400);
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { throw new HotVideoError("视频名称格式不正确。", 400); }
  if (decoded.length > max || /[\u0000-\u001f\u007f]/u.test(decoded)) throw new HotVideoError("视频名称格式不正确。", 400);
  return decoded.trim();
}
async function enoughSpace(directory: string, bytes: number) {
  const disk = await statfs(directory, { bigint: true });
  if (disk.bavail * disk.bsize < BigInt(bytes + FREE_BYTES)) throw new HotVideoError("视频储存空间不足，请先删除不需要的视频。", 507);
}

/** Authenticate in the route before touching the incoming stream or private disk. */
export async function storeHotVideoUpload(request: Request) {
  if ((request.headers.get("content-type") || "").toLowerCase().split(";", 1)[0].trim() !== "video/mp4")
    throw new HotVideoError("请上传 MP4 视频。", 415);
  const rawSize = request.headers.get("x-video-size") || "";
  if (!/^[1-9]\d{0,9}$/.test(rawSize)) throw new HotVideoError("无法确认视频大小，请重新选择视频。", 400);
  const expected = Number(rawSize);
  if (expected > MAX_BYTES) { await request.body?.cancel().catch(() => undefined); throw new HotVideoError("视频超过 Telegram 原画上传上限（2000 MB）。", 413); }
  if (expected < 24 || !request.body) throw new HotVideoError("视频文件为空或不完整。", 400);
  const length = request.headers.get("content-length");
  if (length !== null && (!/^[1-9]\d*$/.test(length) || Number(length) !== expected)) {
    await request.body.cancel().catch(() => undefined); throw new HotVideoError("视频大小不一致，请重新上传。", 400);
  }
  const originalName = header(request, "x-video-filename", 255).replace(/\\/g, "/").split("/").at(-1) || "video.mp4";
  if (!/\.mp4$/i.test(originalName)) throw new HotVideoError("请上传 MP4 视频。", 415);
  const title = header(request, "x-video-title", 160) || originalName.replace(/\.mp4$/i, "").slice(0, 160) || "Video";
  const db = getSqlite(), id = randomUUID(), directory = hotVideoStorageDirectory();
  await enoughSpace(directory, expected);
  reserveHotVideoUpload(db, { id, bytes: expected });
  const temporary = path.join(directory, `${id}.part`), destination = path.join(directory, `${id}.mp4`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const reader = request.body.getReader(), hash = createHash("sha256"), deadline = Date.now() + 5 * 60_000;
  let bytes = 0, headerBytes = Buffer.alloc(0), renamed = false, committed = false, lastSpaceCheck = 0;
  try {
    handle = await open(temporary, "wx", 0o600);
    for (;;) {
      if (Date.now() >= deadline || request.signal.aborted) throw new HotVideoError("上传已中断或超时，请重新上传。", 408);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HotVideoError("上传超时，请重新上传。", 408)), Math.max(1, deadline - Date.now()));
      })]).finally(() => { if (timer) clearTimeout(timer); });
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > expected || bytes > MAX_BYTES) throw new HotVideoError("视频超出声明大小或 Telegram 上传上限。", 413);
      if (headerBytes.length < 64) headerBytes = Buffer.concat([headerBytes, Buffer.from(next.value.subarray(0, 64 - headerBytes.length))]);
      hash.update(next.value);
      let written = 0;
      while (written < next.value.byteLength) {
        const result = await handle.write(next.value.subarray(written));
        if (result.bytesWritten === 0) throw new HotVideoError("视频未能完整保存，请重试。", 503);
        written += result.bytesWritten;
      }
      if (bytes - lastSpaceCheck >= 4 * 1024 * 1024) { await enoughSpace(directory, expected - bytes); lastSpaceCheck = bytes; }
    }
    if (bytes !== expected || headerBytes.length < 24 || headerBytes.toString("ascii", 4, 8) !== "ftyp"
      || headerBytes.readUInt32BE(0) < 16 || headerBytes.readUInt32BE(0) > bytes)
      throw new HotVideoError("视频不是完整的 MP4 文件，请重新选择。", 400);
    await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, destination); renamed = true;
    await registerHotVideo(db, { id, title, originalName, fileName: `${id}.mp4`, bytes, sha256: hash.digest("hex") });
    committed = true;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error instanceof HotVideoError ? error : new HotVideoError("视频未能保存，请检查储存空间后重试。", 503);
  } finally {
    reader.releaseLock(); await handle?.close().catch(() => undefined);
    if (!committed) { await unlink(renamed ? destination : temporary).catch(() => undefined); releaseHotVideoUpload(db, id); }
  }
}
