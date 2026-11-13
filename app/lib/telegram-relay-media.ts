import { createHash } from "node:crypto";
import { request } from "node:https";
import sharp from "sharp";
import { telegramRequest } from "./telegram-bot";

export type RelayMediaKind = "photo" | "animation";
export const RELAY_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const RELAY_ANIMATION_MAX_BYTES = 20 * 1024 * 1024;

export function relayMediaMaxBytes(kind: RelayMediaKind): number {
  return kind === "photo" ? RELAY_PHOTO_MAX_BYTES : RELAY_ANIMATION_MAX_BYTES;
}

/** Deliberately conservative: similar advertisements must not suppress one another. */
export async function relayMediaIdentity(bytes: Buffer, kind: RelayMediaKind): Promise<{ contentHash: string; visualHash: string }> {
  if (!bytes.length || bytes.length > relayMediaMaxBytes(kind)) throw new RangeError("Relay media size is invalid.");
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  if (kind !== "photo") return { contentHash, visualHash: "" };
  try {
    // Strip metadata, orient EXIF images, and compare the rendered image rather
    // than its container, filename, caption, or Telegram media identifier.
    const { data, info } = await sharp(bytes, { limitInputPixels: 40_000_000, sequentialRead: true, animated: false })
      .timeout({ seconds: 4 }).rotate().toColourspace("srgb").flatten({ background: "#ffffff" }).removeAlpha()
      .resize({ width: 256, height: 256, fit: "inside", kernel: "lanczos3" }).raw().toBuffer({ resolveWithObject: true });
    const visualHash = createHash("sha256").update(`${info.width}:${info.height}:${info.channels}:`).update(data).digest("hex");
    return { contentHash, visualHash };
  } catch {
    // Telegram may provide a supported format the local decoder cannot read.
    // Its exact byte identity is still useful; never expose decoder errors.
    return { contentHash, visualHash: "" };
  }
}

function safeFilePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    && value.split("/").every(part => part.length > 0 && part !== "." && part !== ".." && /^[A-Za-z0-9_.-]+$/.test(part));
}

function downloadFile(token: string, filePath: string, maxBytes: number): Promise<Buffer | null> {
  return new Promise(resolve => {
    let complete = false;
    const finish = (value: Buffer | null) => { if (!complete) { complete = true; resolve(value); } };
    try {
      // Use Node HTTPS directly: URLs containing credentials must not enter
      // Next fetch tracing, redirect handling, application logs, or API replies.
      const outgoing = request({ hostname: "api.telegram.org", method: "GET", path: `/file/bot${token}/${filePath}`,
        signal: AbortSignal.timeout(15_000) }, response => {
        const length = Number(response.headers["content-length"]);
        if (response.statusCode !== 200 || Number.isFinite(length) && length > maxBytes) {
          response.destroy(); finish(null); return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", chunk => {
          if (complete) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > maxBytes) { response.destroy(); finish(null); return; }
          chunks.push(bytes);
        });
        response.on("end", () => finish(size > 0 ? Buffer.concat(chunks, size) : null));
        response.on("error", () => finish(null));
        response.on("aborted", () => finish(null));
        response.on("close", () => finish(null));
      });
      outgoing.on("error", () => finish(null));
      outgoing.end();
    } catch { finish(null); }
  });
}

export async function downloadBotRelayMedia(token: string, fileId: string, kind: RelayMediaKind): Promise<Buffer | null> {
  if (!/^[1-9]\d{0,15}:[A-Za-z0-9_-]{20,128}$/.test(token)
    || !/^[A-Za-z0-9_-]{1,2048}$/.test(fileId)) return null;
  const metadata = await telegramRequest(token, "getFile", { file_id: fileId }).catch(() => null);
  if (!metadata?.ok || !safeFilePath(metadata.result.file_path)) return null;
  const maxBytes = relayMediaMaxBytes(kind);
  const declaredSize = metadata.result.file_size;
  if (declaredSize !== undefined && (typeof declaredSize !== "number" || !Number.isSafeInteger(declaredSize) || declaredSize <= 0 || declaredSize > maxBytes)) return null;
  return downloadFile(token, metadata.result.file_path, maxBytes);
}
