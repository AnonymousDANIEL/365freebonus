import type { DatabaseSync } from "node:sqlite";

const MAX_JOBS = 200;
const MAX_METADATA_CHARS = 131_072;
const DAY_MS = 86_400_000;
const MIN_INT64 = BigInt("-9223372036854775808");
const MAX_INT64 = BigInt("9223372036854775807");
const statuses = ["pending", "sending", "sent", "failed", "unknown", "cancelled"] as const;
type Status = typeof statuses[number];
type DiagnosticRow = {
  origin: unknown; status: unknown; caption_entities: unknown; last_error: unknown;
  queued_at: unknown; sent_at: unknown;
};
type Outcome = "none" | "pending" | "sending" | "sent_preserved" | "sent_plain"
  | "sent_without_custom_emoji" | "sent_caption_changed" | "rejected_custom_emoji"
  | "source_custom_emoji_dropped"
  | "caption_overlength" | "legacy_metadata_unknown" | "invalid_metadata"
  | "delivery_unconfirmed" | "failed" | "cancelled" | "unclassified";

function timestamp(value: unknown, now: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= now ? value : null;
}

/** Private operational counters only. Never return source content or identifiers. */
export function relayFormattingDiagnostics(db: DatabaseSync, now = Date.now(), since = now - DAY_MS) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(since)) throw new RangeError("Invalid diagnostic interval.");
  const windowStart = Math.max(0, Math.min(since, now));
  const schema = db.prepare("PRAGMA user_version").get() as { user_version: number };
  // Bound both rows and text before it leaves SQLite, even if stored metadata
  // was corrupted. Only fixed categories and counts leave this function.
  const rows = db.prepare(`SELECT origin,status,
    substr(caption_entities,1,${MAX_METADATA_CHARS + 1}) AS caption_entities,
    substr(last_error,1,512) AS last_error,queued_at,sent_at
    FROM telegram_relay_outbox WHERE queued_at>=? AND queued_at<=?
    ORDER BY queued_at DESC,id DESC LIMIT ${MAX_JOBS}`).all(windowStart, now) as DiagnosticRow[];
  const origins = { bot: 0, account: 0, other: 0 };
  const customEmojiJobs: Record<Status, number> = { pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0, cancelled: 0 };
  let metadataRecorded = 0, legacyUnknown = 0, invalidMetadata = 0, expectedCustomEmojiEntities = 0;
  let positiveCustomEmojiEntities = 0, negativeCustomEmojiEntities = 0, invalidCustomEmojiEntities = 0;
  let missingCustomEmojiWarnings = 0, captionChangedWarnings = 0, customRejectedFailures = 0, overlengthFailures = 0, droppedCustomEmojiFailures = 0;
  let latestCustomQueuedAt: number | null = null, latestCustomSentAt: number | null = null;
  let latestOutcome: Outcome = "none", latestCustomOutcome: Outcome | null = null;
  for (const row of rows) {
    if (row.origin === "bot") origins.bot++; else if (row.origin === "account") origins.account++; else origins.other++;
    let customCount = 0, metadata: "recorded" | "legacy" | "invalid" = "invalid";
    if (row.caption_entities === "") { legacyUnknown++; metadata = "legacy"; }
    else if (typeof row.caption_entities === "string" && row.caption_entities.length <= MAX_METADATA_CHARS) {
      try {
        const parsed: unknown = JSON.parse(row.caption_entities);
        if (Array.isArray(parsed)) {
          metadataRecorded++; metadata = "recorded";
          for (const entity of parsed) {
            if (entity === null || typeof entity !== "object" || Array.isArray(entity) || entity.type !== "custom_emoji") continue;
            customCount++;
            const id = entity.custom_emoji_id;
            if (typeof id === "string" && /^-?[1-9]\d{0,18}$/.test(id)) {
              const value = BigInt(id);
              if (value >= MIN_INT64 && value <= MAX_INT64) {
                if (value < 0) negativeCustomEmojiEntities++; else positiveCustomEmojiEntities++;
                continue;
              }
            }
            invalidCustomEmojiEntities++;
          }
        } else invalidMetadata++;
      } catch { invalidMetadata++; }
    } else invalidMetadata++;
    const error = typeof row.last_error === "string" ? row.last_error : "";
    const missing = error.startsWith("Telegram 未保留部分原始自定义 Emoji");
    const changed = error.startsWith("Telegram 返回的文案与提交原文不一致");
    const rejected = row.status === "failed" && error.startsWith("Telegram 拒绝发送含自定义 Emoji");
    const overlength = row.status === "failed" && error.startsWith("原文超过当前媒体文案长度限制");
    const dropped = row.status === "failed" && error.startsWith("原始自定义 Emoji 资料未能完整保留");
    missingCustomEmojiWarnings += Number(missing);
    captionChangedWarnings += Number(changed);
    customRejectedFailures += Number(rejected);
    overlengthFailures += Number(overlength);
    droppedCustomEmojiFailures += Number(dropped);
    let outcome: Outcome = "unclassified";
    if (missing) outcome = "sent_without_custom_emoji";
    else if (changed) outcome = "sent_caption_changed";
    else if (rejected) outcome = "rejected_custom_emoji";
    else if (overlength) outcome = "caption_overlength";
    else if (dropped) outcome = "source_custom_emoji_dropped";
    else if (metadata === "legacy") outcome = "legacy_metadata_unknown";
    else if (metadata === "invalid") outcome = "invalid_metadata";
    else if (row.status === "sent" && error) outcome = "unclassified";
    else if (row.status === "sent") outcome = customCount ? "sent_preserved" : "sent_plain";
    else if (row.status === "unknown") outcome = "delivery_unconfirmed";
    else if (row.status === "pending" || row.status === "sending" || row.status === "failed" || row.status === "cancelled") outcome = row.status;
    if (latestOutcome === "none") latestOutcome = outcome;
    if (customCount > 0) {
      expectedCustomEmojiEntities += customCount;
      if (statuses.includes(row.status as Status)) customEmojiJobs[row.status as Status]++;
      const queued = timestamp(row.queued_at, now), sent = row.status === "sent" ? timestamp(row.sent_at, now) : null;
      if (queued !== null) latestCustomQueuedAt = Math.max(latestCustomQueuedAt ?? queued, queued);
      if (sent !== null) latestCustomSentAt = Math.max(latestCustomSentAt ?? sent, sent);
    }
    if (latestCustomOutcome === null && (customCount > 0 || missing || changed || rejected || overlength || dropped)) latestCustomOutcome = outcome;
  }
  return { schemaVersion: Number(schema.user_version), windowStart, windowEnd: now, sampledJobs: rows.length, sampleLimit: MAX_JOBS,
    metadataRecorded, legacyUnknown, invalidMetadata, origins, customEmojiJobs, expectedCustomEmojiEntities,
    positiveCustomEmojiEntities, negativeCustomEmojiEntities, invalidCustomEmojiEntities,
    missingCustomEmojiWarnings, captionChangedWarnings, customRejectedFailures, overlengthFailures, droppedCustomEmojiFailures,
    latestCustomQueuedAt, latestCustomSentAt, latestOutcome: latestCustomOutcome ?? latestOutcome };
}
