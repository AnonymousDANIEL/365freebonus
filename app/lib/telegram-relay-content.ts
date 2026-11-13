import { createHash } from "node:crypto";

export const RELAY_WEBSITE = "https://365freebonus.com/";
export const RELAY_DEFAULT_TARGET = "@join365freebonusgroup";
const OFFICIAL_CHANNEL = "https://t.me/join365freebonus";
const HELP_BOT = "https://t.me/FreeBonus365ChatBot";
const linkTypes = new Set(["url", "text_link", "mention", "text_mention", "email", "phone_number"]);
const hiddenLinkTypes = new Set(["text_link", "text_mention"]);

export type RelayCaptionEntity = {
  type: string;
  offset: number;
  length: number;
  custom_emoji_id?: string;
  url?: string;
  language?: string;
  unix_time?: number;
  date_time_format?: string;
};

export type RelayMessage = {
  sourceChatId: number;
  sourceMessageId: number;
  mediaGroupId: string;
  mediaKind: "photo" | "animation" | "video";
  fileId: string;
  fileUniqueId: string;
  caption: string;
  captionEntities: RelayCaptionEntity[];
  captionTruncated: boolean;
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

type Span = { start: number; end: number };
type CaptionEdit = Span & { replacement: string; prefix: number; suffix: number };
const styleTypes = new Set(["bold", "italic", "underline", "strikethrough", "spoiler"]);
const quoteTypes = new Set(["blockquote", "expandable_blockquote"]);
const preservedTypes = new Set([...styleTypes, ...quoteTypes, "code", "pre", "custom_emoji", "date_time", "hashtag", "cashtag", "bot_command"]);
const atomicTypes = new Set(["custom_emoji", "date_time", "hashtag", "cashtag", "bot_command"]);
const literalUrlPattern = /\b(?:https?:\/\/|tg:\/\/|www\.|t\.me\/|telegram\.me\/|wa\.me\/)[^\s<>"'\u0000-\u001f\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0F\u200D\u20E3]+/giu;
const punctuationTail = /[.,!?;:)\]}\u3002\uff0c\uff01\uff1f\uff1b\uff1a\uff09\u3001\u300b\u300d]+$/;

function entitySpan(caption: string, value: Record<string, unknown>): Span | null {
  if (typeof value.offset !== "number" || !Number.isSafeInteger(value.offset) || value.offset < 0 || !positive(value.length)) return null;
  const end = value.offset + value.length;
  return Number.isSafeInteger(end) && end <= caption.length && !splitsSurrogate(caption, value.offset) && !splitsSurrogate(caption, end)
    ? { start: value.offset, end } : null;
}

