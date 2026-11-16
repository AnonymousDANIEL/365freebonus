import type { DatabaseSync } from "node:sqlite";
import { captionWatchCycleStatus } from "./telegram-caption-watch-cycle";

const reasonLabels: Record<string, string> = {
  busy: "个人账号正在处理其他请求，当前文案保留等待重试。",
  backoff: "Telegram 要求暂缓请求，当前文案会在限流时间结束后继续核实。",
  disconnected: "个人账号连接失效，请在后台重新连接后继续当前文案。",
  unavailable: "暂时无法连接 Telegram，当前文案保留重试。",
  source_inactive: "来源频道已不在当前授权范围，等待重新核实来源设置。",
  source_unavailable: "暂时无法读取这条来源消息，当前文案保留重试。",
  source_not_found: "尚未读到这条来源消息，当前文案保留重试。",
  source_invalid: "来源消息的身份或媒体资料尚未核实，当前文案不会跳过。",
  source_caption_invalid: "来源文案或 Emoji 资料不完整，等待读取有效版本。",
  source_caption_missing: "来源目前没有文案，保留当前条等待来源补全文案。",
  source_identity_invalid: "来源消息身份尚未核实，当前文案保留重试。",
  source_capture_waiting: "最新来源文案尚未完整保存，当前条继续核实。",
  source_backoff: "Telegram 要求暂缓读取来源，限流结束后继续核实当前条。",
  source_busy: "个人账号正在处理其他请求，稍后继续读取当前来源文案。",
  bot_updates_pending: "正在读取机器人最新编辑更新，读尽当前事件后继续核对这条文案。",
  bot_updates_gap: "机器人曾长时间断线，无法确认缺失的历史编辑；当前条保留等待人工核实。",
  source_media_changed: "来源媒体身份已变化，需要核实后才能修改文案。",
  source_pending: "最新来源文案已排队，正在等待本条原消息更新并回读。",
  source_changed: "检查期间来源版本已更新，继续核对最新版本。",
  identity_unverified: "旧目标消息的媒体身份尚未核实，无法安全自动修改；当前条保留核验。",
  caption_mismatch: "目标文字与来源不同，正在核实原媒体身份后补正文案。",
  watch_readonly: "上次文案编辑结果尚未确认，继续只读核实，避免重复提交。",
  buttons_mismatch: "目标按钮与固定入口不同，需要核实后才能确认一致。",
  target_unqualified: "个人账号缺少目标频道编辑权限，请检查管理员权限。",
  account_unqualified: "当前账号无法保留该文案的自定义 Emoji，请检查 Premium 与编辑资格。",
  media_invalid: "目标媒体身份尚未通过核验，当前文案保留等待处理。",
  actual_entities_unsupported: "目标文案包含暂时无法完整核验的格式资料。",
  expected_entities_invalid: "来源文案格式资料未通过核验，等待重新读取。",
  expected_links_unsafe: "来源链接转换尚未通过核验，当前文案保留等待处理。",
  stored_entities_invalid: "保存的文案格式资料未通过核验，当前文案保留等待处理。",
  message_not_found: "暂时无法读回目标原消息，当前文案保留重试。",
  message_identity_invalid: "目标原消息身份尚未核实，当前文案保留等待处理。",
  message_not_direct_post: "目标消息不是可安全补正的直接频道原帖。",
  waiting: "当前文案尚未确认一致，保留本条继续核实。",
};
export function safeCaptionWatchReason(value: string | undefined): string {
  return value && Object.prototype.hasOwnProperty.call(reasonLabels, value) ? value : "waiting";
}
export function captionWatchReasonMessage(value: string | undefined): string {
  return reasonLabels[safeCaptionWatchReason(value)];
}

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
      AND (o.origin<>'bot' OR o.source_content_hash<>'invalid:source_inactive')
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
  const cycle = captionWatchCycleStatus(db, now);
  const currentError = cycle?.currentStartedAt ? db.prepare(`SELECT o.caption_watch_last_error FROM telegram_relay_outbox o
    JOIN telegram_relay_caption_watch_cycle c ON c.current_outbox_id=o.id WHERE c.id='primary'`).get() as { caption_watch_last_error: string } | undefined : undefined;
  const safeCurrentError = currentError && Object.values(reasonLabels).includes(currentError.caption_watch_last_error)
    ? currentError.caption_watch_last_error : "";
  return {
    watched: aggregate.watched, pending: aggregate.pending, checking: aggregate.checking,
    consistent: aggregate.consistent, mismatch: aggregate.mismatch, waiting: aggregate.waiting,
    lastCheckedAt: aggregate.last_checked && aggregate.last_checked <= now ? aggregate.last_checked : null,
    cycle,
    nextCheckAt: active && (aggregate.runnable > 0 || cycle?.enabled && cycle.total > 0)
      ? Math.max(now, cycle?.enabled ? cycle.nextAttemptAt || now : aggregate.next_check || now, accountWait?.next_attempt_at || 0, accountWait?.lease_until || 0) : null,
    lastError: safeCurrentError || (aggregate.mismatch > 0 ? "发现文案、格式、Emoji 或按钮不一致，正在核对原消息。"
      : aggregate.waiting > 0 ? "部分消息等待连接、权限或文案资料核实；发送结果未确认的媒体不会重发。" : ""),
  };
}
