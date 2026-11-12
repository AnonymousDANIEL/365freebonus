import { getAdminPath } from "./auth-core";
import { brandAnnouncementPath } from "./brand-links";
import { isSafeSocialUrl, type BrandCategory } from "./directory";
import { MAX_IMAGE_BYTES, openImage } from "./image-media";
import { isSafeImageUrl, isUploadedImageUrl } from "./image-url";
import { cleanTelegramBackground } from "./telegram-background";
import { telegramRequest, type TelegramUpload } from "./telegram-bot";

export type TelegramBrandCard = {
  id: string;
  name: string;
  slug: string;
  category: BrandCategory;
  tagline: string;
  description: string;
  link: string;
  imageUrl: string;
};
type PromotionMedia = TelegramUpload | { field: "photo" | "animation"; url: string };
const mediaMethods = { photo: "sendPhoto", animation: "sendAnimation", document: "sendDocument" } as const;
type BrandCardOptions = {
  template?: string;
  parameters?: Record<string, unknown>;
  beforeSend?: () => boolean;
};

export function telegramPublicOrigin() {
  const url = process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
  try {
    const origin = new URL(url);
    return ["https:", "http:"].includes(origin.protocol) && !origin.username && !origin.password ? origin.origin : "";
  } catch { return ""; }
}

async function promotionMedia(imageUrl: string, origin: string, slug: string): Promise<PromotionMedia | null> {
  const value = imageUrl.trim();
  if (!value) return null;
  const relative = value.startsWith("/");
  if (!(relative ? isSafeImageUrl(value) : isSafeSocialUrl(value))) return null;
  const url = relative ? new URL(value, origin) : new URL(value);
  if (url.origin !== origin || !isUploadedImageUrl(url.pathname)) {
    const field = url.pathname.toLowerCase().endsWith(".gif") ? "animation" : "photo";
    return { field, url: url.href };
  }

  const fileName = url.pathname.slice("/api/images/".length);
  try {
    const image = await openImage(fileName);
    if (!image) return null;
    // openImage bounds the stream to the size of the validated upload.
    const bytes = Buffer.from(await new Response(image.stream).arrayBuffer());
    if (bytes.length !== image.size) return null;
    const clean = await cleanTelegramBackground(bytes, image.mime).catch(() => null);
    if (clean) return { field: "document", fileName: `${slug}.${clean.extension}`, mime: clean.mime, bytes: clean.bytes };
    if (image.mime === "image/webp") {
      const { default: sharp } = await import("sharp");
      const converted = await sharp(bytes, { limitInputPixels: 24_000_000 })
        .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 88 })
        .toBuffer();
      if (!converted.length || converted.length > MAX_IMAGE_BYTES) return null;
      return { field: "photo", fileName: fileName.replace(/\.webp$/, ".jpg"), mime: "image/jpeg", bytes: converted };
    }
    return { field: image.mime === "image/gif" ? "animation" : "photo", fileName, mime: image.mime, bytes };
  } catch { return null; }
}

function truncateBrandText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "").trimEnd()}…`;
}

/** Send one public brand card without owning any worker, queue or database state. */
export async function sendTelegramBrandCard(token: string, chatId: number, brand: TelegramBrandCard, origin: string, options: BrandCardOptions = {}) {
  const url = new URL(brandAnnouncementPath(brand.slug, brand.id, getAdminPath()), origin);
  const title = brand.category === "All" ? brand.name : `${brand.category} · ${brand.name}`;
  const tagline = brand.tagline.trim();
  const description = brand.description.trim();
  // Brand-page links now live in the inline keyboard, including old {link} templates.
  const fields = { category: brand.category, name: brand.name, tagline, description, link: "" };
  const customText = (options.template ?? "").replace(/\{(category|name|tagline|description|link)\}/g, (_, field: keyof typeof fields) => fields[field]).trim();
  const content = (customText
    ? [customText, description && !customText.includes(description) ? description : ""]
    : [title, tagline, description !== tagline ? description : ""])
    .filter(Boolean).join("\n\n").split(url.href).join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const text = truncateBrandText(content || title, 4_096);
  const brandLink = brand.link.trim();
  const replyMarkup = { inline_keyboard: [
    [{ text: brand.name, url: url.href }],
    [{ text: "🌐 Visit website", url: new URL("/", origin).href },
      ...(isSafeSocialUrl(brandLink) ? [{ text: "🚀 Join Now", url: brandLink }] : [])],
  ] };
  const canSend = () => options.beforeSend?.() ?? true;
  const sendText = () => {
    if (!canSend()) return undefined;
    return telegramRequest(token, "sendMessage", {
      ...options.parameters, chat_id: chatId, text, reply_markup: replyMarkup, link_preview_options: { is_disabled: true },
    });
  };
  const caption = truncateBrandText(content || title, 1_024);
  // Media preparation can await disk/image work. Recheck authorization afterwards
  // and again before a rejected-media fallback reaches the network.
  if (!canSend()) return undefined;
  const media = await promotionMedia(brand.imageUrl, origin, brand.slug);
  if (!media) return sendText();
  if (!canSend()) return undefined;
  const method = mediaMethods[media.field];
  const parameters = { ...options.parameters, chat_id: chatId, caption, reply_markup: replyMarkup };
  const response = "url" in media
    ? await telegramRequest(token, method, { ...parameters, [media.field]: media.url })
    : await telegramRequest(token, method, media.field === "document"
      ? { ...parameters, disable_content_type_detection: true }
      : parameters, media);
  return response && !response.ok && [400, 403].includes(response.code) ? sendText() : response;
}