function preservedEntity(caption: string, value: Record<string, unknown>): RelayCaptionEntity | null {
  const span = entitySpan(caption, value);
  if (!span || typeof value.type !== "string" || !preservedTypes.has(value.type)) return null;
  const entity: RelayCaptionEntity = { type: value.type, offset: span.start, length: span.end - span.start };
  if (value.type === "custom_emoji") {
    if (typeof value.custom_emoji_id !== "string" || !/^[1-9]\d{0,19}$/.test(value.custom_emoji_id)) return null;
    entity.custom_emoji_id = value.custom_emoji_id;
  }
  if (value.type === "pre" && value.language !== undefined) {
    if (typeof value.language !== "string" || !/^[A-Za-z0-9_+#. -]{0,64}$/.test(value.language)) return null;
    entity.language = value.language;
  }
  if (value.type === "date_time") {
    if (typeof value.unix_time !== "number" || !Number.isSafeInteger(value.unix_time) || value.unix_time < 0) return null;
    entity.unix_time = value.unix_time;
    if (value.date_time_format !== undefined) {
      if (typeof value.date_time_format !== "string" || !/^(?:r|w?[dD]?[tT]?)$/.test(value.date_time_format)) return null;
      entity.date_time_format = value.date_time_format;
    }
  }
  return entity;
}

function overlaps(a: Span, b: Span) { return a.start < b.end && b.start < a.end; }
function canNest(a: RelayCaptionEntity, b: RelayCaptionEntity): boolean {
  if ([a.type, b.type].some(type => type === "pre" || type === "code")) return false;
  if (quoteTypes.has(a.type) && quoteTypes.has(b.type)) return false;
  return styleTypes.has(a.type) || styleTypes.has(b.type)
    || (quoteTypes.has(a.type) && atomicTypes.has(b.type)) || (quoteTypes.has(b.type) && atomicTypes.has(a.type));
}

/** Return only valid nesting; malformed remote entities must not reject the whole post. */
function safeEntities(caption: string, values: RelayCaptionEntity[]): RelayCaptionEntity[] {
  // Custom artwork takes priority over conflicting source link metadata. The
  // text and fixed destination buttons stay usable even for malformed nesting.
  const sorted = values.sort((a, b) => Number(b.type === "custom_emoji") - Number(a.type === "custom_emoji")
    || a.offset - b.offset || b.length - a.length);
  const result: RelayCaptionEntity[] = [];
  const seen = new Set<string>();
  for (const entity of sorted) {
    const end = entity.offset + entity.length;
    if (!positive(entity.length) || entity.offset < 0 || end > caption.length || splitsSurrogate(caption, entity.offset) || splitsSurrogate(caption, end)) continue;
    const identity = JSON.stringify(entity);
    if (seen.has(identity)) continue;
    const span = { start: entity.offset, end };
    if (result.some(other => {
      const prior = { start: other.offset, end: other.offset + other.length };
      if (!overlaps(span, prior)) return false;
      const nested = span.start >= prior.start && span.end <= prior.end || prior.start >= span.start && prior.end <= span.end;
      return !nested || !canNest(entity, other);
    })) continue;
    result.push(entity); seen.add(identity);
  }
  return result.sort((a, b) => a.offset - b.offset || b.length - a.length);
}

/** Validate saved entity payloads without ever accepting a foreign link target. */
export function normalizeRelayCaptionEntities(caption: string, values: unknown): RelayCaptionEntity[] {
  const normalized: RelayCaptionEntity[] = [];
  for (const value of Array.isArray(values) ? values.slice(0, 1024) : []) {
    const entity = record(value);
    if (!entity) continue;
    const span = entitySpan(caption, entity);
    if (span && entity.type === "url" && caption.slice(span.start, span.end) === RELAY_WEBSITE) {
      normalized.push({ type: "url", offset: span.start, length: span.end - span.start });
      continue;
    }
    if (span && entity.type === "text_link" && entity.url === RELAY_WEBSITE) {
      normalized.push({ type: "text_link", offset: span.start, length: span.end - span.start, url: RELAY_WEBSITE });
      continue;
    }
    const keep = preservedEntity(caption, entity);
    if (keep) normalized.push(keep);
  }
  return safeEntities(caption, normalized);
}

function rewriteCaption(caption: string, rawEntities: unknown): { caption: string; entities: RelayCaptionEntity[]; truncated: boolean } {
  const links: Span[] = [];
  const preserved: RelayCaptionEntity[] = [];
  for (const value of Array.isArray(rawEntities) ? rawEntities.slice(0, 1024) : []) {
    const entity = record(value);
    if (!entity) continue;
    const span = entitySpan(caption, entity);
    if (span && typeof entity.type === "string" && hiddenLinkTypes.has(entity.type)) {
      // Keep linked words/logo emoji exactly; only change the hidden target.
      preserved.push({ type: "text_link", offset: span.start, length: span.end - span.start, url: RELAY_WEBSITE });
    } else if (span && typeof entity.type === "string" && linkTypes.has(entity.type)) links.push(span);
    const keep = preservedEntity(caption, entity);
    if (keep) preserved.push(keep);
  }
  links.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of links) {
    const prior = merged.at(-1);
    if (prior && span.start < prior.end) prior.end = Math.max(prior.end, span.end);
    else merged.push({ ...span });
  }
  // Explicit URL entities define the clickable boundary, so adjacent original
  // text and emoji need no inserted separator spaces.
  const edits: CaptionEdit[] = merged.map(span => ({ ...span, replacement: RELAY_WEBSITE, prefix: 0, suffix: 0 }));
  for (const match of caption.matchAll(literalUrlPattern)) {
    const tail = punctuationTail.exec(match[0])?.[0] || "";
    const span = { start: match.index, end: match.index + match[0].length - tail.length };
    if (span.end > span.start && !merged.some(link => overlaps(link, span))) edits.push({ ...span, replacement: RELAY_WEBSITE, prefix: 0, suffix: 0 });
  }
  edits.sort((a, b) => a.start - b.start);
  let rewritten = "", cursor = 0;
  const generatedLinks: RelayCaptionEntity[] = [];
  for (const edit of edits) {
    rewritten += caption.slice(cursor, edit.start);
    generatedLinks.push({ type: "url", offset: rewritten.length + edit.prefix, length: RELAY_WEBSITE.length });
    rewritten += edit.replacement;
    cursor = edit.end;
  }
  rewritten += caption.slice(cursor);

  const boundary = (position: number, side: "start" | "end") => {
    let delta = 0;
    for (const edit of edits) {
      if (position < edit.start) break;
      const start = edit.start + delta;
      if (position === edit.start) return start + (side === "start" ? edit.prefix : 0);
      if (position < edit.end) return start + (side === "start" ? edit.prefix : edit.replacement.length - edit.suffix);
      if (position === edit.end && side === "end") return start + edit.replacement.length - edit.suffix;
      delta += edit.replacement.length - (edit.end - edit.start);
    }
    return position + delta;
  };
  const remapped: RelayCaptionEntity[] = [];
  for (const entity of preserved) {
    const original = { start: entity.offset, end: entity.offset + entity.length };
    if (atomicTypes.has(entity.type) && edits.some(edit => overlaps(original, edit))) continue;
    const offset = boundary(original.start, "start");
    const end = boundary(original.end, "end");
    if (end > offset) remapped.push({ ...entity, offset, length: end - offset });
  }
  let entities = safeEntities(rewritten, [...remapped, ...generatedLinks]);
  const truncated = rewritten.length > 1024;
  if (truncated) {
    let end = 1023;
    if (splitsSurrogate(rewritten, end)) end--;
    // Atomic custom emoji and generated links must never be cut in half.
    for (;;) {
      const crossing = entities.find(entity => (atomicTypes.has(entity.type) || entity.type === "url")
        && entity.offset < end && entity.offset + entity.length > end);
      if (!crossing) break;
      end = crossing.offset;
    }
    rewritten = rewritten.slice(0, end) + "…";
    entities = safeEntities(rewritten, entities.filter(entity => entity.offset + entity.length <= end));
  }
  return { caption: rewritten, entities, truncated };
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
  const rewritten = rewriteCaption(message.caption, message.caption_entities);
  const caption = rewritten.caption;
  if (!caption.trim()) return null;
  return {
    sourceChatId: chat.id, sourceMessageId: message.message_id, mediaGroupId,
    mediaKind, fileId: media.file_id, fileUniqueId: media.file_unique_id,
    caption, captionEntities: rewritten.entities, captionTruncated: rewritten.truncated, fingerprint: createHash("sha256").update(JSON.stringify([mediaKind, media.file_unique_id, caption])).digest("hex"),
    hasSpoiler: message.has_media_spoiler === true,
  };
}
