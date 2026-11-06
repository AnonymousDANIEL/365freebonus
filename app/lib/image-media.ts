import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { getDataDirectory } from "./sqlite";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MIME = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as const;
type Extension = keyof typeof MIME;

export class ImageMediaError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const tooLarge = () => new ImageMediaError(413, "图片大小不能超过 5 MB。");
const invalidImage = () => new ImageMediaError(415, "请选择有效的 JPEG、PNG、GIF 或 WebP 图片。");
const validDimensions = (width: number, height: number) => width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 24_000_000;
const ascii = (data: Buffer, start: number, end: number) => data.toString("ascii", start, end);

function jpegDimensions(data: Buffer): [number, number] | null {
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset < data.length - 2) {
    if (data[offset] !== 0xff) return null;
    while (offset < data.length && data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xda || marker === 0xd9 || offset + 2 > data.length) return null;
    const size = data.readUInt16BE(offset);
    if (size < 2 || offset + size > data.length) return null;
    if (frameMarkers.has(marker)) return size >= 8 ? [data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3)] : null;
    offset += size;
  }
  return null;
}

function webpDimensions(data: Buffer): [number, number] | null {
  if (data.length < 25 || data.readUInt32LE(4) + 8 !== data.length) return null;
  const size = data.readUInt32LE(16);
  if (20 + size + (size & 1) > data.length) return null;
  const chunk = ascii(data, 12, 16);
  if (chunk === "VP8X" && size >= 10) return [1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3)];
  if (chunk === "VP8L" && size >= 5 && data[20] === 0x2f) {
    const dims = data.readUInt32LE(21);
    if (dims >>> 29 !== 0) return null;
    return [1 + (dims & 0x3fff), 1 + ((dims >>> 14) & 0x3fff)];
  }
  if (chunk === "VP8 " && size >= 10 && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) return [data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff];
  return null;
}

function rasterExtension(data: Buffer): Extension | null {
  if (data.length >= 45 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.readUInt32BE(8) === 13 && ascii(data, 12, 16) === "IHDR" && data.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) {
    return validDimensions(data.readUInt32BE(16), data.readUInt32BE(20)) ? "png" : null;
  }
  if (data.length >= 14 && ["GIF87a", "GIF89a"].includes(ascii(data, 0, 6)) && data.at(-1) === 0x3b) return validDimensions(data.readUInt16LE(6), data.readUInt16LE(8)) ? "gif" : null;
  if (data.length >= 16 && data[0] === 0xff && data[1] === 0xd8 && data.at(-2) === 0xff && data.at(-1) === 0xd9) {
    const dims = jpegDimensions(data);
    return dims && validDimensions(...dims) ? "jpg" : null;
  }
  if (data.length >= 25 && ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 12) === "WEBP") {
    const dims = webpDimensions(data);
    return dims && validDimensions(...dims) ? "webp" : null;
  }
  return null;
}

export async function readImageUpload(request: Request): Promise<Buffer> {
  const declaredSize = Number(request.headers.get("content-length") || "0");
  if (declaredSize > MAX_IMAGE_BYTES) throw tooLarge();
  const declaredType = (request.headers.get("content-type") || "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
  if (![...Object.values(MIME), "application/octet-stream"].includes(declaredType)) throw invalidImage();
  if (!request.body) throw new ImageMediaError(400, "请选择要上传的图片。");
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  if (!bytes) throw new ImageMediaError(400, "请选择要上传的图片。");
  return Buffer.concat(chunks, bytes);
}

function mediaDirectory() { return path.join(getDataDirectory(), "media"); }

export async function saveImage(data: Buffer): Promise<string> {
  if (data.length > MAX_IMAGE_BYTES) throw tooLarge();
  const extension = rasterExtension(data);
  if (!extension) throw invalidImage();
  const directory = mediaDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = `${randomBytes(16).toString("hex")}.${extension}`;
  await writeFile(path.join(directory, file), data, { flag: "wx", mode: 0o600, flush: true });
  return `/api/images/${file}`;
}

export async function openImage(file: string) {
  const matched = /^([0-9a-f]{32})\.(png|jpg|gif|webp)$/.exec(file);
  if (!matched) return null;
  let handle;
  try { handle = await open(path.join(mediaDirectory(), file), constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
  catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code || "")) return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_IMAGE_BYTES) { await handle.close(); return null; }
    const stream = Readable.toWeb(handle.createReadStream({ autoClose: true, end: stat.size - 1 })) as ReadableStream<Uint8Array>;
    return { stream, mime: MIME[matched[2] as Extension], size: stat.size };
  } catch (error) { await handle.close().catch(() => undefined); throw error; }
}
