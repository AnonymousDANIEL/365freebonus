import { constants } from "node:fs";
import { open } from "node:fs/promises";

export type HotVideoMetadata = { width: number; height: number; duration: number; supportsStreaming: boolean };
type Box = { type: string; start: number; body: number; end: number };
const MAX_METADATA = 16 * 1024 * 1024;
const INVALID = "视频没有可播放的 MP4 视频轨道，请选择完整的 MP4 视频。";
function boxes(bytes: Buffer, start = 0, end = bytes.length): Box[] {
  const result: Box[] = [];
  for (let at = start; at < end;) {
    if (result.length >= 10000 || end - at < 8) throw new Error(INVALID);
    let length = bytes.readUInt32BE(at), header = 8;
    if (length === 1) {
      if (end - at < 16) throw new Error(INVALID);
      const large = bytes.readBigUInt64BE(at + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(INVALID);
      length = Number(large); header = 16;
    }
    if (length === 0) length = end - at;
    if (length < header || length > end - at) throw new Error(INVALID);
    result.push({ type: bytes.toString("ascii", at + 4, at + 8), start: at, body: at + header, end: at + length });
    at += length;
  }
  return result;
}
function duration(bytes: Buffer, box: Box | undefined): number | null {
  if (!box) return null;
  const version = bytes[box.body], base = box.body + (version === 1 ? 20 : 12);
  if (![0, 1].includes(version) || base + (version === 1 ? 12 : 8) > box.end) return null;
  const scale = bytes.readUInt32BE(base), ticks = version === 1 ? Number(bytes.readBigUInt64BE(base + 4)) : bytes.readUInt32BE(base + 4);
  const value = ticks / scale;
  return scale > 0 && Number.isSafeInteger(ticks) && Number.isFinite(value) && value >= 0 && value < 366 * 86400 ? value : null;
}
/** Reads only bounded metadata. The original media bytes are never changed. */
export async function readHotVideoMetadata(filename: string, expectedBytes: number): Promise<HotVideoMetadata> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const read = async (buffer: Buffer, position: number) => {
      for (let received = 0; received < buffer.length;) {
        const result = await file.read(buffer, received, buffer.length - received, position + received);
        if (!result.bytesRead) throw new Error(INVALID);
        received += result.bytesRead;
      }
    };
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== expectedBytes) throw new Error(INVALID);
    let at = 0, moov: Buffer | undefined, moovAt = Infinity, mdatAt = Infinity, count = 0;
    while (at < expectedBytes) {
      if (++count > 10000 || expectedBytes - at < 8) throw new Error(INVALID);
      const head = Buffer.alloc(Math.min(16, expectedBytes - at));
      await read(head, at);
      let length = head.readUInt32BE(0), header = 8;
      if (length === 1) { if (head.length < 16) throw new Error(INVALID); const n = head.readBigUInt64BE(8); if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(INVALID); length = Number(n); header = 16; }
      if (length === 0) length = expectedBytes - at;
      if (length < header || length > expectedBytes - at) throw new Error(INVALID);
      const type = head.toString("ascii", 4, 8);
      if (at === 0 && type !== "ftyp") throw new Error(INVALID);
      if (type === "mdat") mdatAt = Math.min(mdatAt, at);
      if (type === "moov") {
        if (moov || length - header > MAX_METADATA) throw new Error(INVALID);
        moov = Buffer.alloc(length - header); moovAt = at;
        await read(moov, at + header);
      }
      at += length;
    }
    if (!moov || !Number.isFinite(mdatAt)) throw new Error(INVALID);
    const children = boxes(moov), fallbackDuration = duration(moov, children.find(b => b.type === "mvhd"));
    for (const track of children.filter(b => b.type === "trak")) {
      const trackChildren = boxes(moov, track.body, track.end), media = trackChildren.find(b => b.type === "mdia");
      if (!media) continue;
      const mediaChildren = boxes(moov, media.body, media.end), handler = mediaChildren.find(b => b.type === "hdlr");
      if (!handler || handler.body + 12 > handler.end || moov.toString("ascii", handler.body + 8, handler.body + 12) !== "vide") continue;
      const tkhd = trackChildren.find(b => b.type === "tkhd");
      if (!tkhd || ![0, 1].includes(moov[tkhd.body]) || tkhd.end - tkhd.body < (moov[tkhd.body] === 1 ? 96 : 84)) throw new Error(INVALID);
      const width = Math.round(moov.readUInt32BE(tkhd.end - 8) / 65536), height = Math.round(moov.readUInt32BE(tkhd.end - 4) / 65536);
      const seconds = duration(moov, mediaChildren.find(b => b.type === "mdhd")) ?? fallbackDuration;
      if (width < 1 || width > 32768 || height < 1 || height > 32768 || seconds === null) throw new Error(INVALID);
      return { width, height, duration: seconds, supportsStreaming: moovAt < mdatAt };
    }
    throw new Error(INVALID);
  } finally { await file.close(); }
}
