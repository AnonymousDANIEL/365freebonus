import type { DatabaseSync } from "node:sqlite";

/** Private aggregate status: never expose captions, Telegram identities or raw stored errors. */
export function relayCaptionWatchStatus(db: DatabaseSync, now = Date.now()) {
  const preferences = db.prepare(`SELECT relay_enabled,relay_revision,relay_caption_watch_enabled,
    relay_caption_watch_interval_seconds FROM telegram_promotion_settings WHERE id='primary'`).get() as {
      relay_enabled: number; relay_revision: string; relay_caption_watch_enabled: number;
      relay_caption_watch_interval_seconds: number;
    } | undefined;
  const active = preferences?.relay_enabled === 1 && preferences.relay_caption_watch_enabled === 1;
  const hasAccount = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='telegram_personal_account'").get());
  const accountWait = hasAccount ? db.prepare("SELECT next_attempt_at,lease_until FROM telegram_personal_account WHERE id='primary'").get() as {
    next_attempt_at: number; lease_until: number;
  } | undefined : undefined;
  const accountScope = hasAccount ? `EXISTS(SELECT 1 FROM telegram_personal_account a,telegram_personal_sources s
    WHERE a.id='primary' AND a.generation=o.account_generation
    AND s.chat_id=o.source_chat_id AND s.selected=1 AND s.joined=1 AND s.blocked=0 AND s.selected_at<=o.queued_at
    AND EXISTS(SELECT 1 FROM telegram_personal_source_posts w WHERE w.source_chat_id=o.source_chat_id
      AND w.source_message_id=o.source_message_id AND w.account_generation=o.account_generation
      AND w.relay_revision=o.revision AND w.selected_at=s.selected_at))` : "0";
  const accountConnected = hasAccount ? "EXISTS(SELECT 1 FROM telegram_personal_account WHERE id='primary' AND stage='connected')" : "0";
  const aggregate = db.prepare(`WITH watched AS (
    SELECT o.caption_watch_checked_at,o.caption_watch_next_at,e.next_attempt_at,
      (${accountConnected} AND o.source_content_hash NOT LIKE 'invalid:%') AS can_check,
      CASE WHEN o.source_content_hash LIKE 'invalid:%' THEN 'waiting'
        WHEN NOT (${accountConnected}) THEN 'waiting'
        WHEN e.status='attempting' OR o.caption_watch_outcome='checking' THEN 'checking'
        WHEN e.status='pending' THEN 'pending'
        WHEN o.caption_watch_source_version=o.source_version AND o.caption_watch_outcome='consistent' THEN 'consistent'
        WHEN o.caption_watch_source_version=o.source_version AND o.caption_watch_outcome='mismatch' THEN 'mismatch'
        WHEN e.status IN ('failed','uncertain') OR o.caption_watch_source_version=o.source_version AND o.caption_watch_outcome='waiting' THEN 'waiting'
        ELSE 'pending' END AS category
    FROM telegram_relay_outbox o LEFT JOIN telegram_relay_source_edits e
      ON e.outbox_id=o.id AND e.source_version=o.source_version
    WHERE o.revision=? AND o.status='sent' AND o.message_id>0
      AND (o.origin<>'account' OR ${accountScope})
  ) SELECT COUNT(*) AS watched,
    COALESCE(SUM(category='pending'),0) AS pending,COALESCE(SUM(category='checking'),0) AS checking,
    COALESCE(SUM(category='consistent'),0) AS consistent,COALESCE(SUM(category='mismatch'),0) AS mismatch,
    COALESCE(SUM(category='waiting'),0) AS waiting,
    MAX(caption_watch_checked_at) AS last_checked,
    COALESCE(SUM(can_check),0) AS runnable,
    MIN(CASE WHEN can_check THEN CASE WHEN category='pending' AND next_attempt_at IS NOT NULL THEN next_attempt_at ELSE caption_watch_next_at END END) AS next_check
    FROM watched`).get(preferences?.relay_revision || "") as {
      watched: number; pending: number; checking: number; consistent: number; mismatch: number; waiting: number;
      last_checked: number | null; next_check: number | null; runnable: number;
    };
  return {
    watched: aggregate.watched, pending: aggregate.pending, checking: aggregate.checking,
    consistent: aggregate.consistent, mismatch: aggregate.mismatch, waiting: aggregate.waiting,
    lastCheckedAt: aggregate.last_checked && aggregate.last_checked <= now ? aggregate.last_checked : null,
    nextCheckAt: active && aggregate.runnable > 0
      ? Math.max(now, aggregate.next_check || now, accountWait?.next_attempt_at || 0, accountWait?.lease_until || 0) : null,
    lastError: aggregate.mismatch > 0 ? "发现文案、格式、Emoji 或按钮不一致，正在核对原消息。"
      : aggregate.waiting > 0 ? "部分消息等待连接、权限或文案资料核实；发送结果未确认的媒体不会重发。" : "",
  };
}
