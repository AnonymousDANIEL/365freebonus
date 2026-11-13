import { createHash } from "node:crypto";

export const RELAY_WEBSITE = "https://365freebonus.com/";
export const RELAY_DEFAULT_TARGET = "@join365freebonusgroup";
const OFFICIAL_CHANNEL = "https://t.me/join365freebonus";
const HELP_BOT = "https://t.me/FreeBonus365ChatBot";
const linkTypes = new Set(["url", "text_link", "mention", "text_mention", "email", "phone_number"]);

export type RelayMessage = {
  sourceChatId: number;
  sourceMessageId: number;
  mediaGroupId: string;
  mediaKind: "photo" | "animation" | "video";
  fileId: string;
  fileUniqueId: string;
  caption: string;
  fingerprint: string;
  hasSpoiler: boolean;
};

export function relayKeyboard() {
  return [
    [{ text: "🌐 Visit website", url: RELAY_WEBSITE }],
    [{ text: "🎁 365 Free Bonus Official", url: OFFICIAL_CHANNEL }],
    [{ text: "💬 NEED HELP?", url: HELP_BOT }],
  ];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function negative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value < 0;
}

function opaqueId(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
}

function splitsSurrogate(text: string, index: number): boolean {
  return index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]);
}

function shorten(text: string): string {
  if (text.length <= 1024) return text;
  let end = 1023;
  if (splitsSurrogate(text, end)) end--;
  const linkStart = text.lastIndexOf(RELAY_WEBSITE, end);
  if (linkStart >= 0 && linkStart < end && linkStart + RELAY_WEBSITE.length > end) end = linkStart;
  return `${text.slice(0, end).trimEnd()}…`;
}

function literalUrls(text: string): string {
  return text.replace(/\b(?:https?:\/\/|tg:\/\/|www\.|t\.me\/|telegram\.me\/|wa\.me\/)[^\s<>"'\u0000-\u001f]+/gi, value => {
    const tail = /[.,!?;:)\]}\u3002\uff0c\uff01\uff1f\uff1b\uff1a\uff09\u3001\u300b\u300d]+$/.exec(value)?.[0] || "";
    return RELAY_WEBSITE + tail;
  });
}

function rewriteCaption(caption: string, entities: unknown): string {
  const spans: { start: number; end: number }[] = [];
  if (Array.isArray(entities)) {
    for (const value of entities) {
      const entity = record(value);
      if (!entity || typeof entity.type !== "string" || !linkTypes.has(entity.type)
        || typeof entity.offset !== "number" || !Number.isSafeInteger(entity.offset) || entity.offset < 0
        || !positive(entity.length)) continue;
      const end = entity.offset + entity.length;
      if (end > caption.length || !Number.isSafeInteger(end) || splitsSurrogate(caption, entity.offset) || splitsSurrogate(caption, end)) continue;
      spans.push({ start: entity.offset, end });
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: { start: number; end: number }[] = [];
  for (const span of spans) {
    const prior = merged.at(-1);
    if (prior && span.start < prior.end) prior.end = Math.max(prior.end, span.end);
    else merged.push({ ...span });
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const span of merged) {
    // Keep entity replacements separate from literal text: a hidden link's
    // adjacent words must not be swallowed as if they were part of its new URL.
    const separates = (value: string | undefined) => !value || /[\s\p{P}]/u.test(value);
    parts.push(literalUrls(caption.slice(cursor, span.start)),
      separates(caption[span.start - 1]) ? "" : " ", RELAY_WEBSITE,
      separates(caption[span.end]) ? "" : " ");
    cursor = span.end;
  }
  parts.push(literalUrls(caption.slice(cursor)));
  // Telegram supplies link entities for bare domains and hidden text links.
  // This additional pass also handles literal URLs pasted without entities.
  return shorten(parts.join("").trim());
}

function ownKeyboard(value: unknown): boolean {
  const rows = record(value)?.inline_keyboard;
  if (!Array.isArray(rows)) return false;
  const urls = rows.flatMap(row => Array.isArray(row) ? row.flatMap(button => {
    const url = record(button)?.url;
    return typeof url === "string" ? [url.toLowerCase().replace(/\/$/, "")] : [];
  }) : []);
  return [RELAY_WEBSITE, OFFICIAL_CHANNEL, HELP_BOT].every(url => urls.includes(url.toLowerCase().replace(/\/$/, "")));
}

function ownOrigin(message: Record<string, unknown>, botId: number, targetChatId: number): boolean {
  const origin = record(message.forward_origin);
  return record(message.from)?.id === botId || record(message.via_bot)?.id === botId
    || record(message.sender_chat)?.id === targetChatId
    || record(message.forward_from)?.id === botId || record(message.forward_from_chat)?.id === targetChatId
    || record(origin?.sender_user)?.id === botId || record(origin?.user)?.id === botId
    || record(origin?.chat)?.id === targetChatId || record(origin?.sender_chat)?.id === targetChatId;
}

export function prepareRelayMessage(
  message: Record<string, unknown>,
  context: { botId: number; targetChatId: number; startedAt: number },
): RelayMessage | null {
  if (!positive(context.botId) || !negative(context.targetChatId) || !positive(context.startedAt)) return null;
  const chat = record(message.chat);
  if (!chat || !negative(chat.id) || !["group", "supergroup", "channel"].includes(String(chat.type))
    || chat.id === context.targetChatId || !positive(message.message_id)
    || !positive(message.date) || message.date > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
    || message.date * 1000 < Math.floor(context.startedAt / 1000) * 1000) return null;
  if (message.has_protected_content === true || chat.has_protected_content === true || message.paid_media != null
    || ownOrigin(message, context.botId, context.targetChatId) || ownKeyboard(message.reply_markup)) return null;
  if (typeof message.caption !== "string" || !message.caption.trim() || message.caption.length > 16_384) return null;
  let mediaKind: RelayMessage["mediaKind"];
  let media: Record<string, unknown> | undefined;
  if (Array.isArray(message.photo)) {
    const photos = message.photo.map(record).filter((photo): photo is Record<string, unknown> => Boolean(photo)
      && opaqueId(photo?.file_id, 2048) && opaqueId(photo?.file_unique_id, 256));
    const score = (photo: Record<string, unknown>) => positive(photo.width) && positive(photo.height) ? photo.width * photo.height : 0;
    photos.sort((a, b) => score(b) - score(a) || Number(b.file_size || 0) - Number(a.file_size || 0));
    media = photos[0];
    mediaKind = "photo";
  } else if (record(message.animation)) {
    media = record(message.animation) || undefined;
    mediaKind = "animation";
  } else {
    media = record(message.video) || undefined;
    mediaKind = "video";
  }
  if (!media || !opaqueId(media.file_id, 2048) || !opaqueId(media.file_unique_id, 256)) return null;
  const mediaGroupId = message.media_group_id == null ? "" : message.media_group_id;
  if (mediaGroupId !== "" && !opaqueId(mediaGroupId, 128)) return null;
  const caption = rewriteCaption(message.caption, message.caption_entities);
  if (!caption) return null;
  return {
    sourceChatId: chat.id, sourceMessageId: message.message_id, mediaGroupId,
    mediaKind, fileId: media.file_id, fileUniqueId: media.file_unique_id,
    caption, fingerprint: createHash("sha256").update(JSON.stringify([mediaKind, media.file_unique_id, caption])).digest("hex"),
    hasSpoiler: message.has_media_spoiler === true,
  };
}
