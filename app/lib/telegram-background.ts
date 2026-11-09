import { MAX_IMAGE_BYTES } from "./image-media";

type Colour = readonly [number, number, number];
type CleanedImage = { bytes: Buffer; mime: "image/png"; extension: "png" }
  | { bytes: Buffer; mime: "image/gif"; extension: "gif" };

const MAX_FRAME_PIXELS = 2_500_000;
const MAX_TOTAL_PIXELS = 8_000_000;
const MAX_GIF_FRAMES = 60;
const CHANNELS = 4;
const formats = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" } as const;

function colourMatches(data: Buffer, offset: number, colour: Colour, tolerance: number): boolean {
  return Math.abs(data[offset] - colour[0]) <= tolerance
    && Math.abs(data[offset + 1] - colour[1]) <= tolerance
    && Math.abs(data[offset + 2] - colour[2]) <= tolerance;
}

function findBackdrop(data: Buffer, width: number, height: number, tolerance: number): Colour | null {
  const patchSize = Math.min(8, Math.max(2, Math.floor(Math.min(width, height) / 16)));
  const corners = [0, width - patchSize, (height - patchSize) * width, (height - patchSize) * width + width - patchSize];
  const samples = corners.map(corner => {
    const patch: number[] = [];
    for (let y = 0; y < patchSize; y++) {
      for (let x = 0; x < patchSize; x++) patch.push((corner + y * width + x) * CHANNELS);
    }
    return patch;
  });
  const offsets = samples.flat();
  const median = (channel: number) => offsets.map(offset => data[offset + channel]).sort((a, b) => a - b)[Math.floor(offsets.length / 2)];
  const colour: Colour = [median(0), median(1), median(2)];
  if (samples.some(patch => patch.filter(offset => colourMatches(data, offset, colour, tolerance)).length < patch.length * 0.9)) return null;

  // Each edge must agree with the same colour. A single uniform corner alone
  // is not enough to distinguish a logo background from an illustration.
  const edgeAgrees = (start: number, length: number, stride: number) => {
    let matches = 0;
    for (let index = 0; index < length; index++) {
      if (colourMatches(data, (start + index * stride) * CHANNELS, colour, tolerance)) matches++;
    }
    return matches >= length * 0.94;
  };
  return edgeAgrees(0, width, 1) && edgeAgrees((height - 1) * width, width, 1)
    && edgeAgrees(0, height, width) && edgeAgrees(width - 1, height, width) ? colour : null;
}

function clearBackdrop(data: Buffer, width: number, height: number, colour: Colour, tolerance: number, queue: Uint32Array): boolean {
  const pixels = width * height;
  let tail = 0;
  const enqueue = (index: number) => {
    const offset = index * CHANNELS;
    if (data[offset + 3] !== 255 || !colourMatches(data, offset, colour, tolerance)) return;
    data[offset + 3] = 0;
    queue[tail++] = index;
  };

  for (let x = 0; x < width; x++) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  for (let head = 0; head < tail; head++) {
    const index = queue[head];
    const x = index % width;
    if (x > 0) enqueue(index - 1);
    if (x < width - 1) enqueue(index + 1);
    if (index >= width) enqueue(index - width);
    if (index < pixels - width) enqueue(index + width);
  }

  // Retain some foreground and require a substantial background before replacing
  // the original. Enclosed details stay intact, even when they match the backdrop.
  return tail >= pixels * 0.12 && pixels - tail >= Math.max(12, pixels * 0.002);
}

/** Clean an uploaded logo for Telegram when its border identifies a clear backdrop. */
export async function cleanTelegramBackground(bytes: Buffer, mime: string): Promise<CleanedImage | null> {
  const format = formats[mime as keyof typeof formats];
  if (!format || !bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;

  try {
    const { default: sharp } = await import("sharp");
    const input = sharp(bytes, { limitInputPixels: MAX_FRAME_PIXELS, failOn: "warning" });
    const meta = await input.metadata();
    const frames = meta.pages ?? 1;
    const animated = format === "gif" && frames > 1;
    if (meta.format !== format || meta.width < 1 || meta.height < 1 || frames < 1 || frames > MAX_GIF_FRAMES) return null;
    if (frames > 1 && !animated) return null;
    // APNG can be reported as a still PNG by the decoder.
    if (format === "png" && bytes.includes("acTL", 8, "ascii")) return null;
    if (meta.width * meta.height > MAX_FRAME_PIXELS || meta.width * meta.height * frames > MAX_TOTAL_PIXELS) return null;

    const decoder = animated ? sharp(bytes, { animated: true, limitInputPixels: MAX_TOTAL_PIXELS, failOn: "warning" }) : input.autoOrient();
    const { data, info } = await decoder.toColourspace("srgb").ensureAlpha().raw({ depth: "uchar" }).timeout({ seconds: 4 }).toBuffer({ resolveWithObject: true });
    const width = info.width;
    const height = animated ? info.pageHeight : info.height;
    if (!height || info.channels !== CHANNELS || info.height !== height * frames || data.length !== width * info.height * CHANNELS) return null;

    let hasTransparency = false;
    let hasVisiblePixels = false;
    for (let offset = 3; offset < data.length; offset += CHANNELS) {
      hasTransparency ||= data[offset] < 255;
      hasVisiblePixels ||= data[offset] > 0;
      if (hasTransparency && hasVisiblePixels) break;
    }
    if (!hasVisiblePixels) return null;
    if (hasTransparency && format === "png") return { bytes, mime: "image/png", extension: "png" };
    if (hasTransparency && format === "gif") return { bytes, mime: "image/gif", extension: "gif" };

    if (!hasTransparency) {
      if (width < 8 || height < 8) return null;
      const tolerance = format === "jpeg" || format === "webp" ? 9 : 4;
      const frameSize = width * height * CHANNELS;
      const queue = new Uint32Array(width * height);
      let firstColour: Colour | null = null;
      for (let frame = 0; frame < frames; frame++) {
        const pixels = data.subarray(frame * frameSize, (frame + 1) * frameSize);
        const colour = findBackdrop(pixels, width, height, tolerance);
        if (!colour || firstColour?.some((value, index) => Math.abs(value - colour[index]) > tolerance)) return null;
        firstColour ??= colour;
        if (!clearBackdrop(pixels, width, height, colour, tolerance, queue)) return null;
      }
    }

    const encoder = sharp(data, { raw: { width, height: info.height, channels: CHANNELS, ...(animated ? { pageHeight: height } : {}) } }).timeout({ seconds: 4 });
    if (format === "gif") {
      if (animated && (meta.loop === undefined || meta.delay?.length !== frames || meta.delay.some(delay => delay > 65_535))) return null;
      const cleaned = await encoder.gif({ loop: meta.loop, delay: meta.delay, keepDuplicateFrames: true, interPaletteMaxError: 0, dither: 0, effort: 3 }).toBuffer();
      if (!cleaned.length || cleaned.length > MAX_IMAGE_BYTES) return null;
      const saved = await sharp(cleaned, { limitInputPixels: MAX_FRAME_PIXELS }).metadata();
      if ((saved.pages ?? 1) !== frames || (animated && (saved.loop !== meta.loop || meta.delay?.some((delay, index) => saved.delay?.[index] !== delay)))) return null;
      return { bytes: cleaned, mime: "image/gif", extension: "gif" };
    }

    const cleaned = await encoder.png({ compressionLevel: 6 }).toBuffer();
    return cleaned.length > 0 && cleaned.length <= MAX_IMAGE_BYTES ? { bytes: cleaned, mime: "image/png", extension: "png" } : null;
  } catch {
    return null;
  }
}
