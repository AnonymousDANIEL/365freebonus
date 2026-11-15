import type { DatabaseSync } from "node:sqlite";
import { getSqlite } from "./sqlite";
import { readHotVideoSourcePages, type HotVideoSourceHistory } from "./telegram-account";
import { registerHotChannelVideo } from "./telegram-hot-videos";

type Source = { chat_id: number; title: string; username: string; selected: number; revision: string;
  backfill_before_id: number; last_message_id: number; backfill_done: number; last_synced_at: number; last_error: string; next_attempt_at: number };
const messages: Record<HotVideoSourceHistory["state"], string> = {
  ok: "", busy: "", changed: "来源或账号设置已改变，请刷新频道列表，并确认个人账号仍已加入来源频道。", backoff: "Telegram 正在限制读取频率，系统稍后继续同步。",
  disconnected: "请先在后台连接个人 Telegram 账号，以读取来源频道已有的视频。",
  protected: "来源频道已限制转发，系统不会读取或发布其中的视频。",
  unavailable: "来源频道暂时无法读取，请检查账号是否仍已加入该频道。",
};
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("SAVEPOINT telegram_hot_video_source_sync");
  try { const result = work(); db.exec("RELEASE telegram_hot_video_source_sync"); return result; }
  catch (error) { db.exec("ROLLBACK TO telegram_hot_video_source_sync; RELEASE telegram_hot_video_source_sync"); throw error; }
}
/** Bounded metadata discovery only. Importing never enqueues a publication or downloads a media file. */
export async function syncHotVideoSources(db = getSqlite(), options: { all?: boolean } = {}) {
  const at = Date.now(), maximum = options.all ? 10 : 1, startDeadline = at + 15_000;
  const sources = db.prepare(`SELECT * FROM telegram_hot_video_sources WHERE selected=1 AND next_attempt_at<=?
    ORDER BY last_synced_at,chat_id LIMIT ?`).all(at, maximum) as Source[];
  let scanned = 0, discovered = 0, skipped = 0;
  for (const source of sources) {
    // One in-flight account read can take 40 seconds; do not begin enough slow
    // sources to push an explicit refresh beyond the HTTP proxy time budget.
    if (Date.now() >= startDeadline) break;
    const result = await readHotVideoSourcePages(db, { chatId: source.chat_id, revision: source.revision,
      beforeId: source.backfill_before_id, afterId: source.last_message_id, backfillDone: source.backfill_done === 1 });
    const valid = () => Boolean(db.prepare("SELECT 1 FROM telegram_hot_video_sources WHERE chat_id=? AND selected=1 AND revision=?").get(source.chat_id, source.revision));
    if (!valid()) { skipped++; continue; }
    if (result.state !== "ok") {
      transaction(db, () => {
        if (!valid()) return;
        db.prepare("UPDATE telegram_hot_video_sources SET last_error=?,next_attempt_at=? WHERE chat_id=? AND selected=1 AND revision=?")
          .run(messages[result.state], Date.now() + Math.max(15_000, Math.min(24 * 60 * 60_000, result.retryAfterMs)), source.chat_id, source.revision);
      });
      skipped++; continue;
    }
    transaction(db, () => {
      if (!valid()) { skipped++; return; }
      const account = db.prepare("SELECT generation,stage FROM telegram_personal_account WHERE id='primary'").get() as { generation: string; stage: string } | undefined;
      if (!account || account.stage !== "connected" || account.generation !== result.accountGeneration) { skipped++; return; }
      for (const video of result.videos) {
        const known = db.prepare("SELECT 1 FROM telegram_hot_videos WHERE origin='channel' AND source_chat_id=? AND source_message_id=?").get(source.chat_id, video.sourceMessageId);
        const registered = registerHotChannelVideo(db, { sourceChatId: source.chat_id, sourceMessageId: video.sourceMessageId,
          sourceTitle: result.sourceTitle || source.title, documentId: video.documentId, bytes: video.bytes, createdAt: video.createdAt });
        if (registered && !known) discovered++;
      }
      db.prepare(`UPDATE telegram_hot_video_sources SET title=?,username=?,last_message_id=?,backfill_before_id=?,backfill_done=?,
        last_synced_at=?,last_error='',next_attempt_at=? WHERE chat_id=? AND selected=1 AND revision=?`)
        .run(result.sourceTitle || source.title, result.sourceUsername, result.lastMessageId, result.backfillBeforeId, Number(result.backfillDone),
          Date.now(), Date.now() + 30_000, source.chat_id, source.revision);
      scanned++;
    });
  }
  return { scanned, discovered, skipped };
}
