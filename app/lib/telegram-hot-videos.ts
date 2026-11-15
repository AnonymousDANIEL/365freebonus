import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, mkdirSync, readdirSync, statfsSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getDataDirectory, getSqlite } from "./sqlite";
import { telegramRequest, telegramVideoFileRequest } from "./telegram-bot";
import { HOT_VIDEO_MAX_BYTES, HOT_VIDEO_CLOUD_BYTES, HOT_VIDEO_FREE_BYTES } from "./telegram-hot-video-limits";
export { HOT_VIDEO_MAX_BYTES } from "./telegram-hot-video-limits";

type DecryptToken = (ciphertext: string) => string;
type Config = { enabled: number; target_chat_id: number; target_title: string; interval_hours: number; next_run_at: number;
  revision: string; token_hash: string; bot_id: number; verified_at: number; last_checked_at: number; last_error: string;
  mark_source_used: number; last_auto_order: number; lease_id: string; lease_until: number; next_send_at: number };
type Video = { id: string; title: string; original_name: string; file_name: string; bytes: number; sha256: string;
  active: number; sort_order: number; created_at: number; last_sent_at: number; deleted_at: number;
  origin: "upload" | "channel"; source_chat_id: number; source_message_id: number; source_document_id: string; source_title: string; source_date: number };
type Job = { id: string; request_id: string; video_id: string; kind: "manual" | "scheduled" | "automatic"; status: string;
  run_at: number; created_at: number; settings_revision: string; target_chat_id: number; token_hash: string; bot_id: number;
  attempts: number; next_attempt_at: number; lease_id: string; lease_until: number; dispatch_started_at: number;
  last_error: string; sent_at: number; message_id: number; consumption_key: string; marker_status: string; marker_attempts: number;
  marker_dispatch_started_at: number; marker_next_attempt_at: number; marker_message_id: number; marker_error: string };
export type HotVideoSettingsInput = { enabled: boolean; targetChatId: string; intervalHours: number; firstRunAt: number | null; revision?: string; sources?: string[]; markSourceUsed?: boolean };
export type HotVideoRegistration = { id: string; title: string; originalName: string; fileName: string; bytes: number; sha256: string };
const HOUR = 60 * 60_000, LEASE_MS = 120_000, TICK_MS = 5_000, GAP_MS = 3_000, MAX_ATTEMPTS = 5, UPLOAD_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_ERROR = "请先在 Telegram 设置保存 @FreeBonus365ChatBot 的 Token。";
const PERMISSION_ERROR = "请将 @FreeBonus365ChatBot 加入 Hot 频道，并开启管理员发布消息权限。";
const TARGET_ERROR = "Hot 频道或机器人身份已改变，请重新保存视频发布设置。";
const UNKNOWN_ERROR = "Telegram 未确认视频发送结果，已停止自动重试以避免重复。";
const FILE_ERROR = "视频文件缺失、损坏或已改变，请删除后重新上传。";
const TEMP_ERROR = "暂时无法连接 Telegram，稍后自动重试。";
export class HotVideoError extends Error { constructor(message: string, readonly status = 400, readonly retryAfter = 0) { super(message); } }
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const negative = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value < 0;
function config(db: DatabaseSync): Config {
  db.prepare("INSERT OR IGNORE INTO telegram_hot_video_settings(id) VALUES('primary')").run();
  return db.prepare("SELECT * FROM telegram_hot_video_settings WHERE id='primary'").get() as Config;
}
function credential(db: DatabaseSync) {
  return (db.prepare("SELECT chat_bot_token_ciphertext FROM telegram_promotion_settings WHERE id='primary'").get() as { chat_bot_token_ciphertext: string } | undefined)?.chat_bot_token_ciphertext || "";
}
function defaultTarget(db: DatabaseSync): number {
  return Number((db.prepare("SELECT target_chat_id FROM telegram_join_gate_settings WHERE id='primary'").get() as { target_chat_id: number } | undefined)?.target_chat_id || 0);
}
export function hotVideoKeyboard() {
  return [
    [{ text: "🌐 Visit website", url: "https://365freebonus.com/" }],
    [{ text: "🎁 365 Free Bonus Official", url: "https://t.me/join365freebonus" }],
    [{ text: "🎁 365 Free Bonus Group", url: "https://t.me/join365freebonusgroup" }],
  ];
}
export function hotVideoStorageDirectory(): string {
  const directory = path.join(getDataDirectory(), "hot-videos");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
function videoPath(video: Pick<Video, "id" | "file_name">): string {
  if (!UUID.test(video.id) || video.file_name !== `${video.id}.mp4`) throw new HotVideoError(FILE_ERROR, 409);
  return path.join(hotVideoStorageDirectory(), video.file_name);
}
function storageBytes(db: DatabaseSync, now: number): number {
  const saved = db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM telegram_hot_videos WHERE deleted_at=0 AND origin='upload'").get() as { n: number };
  const reserved = db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM telegram_hot_video_uploads WHERE created_at>?").get(now - UPLOAD_MS) as { n: number };
  return saved.n + reserved.n;
}
export function hotVideoAvailableBytes(db: DatabaseSync, now = Date.now()): number {
  const disk = statfsSync(hotVideoStorageDirectory());
  const reserved = (db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM telegram_hot_video_uploads WHERE created_at>?").get(now - UPLOAD_MS) as { n: number }).n;
  return Math.max(0, disk.bavail * disk.bsize - HOT_VIDEO_FREE_BYTES - reserved);
}
export function reserveHotVideoUpload(db: DatabaseSync, input: { id: string; bytes: number }, clock = Date.now, onReserved?: (now: number) => void) {
  if (!UUID.test(input.id) || !positive(input.bytes) || input.bytes > HOT_VIDEO_MAX_BYTES) throw new HotVideoError("视频超过 Telegram 原画上传上限（2000 MB），请选择较小的 MP4 视频。", 413);
  transaction(db, () => {
    const now = clock();
    db.prepare("DELETE FROM telegram_hot_video_uploads WHERE created_at<=?").run(now - UPLOAD_MS);
    if (db.prepare("SELECT 1 FROM telegram_hot_videos WHERE id=?").get(input.id) || db.prepare("SELECT 1 FROM telegram_hot_video_uploads WHERE id=?").get(input.id))
      throw new HotVideoError("上传编号已使用，请重新选择视频。", 409);
    if (Number((db.prepare("SELECT COUNT(*) AS n FROM telegram_hot_video_uploads").get() as { n: number }).n) >= 2) throw new HotVideoError("已有两个视频正在上传，请稍后再试。", 429);
    if (Number((db.prepare("SELECT COUNT(*) AS n FROM telegram_hot_videos WHERE deleted_at=0 AND origin='upload'").get() as { n: number }).n) >= 100) throw new HotVideoError("视频空间已满，请先删除不再需要的视频。", 413);
    const available = statfsSync(hotVideoStorageDirectory());
    const reservations = Number((db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM telegram_hot_video_uploads").get() as { n: number }).n);
    if (available.bavail * available.bsize < reservations + input.bytes + HOT_VIDEO_FREE_BYTES) throw new HotVideoError("服务器视频空间不足，请先删除部分视频。", 413);
    db.prepare("INSERT INTO telegram_hot_video_uploads(id,bytes,created_at) VALUES(?,?,?)").run(input.id, input.bytes, now);
    onReserved?.(now);
  });
}
export function releaseHotVideoUpload(db: DatabaseSync, id: string) { db.prepare("DELETE FROM telegram_hot_video_uploads WHERE id=?").run(id); }
export function registerHotVideo(db: DatabaseSync, input: HotVideoRegistration, clock = Date.now) {
  if (!UUID.test(input.id) || input.fileName !== `${input.id}.mp4` || typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 160
    || typeof input.originalName !== "string" || !input.originalName.trim() || input.originalName.length > 255 || /[\u0000-\u001f]/.test(input.originalName)
    || !positive(input.bytes) || input.bytes > HOT_VIDEO_MAX_BYTES || !/^[a-f0-9]{64}$/.test(input.sha256)) throw new HotVideoError("请检查上传的视频资料。");
  const filename = videoPath({ id: input.id, file_name: input.fileName });
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== input.bytes) throw new HotVideoError(FILE_ERROR, 409);
  transaction(db, () => {
    const now = clock(), reservation = db.prepare("SELECT bytes,created_at FROM telegram_hot_video_uploads WHERE id=?").get(input.id) as { bytes: number; created_at: number } | undefined;
    if (!reservation || reservation.bytes !== input.bytes || reservation.created_at <= now - UPLOAD_MS) throw new HotVideoError("上传已过期，请重新上传。", 409);
    const order = Number((db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM telegram_hot_videos").get() as { n: number }).n);
    db.prepare("INSERT INTO telegram_hot_videos(id,title,original_name,file_name,bytes,sha256,sort_order,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(input.id, input.title.trim(), input.originalName.trim(), input.fileName, input.bytes, input.sha256, order, now);
    releaseHotVideoUpload(db, input.id);
  });
}
type ChannelSource = { chat_id: number; title: string; username: string; selected: number; revision: string; last_synced_at: number;
  last_error: string; token_hash: string; verified_at: number; backfill_done: number; backfill_before_id: number };
function sourceRow(db: DatabaseSync, id: number) { return db.prepare("SELECT * FROM telegram_hot_video_sources WHERE chat_id=?").get(id) as ChannelSource | undefined; }
function sourceAllowed(db: DatabaseSync, video: Video, target: number) {
  return video.origin !== "channel" || video.source_chat_id !== target && sourceRow(db, video.source_chat_id)?.selected === 1;
}
function occupied(db: DatabaseSync, id: string, except = "") {
  return !!db.prepare("SELECT 1 FROM telegram_hot_video_jobs WHERE video_id=? AND id<>? AND status IN ('pending','sending','sent','unknown') LIMIT 1").get(id, except);
}
const AUTO_VIDEO_WHERE = `v.deleted_at=0 AND v.active=1
  AND ((v.origin='upload' AND NOT EXISTS(SELECT 1 FROM telegram_hot_video_sources selected_source WHERE selected_source.selected=1))
    OR (v.origin='channel' AND v.last_sent_at=0 AND v.source_chat_id<>?
      AND EXISTS(SELECT 1 FROM telegram_hot_video_sources s WHERE s.chat_id=v.source_chat_id AND s.selected=1)
      AND NOT EXISTS(SELECT 1 FROM telegram_hot_video_jobs j WHERE j.video_id=v.id AND j.status IN ('pending','sending','sent','unknown','failed'))))`;
type Runtime = { heartbeat_at:number;last_tick_at:number;last_completed_at:number;scan_started_at:number;last_scan_at:number;phase:string;scan_phase:string;last_error:string };
function schedulerStatus(db:DatabaseSync,value:Config,now:number,tokenHash:string) {
  const runtime=db.prepare("SELECT * FROM telegram_hot_video_runtime WHERE id='primary'").get() as Runtime|undefined;
  const target=value.target_chat_id || defaultTarget(db);
  const eligibleCount=(db.prepare(`SELECT COUNT(*) AS n FROM telegram_hot_videos v WHERE ${AUTO_VIDEO_WHERE}`).get(target) as {n:number}).n;
  const sourceCount=(db.prepare("SELECT COUNT(*) AS n FROM telegram_hot_video_sources WHERE selected=1").get() as {n:number}).n;
  const unusedCount=(db.prepare(`SELECT COUNT(*) AS n FROM telegram_hot_videos v WHERE v.deleted_at=0 AND v.origin='channel' AND v.last_sent_at=0
    AND EXISTS(SELECT 1 FROM telegram_hot_video_sources s WHERE s.selected=1 AND s.chat_id=v.source_chat_id)
    AND NOT EXISTS(SELECT 1 FROM telegram_hot_video_jobs j WHERE j.video_id=v.id AND j.status IN ('sent','unknown'))`).get() as {n:number}).n;
  const nextJobs=(db.prepare(`SELECT j.id,j.video_id,v.title,j.run_at,j.kind,j.status FROM telegram_hot_video_jobs j
    JOIN telegram_hot_videos v ON v.id=j.video_id WHERE j.status='pending' AND j.target_chat_id=? AND j.token_hash=? ORDER BY j.run_at,j.created_at,j.id LIMIT 20`).all(target,tokenHash) as {id:string;video_id:string;title:string;run_at:number;kind:string;status:string}[])
    .map(j=>({id:j.id,videoId:j.video_id,title:j.title,runAt:j.run_at,kind:j.kind,status:j.status}));
  const queuedCount=(db.prepare("SELECT COUNT(*) AS n FROM telegram_hot_video_jobs WHERE status='pending' AND target_chat_id=? AND token_hash=?").get(target,tokenHash) as {n:number}).n;
  const activeJob=db.prepare("SELECT status,marker_status FROM telegram_hot_video_jobs WHERE lease_until>? AND (status='sending' OR (status='sent' AND marker_status='sending')) LIMIT 1").get(now) as {status:string;marker_status:string}|undefined;
  const workerHealthy=!!runtime?.heartbeat_at && runtime.heartbeat_at>now-20000;
  const sourceError=db.prepare("SELECT last_error FROM telegram_hot_video_sources WHERE selected=1 AND last_error<>'' ORDER BY last_synced_at LIMIT 1").get() as {last_error:string}|undefined;
  let blockedReason='';
  if (!value.enabled) blockedReason='自动队列已暂停；已保存的单次定时任务仍会按时间执行。';
  else if (!target || !value.verified_at || value.token_hash!==tokenHash) blockedReason='请先保存并验证目标频道。';
  else if (runtime?.last_error) blockedReason=runtime.last_error;
  else if (!sourceCount && !eligibleCount) blockedReason='请先选择来源频道并保存。';
  else if (!eligibleCount) blockedReason=queuedCount?'视频已安排单次任务，自动队列等待其他未使用视频。'
    :sourceError?.last_error || (runtime?.scan_phase==='error'?'来源同步暂时未完成，正在自动重试。':runtime?.scan_phase==='running'?'正在同步来源视频，识别后会进入队列。'
      :unusedCount?'当前视频需要检查发送状态，请查看视频队列。':'没有可发送的视频；系统会继续同步来源频道。');
  else if (!workerHealthy) blockedReason='发送服务正在启动或恢复，请留意服务状态。';
  return {now,heartbeatAt:runtime?.heartbeat_at || null,lastTickAt:runtime?.last_tick_at || null,lastCompletedAt:runtime?.last_completed_at || null,
    workerHealthy,phase:activeJob?.status==='sending'?'sending':activeJob?.marker_status==='sending'?'marker':runtime?.phase || 'starting',
    scanPhase:runtime?.scan_phase || 'idle',scanStartedAt:runtime?.scan_started_at || null,lastScanAt:runtime?.last_scan_at || null,
    nextRunAt:value.enabled && value.next_run_at?value.next_run_at:null,eligibleCount,unusedCount,queuedCount,sourceCount,blockedReason,nextJobs,lastError:runtime?.last_error || ''};
}
function sourceUrl(chatId: number, messageId: number) {
  return chatId < -1000000000000 && positive(messageId) ? `https://t.me/c/${-BigInt(chatId) - BigInt("1000000000000")}/${messageId}` : "";
}
export function registerHotChannelVideo(db: DatabaseSync, input: { sourceChatId: number; sourceMessageId: number; sourceTitle: string; documentId: string; bytes: number; createdAt: number }, clock = Date.now): string | null {
  if (!negative(input.sourceChatId) || input.sourceChatId >= -1000000000000 || !positive(input.sourceMessageId) || input.sourceMessageId > 2147483647
    || typeof input.sourceTitle !== "string" || typeof input.documentId !== "string" || !/^-?[1-9]\d{0,19}$/.test(input.documentId)
    || !positive(input.bytes) || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0) throw new HotVideoError("来源视频资料不完整。", 400);
  const document = BigInt(input.documentId);
  if (document < BigInt("-9223372036854775808") || document > BigInt("9223372036854775807")) throw new HotVideoError("来源视频编号不正确。", 400);
  db.exec("SAVEPOINT hot_channel_video_register");
  try {
    const value = config(db), source = sourceRow(db, input.sourceChatId);
    if (!source?.selected || input.sourceChatId === (value.target_chat_id || defaultTarget(db))) {
      db.exec("RELEASE hot_channel_video_register"); return null;
    }
    const previous = db.prepare("SELECT id FROM telegram_hot_videos WHERE origin='channel' AND source_chat_id=? AND source_message_id=?").get(input.sourceChatId, input.sourceMessageId) as { id: string } | undefined;
    if (previous) { db.exec("RELEASE hot_channel_video_register"); return previous.id; }
    const id = randomUUID(), order = (db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM telegram_hot_videos").get() as { n: number }).n;
    const title = `${input.sourceTitle.slice(0, 130) || "Channel"} · #${input.sourceMessageId}`;
    db.prepare(`INSERT INTO telegram_hot_videos(id,title,original_name,file_name,bytes,sha256,sort_order,created_at,origin,source_chat_id,source_message_id,source_document_id,source_title,source_date)
      VALUES(?,?,?,'',?,'',?,?,'channel',?,?,?,?,?)`).run(id,title,`Video #${input.sourceMessageId}`,input.bytes,order,clock(),input.sourceChatId,input.sourceMessageId,input.documentId,input.sourceTitle.slice(0,200),input.createdAt);
    db.exec("RELEASE hot_channel_video_register"); return id;
  } catch (error) { db.exec("ROLLBACK TO hot_channel_video_register; RELEASE hot_channel_video_register"); throw error; }
}
function cleanTarget(value: string, fallback: number): number {
  if (!value && negative(fallback)) return fallback;
  if (!/^-[1-9]\d{0,15}$/.test(value) || !negative(Number(value))) throw new HotVideoError("请选择 Hot 频道，或填写以 -100 开头的频道数字 ID。");
  return Number(value);
}
async function verifyTarget(token: string, targetId: number, valid: () => boolean) {
  const ask = async (method: "getMe" | "getChat" | "getChatMember", parameters: Record<string, unknown>) => {
    if (!valid()) throw new HotVideoError(TARGET_ERROR, 409);
    const result = await telegramRequest(token, method, parameters).catch(() => null);
    if (!valid()) throw new HotVideoError(TARGET_ERROR, 409);
    if (!result?.ok) throw new HotVideoError(result && [400, 401, 403].includes(result.code) ? PERMISSION_ERROR : TEMP_ERROR,
      result && [400, 401, 403, 429].includes(result.code) ? result.code : 503, result && !result.ok ? result.retryAfter : 0);
    return result.result;
  };
  const me = await ask("getMe", {});
  if (!positive(me.id) || me.is_bot !== true || String(me.username).toLowerCase() !== "freebonus365chatbot") throw new HotVideoError(TOKEN_ERROR, 400);
  const chat = await ask("getChat", { chat_id: targetId });
  if (chat.id !== targetId || chat.type !== "channel" || chat.username || Array.isArray(chat.active_usernames) && chat.active_usernames.length)
    throw new HotVideoError("目标必须是没有公开用户名的 Hot 私密频道，请填写该频道数字 ID。");
  const role = await ask("getChatMember", { chat_id: targetId, user_id: me.id });
  if (role.status !== "creator" && !(role.status === "administrator" && role.can_post_messages === true)) throw new HotVideoError(PERMISSION_ERROR, 403);
  return { botId: me.id, title: typeof chat.title === "string" ? chat.title.slice(0, 200) : "🔞365 Free Bonus Hot" };
}
function cancelObsolete(db: DatabaseSync, value: Config, tokenHash: string) {
  db.prepare(`UPDATE telegram_hot_video_jobs SET status='cancelled',last_error=? WHERE status='pending'
    AND (target_chat_id<>? OR token_hash<>? OR (kind='automatic' AND (settings_revision<>? OR ?=0)))`)
    .run(TARGET_ERROR, value.target_chat_id, tokenHash, value.revision, value.enabled);
}
export function hotVideoStatus(db: DatabaseSync, clock = Date.now) {
  const value = config(db), now = clock(), cipher = credential(db), tokenHash = hash(cipher);
  const videos = db.prepare(`SELECT * FROM telegram_hot_videos WHERE deleted_at=0
    ORDER BY CASE WHEN last_sent_at=0 THEN 0 ELSE 1 END,CASE WHEN last_sent_at>0 THEN -last_sent_at ELSE sort_order END,id LIMIT 250`).all() as Video[];
  const jobs = db.prepare(`SELECT j.*,v.title FROM telegram_hot_video_jobs j JOIN telegram_hot_videos v ON v.id=j.video_id
    ORDER BY j.created_at DESC,j.id DESC LIMIT 100`).all() as (Job & { title: string })[];
  const counts = { pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0, cancelled: 0 };
  for (const row of db.prepare("SELECT status,COUNT(*) AS n FROM telegram_hot_video_jobs GROUP BY status").all() as { status: string; n: number }[])
    if (row.status in counts) counts[row.status as keyof typeof counts] = row.n;
  const unresolved = db.prepare(`SELECT last_error FROM telegram_hot_video_jobs WHERE target_chat_id=? AND token_hash=?
    AND status IN ('failed','unknown') AND last_error<>'' ORDER BY created_at DESC,id DESC LIMIT 1`).get(value.target_chat_id, value.token_hash) as { last_error: string } | undefined;
  const candidates = db.prepare("SELECT chat_id,title FROM telegram_join_gate_candidates WHERE token_hash=? ORDER BY verified_at DESC LIMIT 30").all(tokenHash) as { chat_id: number; title: string }[];
  const target = value.target_chat_id || defaultTarget(db), usedBytes = storageBytes(db, now), availableBytes = hotVideoAvailableBytes(db, now);
  const sources = db.prepare("SELECT * FROM telegram_hot_video_sources WHERE selected=1 ORDER BY title,chat_id").all() as ChannelSource[];
  let sourceCandidates: { chatId: string; title: string; username: string }[] = [];
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='telegram_personal_sources'").get()) {
    sourceCandidates = (db.prepare("SELECT chat_id,title,username FROM telegram_personal_sources WHERE joined=1 AND chat_id<>? ORDER BY title,chat_id LIMIT 1000").all(target) as { chat_id: number; title: string; username: string }[])
      .map(s => ({ chatId: String(s.chat_id), title: s.title, username: s.username }));
  }
  const videoUsage = (video: Video) => {
    if (video.last_sent_at > 0) return "sent";
    const locked = db.prepare(`SELECT status FROM telegram_hot_video_jobs WHERE video_id=? AND status IN ('pending','sending','sent','unknown','failed')
      ORDER BY CASE status WHEN 'sent' THEN 0 WHEN 'unknown' THEN 1 WHEN 'sending' THEN 2 WHEN 'pending' THEN 3 ELSE 4 END LIMIT 1`).get(video.id) as { status: string } | undefined;
    return locked?.status || "unused";
  };
  return { scheduler:schedulerStatus(db,value,now,tokenHash), markSourceUsed: value.mark_source_used === 1, sourceChannels: sources.map(s => ({ chatId: String(s.chat_id),title:s.title,username:s.username,selected:true,
    ready:s.verified_at > 0 && s.token_hash === tokenHash && !s.last_error,lastError:s.last_error,lastSyncedAt:s.last_synced_at || null,
    historyComplete:s.backfill_done === 1 })), sourceCandidates,
    videoCount: (db.prepare("SELECT COUNT(*) AS n FROM telegram_hot_videos WHERE deleted_at=0").get() as {n:number}).n,
    enabled: value.enabled === 1, targetChatId: target ? String(target) : "", targetTitle: value.target_title || "🔞365 Free Bonus Hot",
    intervalHours: value.interval_hours, nextRunAt: value.enabled && value.next_run_at ? value.next_run_at : null, revision: value.revision,
    ready: value.target_chat_id < 0 && value.verified_at > 0 && value.token_hash === tokenHash && !!cipher && !value.last_error,
    lastError: value.token_hash && value.token_hash !== tokenHash ? TOKEN_ERROR : value.last_error || unresolved?.last_error || "", lastCheckedAt: value.last_checked_at || null,
    storage: { bytes: usedBytes, maxBytes: usedBytes + availableBytes, maxVideoBytes: HOT_VIDEO_MAX_BYTES, availableBytes },
    videos: videos.map(v => ({ id: v.id, title: v.title, origin:v.origin, sourceChatId:v.origin === "channel" ? String(v.source_chat_id) : "",
      sourceMessageId:v.source_message_id,sourceTitle:v.source_title,sourceUrl:sourceUrl(v.source_chat_id,v.source_message_id),used:videoUsage(v) === "sent",usageState:videoUsage(v), originalName: v.original_name, bytes: v.bytes, active: v.active === 1, createdAt: v.created_at, lastSentAt: v.last_sent_at || null })),
    jobs: jobs.map(j => ({ id: j.id, videoId: j.video_id, title: j.title, kind: j.kind, runAt: j.run_at, status: j.status,
      attempts: j.attempts, lastError: j.last_error, sentAt: j.sent_at || null, messageId: j.message_id || null, markerStatus:j.marker_status,markerError:j.marker_error,markerMessageId:j.marker_message_id || null })), counts,
    candidates: [{ chatId: target ? String(target) : "", title: value.target_title || "🔞365 Free Bonus Hot" },
      ...candidates.filter(c => c.chat_id !== target).map(c => ({ chatId: String(c.chat_id), title: c.title }))].filter(c => c.chatId),
  };
}
export async function saveHotVideoSettings(db: DatabaseSync, input: HotVideoSettingsInput, decryptToken: DecryptToken, clock = Date.now) {
  const previous = config(db), cipher = credential(db), now = clock();
  if (typeof input.enabled !== "boolean" || typeof input.targetChatId !== "string" || !Number.isInteger(input.intervalHours) || input.intervalHours < 1 || input.intervalHours > 24
    || input.firstRunAt !== null && (!positive(input.firstRunAt) || input.firstRunAt <= now || input.firstRunAt > now + 366 * 24 * HOUR)) throw new HotVideoError("请检查周期和首次发送时间。");
  if (input.revision !== undefined && input.revision !== previous.revision) throw new HotVideoError("设置已被其他页面更新，请刷新后再保存。", 409);
  if (previous.lease_until > now) throw new HotVideoError("有视频正在处理，请稍后保存。", 409);
  const target = input.targetChatId || defaultTarget(db) ? cleanTarget(input.targetChatId, defaultTarget(db)) : 0;
  if (input.enabled && !target) throw new HotVideoError("请先选择 Hot 频道。");
  const requested = input.sources === undefined ? (db.prepare("SELECT chat_id FROM telegram_hot_video_sources WHERE selected=1").all() as {chat_id:number}[]).map(s=>String(s.chat_id)) : input.sources;
  if (!Array.isArray(requested) || requested.length > 20 || new Set(requested).size !== requested.length
    || requested.some(id => typeof id !== "string" || !/^-[1-9]\d{0,15}$/.test(id) || !negative(Number(id)) || Number(id) >= -1000000000000 || Number(id) === target)
    || input.markSourceUsed !== undefined && typeof input.markSourceUsed !== "boolean") throw new HotVideoError("请选择不同于 Hot 目标的来源频道，最多 20 个。", 400);
  const markSourceUsed = input.markSourceUsed === undefined ? previous.mark_source_used === 1 : input.markSourceUsed;
  let checked: { botId: number; title: string } | undefined;
  const verifiedSources = new Map<number, {title:string;username:string}>();
  // Stopping automation must remain possible with revoked credentials or an
  // unreachable Telegram service. A disabled draft never grants send authority.
  if (target && input.enabled) {
    let token = ""; try { token = decryptToken(cipher); } catch { /* credentials stay private */ }
    if (!cipher || !token) throw new HotVideoError(TOKEN_ERROR);
    const valid = () => credential(db) === cipher && config(db).revision === previous.revision && config(db).lease_until <= clock();
    const cachedTarget=previous.target_chat_id===target && previous.token_hash===hash(cipher) && previous.verified_at>0 && previous.bot_id>0;
    // Changing only a saved time is a local operation; the sender rechecks current Telegram rights before dispatch.
    if (!cachedTarget) checked = await verifyTarget(token, target, valid);
    const verifySources=requested.filter(id=>{
      const saved=sourceRow(db,Number(id));
      return !saved?.selected || !saved.verified_at || saved.token_hash!==hash(cipher) || markSourceUsed && previous.mark_source_used!==1;
    });
    if (verifySources.length) {
      const { checkHotVideoSourceAccess } = await import("./telegram-hot-video-native");
      // Check new source grants only; unchanged source checks cannot stall a time-only save.
      for (let at=0;at<verifySources.length;at+=4) await Promise.all(verifySources.slice(at,at+4).map(async id => {
        const info = await checkHotVideoSourceAccess({db,token,botId:checked?.botId || previous.bot_id,sourceChatId:Number(id),requireSourcePost:markSourceUsed,valid});
        verifiedSources.set(Number(id),info);
      }));
    }
  }
  transaction(db, () => {
    const latest = config(db);
    if (latest.revision !== previous.revision || latest.lease_until > clock() || credential(db) !== cipher) throw new HotVideoError("设置正在处理，请稍后刷新重试。", 409);
    const changedSchedule = previous.enabled !== Number(input.enabled) || previous.target_chat_id !== target || previous.interval_hours !== input.intervalHours;
    const sameDestination = previous.target_chat_id === target;
    const next = input.enabled ? input.firstRunAt ?? (changedSchedule || !previous.next_run_at ? now + input.intervalHours * HOUR : previous.next_run_at) : 0;
    db.prepare(`UPDATE telegram_hot_video_settings SET enabled=?,target_chat_id=?,target_title=?,interval_hours=?,next_run_at=?,revision=?,
      token_hash=?,bot_id=?,verified_at=?,last_checked_at=?,last_error='',last_auto_order=CASE WHEN target_chat_id<>? THEN 0 ELSE last_auto_order END WHERE id='primary'`)
      .run(Number(input.enabled), target, checked?.title || (previous.target_chat_id === target ? previous.target_title : ""), input.intervalHours, next, randomUUID(),
        checked ? hash(cipher) : sameDestination ? previous.token_hash : "", checked?.botId || (sameDestination ? previous.bot_id : 0),
        checked ? clock() : sameDestination ? previous.verified_at : 0, checked ? clock() : previous.last_checked_at, target);
    db.prepare("UPDATE telegram_hot_video_settings SET mark_source_used=? WHERE id='primary'").run(Number(markSourceUsed));
    const keep = new Set(requested.map(Number));
    for (const removed of db.prepare("SELECT chat_id FROM telegram_hot_video_sources WHERE selected=1").all() as {chat_id:number}[]) if (!keep.has(removed.chat_id)) {
      db.prepare("UPDATE telegram_hot_video_sources SET selected=0,revision=? WHERE chat_id=?").run(randomUUID(),removed.chat_id);
      db.prepare(`UPDATE telegram_hot_video_jobs SET status='cancelled',last_error='来源频道已取消选择。'
        WHERE status='pending' AND video_id IN (SELECT id FROM telegram_hot_videos WHERE origin='channel' AND source_chat_id=?)`).run(removed.chat_id);
    }
    for (const id of keep) {
      const verified = verifiedSources.get(id), old = sourceRow(db,id);
      if (old?.selected && !verified) continue;
      db.prepare(`INSERT INTO telegram_hot_video_sources(chat_id,title,username,selected,revision,token_hash,verified_at) VALUES(?,?,?,1,?,?,?)
        ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,username=excluded.username,selected=1,
          revision=CASE WHEN telegram_hot_video_sources.selected=0 THEN excluded.revision ELSE telegram_hot_video_sources.revision END,
          token_hash=excluded.token_hash,verified_at=excluded.verified_at,last_error='',next_attempt_at=0`)
        .run(id,verified?.title || old?.title || String(id),verified?.username || old?.username || '',randomUUID(),verified ? hash(cipher) : old?.token_hash || '',verified ? clock() : old?.verified_at || 0);
    }
    if (!markSourceUsed) db.prepare("UPDATE telegram_hot_video_jobs SET marker_status='skipped',marker_error='' WHERE marker_status='pending'").run();
    cancelObsolete(db, config(db), hash(cipher));
  });
  return hotVideoStatus(db, clock);
}
export function updateHotVideo(db: DatabaseSync, input: { id: string; title?: string; active?: boolean }, clock = Date.now) {
  if (!UUID.test(input.id) || input.title !== undefined && (!input.title.trim() || input.title.trim().length > 160)
    || input.active !== undefined && typeof input.active !== "boolean") throw new HotVideoError("请检查视频名称或启用状态。");
  transaction(db, () => {
    const video = db.prepare("SELECT * FROM telegram_hot_videos WHERE id=? AND deleted_at=0").get(input.id) as Video | undefined;
    if (!video) throw new HotVideoError("视频已删除，请刷新。", 404);
    db.prepare("UPDATE telegram_hot_videos SET title=?,active=? WHERE id=?").run(input.title?.trim() ?? video.title, input.active === undefined ? video.active : Number(input.active), input.id);
    if (input.active === false) db.prepare("UPDATE telegram_hot_video_jobs SET status='cancelled',last_error='' WHERE video_id=? AND kind='automatic' AND status='pending'").run(input.id);
  });
  return hotVideoStatus(db, clock);
}
export function deleteHotVideo(db: DatabaseSync, id: string, clock = Date.now) {
  if (!UUID.test(id)) throw new HotVideoError("视频编号无效。");
  transaction(db, () => {
    const video = db.prepare("SELECT * FROM telegram_hot_videos WHERE id=? AND deleted_at=0").get(id) as Video | undefined;
    if (!video) return;
    if (db.prepare("SELECT 1 FROM telegram_hot_video_jobs WHERE video_id=? AND status='sending'").get(id)) throw new HotVideoError("该视频正在发送，请稍后删除。", 409);
    try { if (video.origin !== "channel") unlinkSync(videoPath(video)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new HotVideoError("暂时无法删除视频文件，请稍后重试。", 503); }
    db.prepare("UPDATE telegram_hot_video_jobs SET status='cancelled',last_error='' WHERE video_id=? AND status='pending'").run(id);
    db.prepare("UPDATE telegram_hot_videos SET active=0,deleted_at=? WHERE id=?").run(clock(), id);
  });
  return hotVideoStatus(db, clock);
}
export async function enqueueHotVideo(db: DatabaseSync, input: { videoId: string; runAt: number | null; requestId: string }, decryptToken: DecryptToken, clock = Date.now) {
  const now = clock();
  if (!UUID.test(input.videoId) || !UUID.test(input.requestId) || input.runAt !== null && !positive(input.runAt)) throw new HotVideoError("请检查视频或发送时间。");
  const existing = db.prepare("SELECT video_id,run_at,kind FROM telegram_hot_video_jobs WHERE request_id=?").get(input.requestId) as { video_id: string; run_at: number; kind: string } | undefined;
  if (existing) {
    if (existing.video_id !== input.videoId || input.runAt !== null && existing.run_at !== input.runAt || (input.runAt === null) !== (existing.kind === "manual")) throw new HotVideoError("操作编号已用于另一个发送任务。", 409);
    return hotVideoStatus(db, clock);
  }
  if (input.runAt !== null && (input.runAt <= now || input.runAt > now + 366 * 24 * HOUR)) throw new HotVideoError("请检查视频或发送时间。");
  const previous = config(db), cipher = credential(db), target = previous.target_chat_id || defaultTarget(db);
  let token = ""; try { token = decryptToken(cipher); } catch { /* credentials stay private */ }
  if (!target) throw new HotVideoError("请先设置 Hot 频道。");
  if (!cipher || !token) throw new HotVideoError(TOKEN_ERROR);
  const queuedVideo = db.prepare("SELECT * FROM telegram_hot_videos WHERE id=? AND deleted_at=0").get(input.videoId) as Video | undefined;
  if (!queuedVideo) throw new HotVideoError("视频已删除，请刷新。",404);
  if (queuedVideo.origin === "channel" && (!sourceAllowed(db,queuedVideo,target) || queuedVideo.last_sent_at || occupied(db,queuedVideo.id)))
    throw new HotVideoError("来源视频已使用、待确认或已有发送任务，请检查列表。",409);
  const verified = await verifyTarget(token, target, () => config(db).revision === previous.revision && credential(db) === cipher);
  transaction(db, () => {
    const latest = config(db);
    if (latest.revision !== previous.revision || credential(db) !== cipher) throw new HotVideoError(TARGET_ERROR, 409);
    const video = db.prepare("SELECT * FROM telegram_hot_videos WHERE id=? AND deleted_at=0").get(input.videoId) as Video | undefined;
    if (!video) throw new HotVideoError("视频已删除，请刷新。",404);
    if (video.origin === "channel" && (!sourceAllowed(db,video,target) || video.last_sent_at || occupied(db,video.id))) throw new HotVideoError("来源视频已使用或已有待处理任务。",409);
    if (Number((db.prepare("SELECT COUNT(*) AS n FROM telegram_hot_video_jobs WHERE status IN ('pending','sending')").get() as { n: number }).n) >= 500) throw new HotVideoError("待发送任务已满，请先处理现有任务。", 429);
    db.prepare(`UPDATE telegram_hot_video_settings SET target_chat_id=?,target_title=?,token_hash=?,bot_id=?,verified_at=?,last_checked_at=?,last_error='',
      revision=CASE WHEN revision='' THEN ? ELSE revision END WHERE id='primary'`).run(target, verified.title, hash(cipher), verified.botId, clock(), clock(), randomUUID());
    cancelObsolete(db, config(db), hash(cipher));
    db.prepare(`INSERT OR IGNORE INTO telegram_hot_video_jobs(id,request_id,video_id,kind,run_at,created_at,settings_revision,target_chat_id,token_hash,bot_id,next_attempt_at,consumption_key)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), input.requestId, input.videoId, input.runAt === null ? "manual" : "scheduled", input.runAt ?? now,
        now, config(db).revision, target, hash(cipher), verified.botId, input.runAt ?? now, video.origin === "channel" ? video.id : "");
  });
  return hotVideoStatus(db, clock);
}
export function cancelHotVideoJob(db: DatabaseSync, id: string, clock = Date.now) {
  if (!UUID.test(id)) throw new HotVideoError("任务编号无效。");
  transaction(db, () => {
    const job = db.prepare("SELECT status FROM telegram_hot_video_jobs WHERE id=?").get(id) as { status: string } | undefined;
    if (!job) throw new HotVideoError("任务已不存在。", 404);
    if (job.status === "sending") throw new HotVideoError("视频已进入发送阶段，无法取消。", 409);
    if (job.status !== "pending" && job.status !== "cancelled") throw new HotVideoError("该任务已经结束，无法取消。", 409);
    db.prepare("UPDATE telegram_hot_video_jobs SET status='cancelled',last_error='' WHERE id=? AND status='pending'").run(id);
  });
  return hotVideoStatus(db, clock);
}
async function verifyVideoFile(video: Video) {
  const filename = videoPath(video), handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== video.bytes || stat.size > HOT_VIDEO_MAX_BYTES) throw new HotVideoError(FILE_ERROR, 409);
    const digest = createHash("sha256"), header = Buffer.alloc(12); let size = 0;
    for await (const part of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      if (size < 12) chunk.copy(header, size, 0, Math.min(chunk.length, 12 - size));
      size += chunk.length;
      if (size > video.bytes || size > HOT_VIDEO_MAX_BYTES) throw new HotVideoError(FILE_ERROR, 409);
      digest.update(chunk);
    }
    if (size !== video.bytes || header.toString("ascii", 4, 8) !== "ftyp" || digest.digest("hex") !== video.sha256) throw new HotVideoError(FILE_ERROR, 409);
    return filename;
  } finally { await handle.close(); }
}
function deliverySafe(result: Record<string, unknown>, target: number) {
  const rows = record(result.reply_markup)?.inline_keyboard, expected = hotVideoKeyboard();
  return positive(result.message_id) && record(result.chat)?.id === target && !!record(result.video)
    && (result.caption === undefined || result.caption === "") && Array.isArray(rows) && rows.length === expected.length
    && expected.every((row, i) => Array.isArray(rows[i]) && rows[i].length === 1 && row.every((button, j) => {
      const actual = record(rows[i][j]); return actual?.text === button.text && actual.url === button.url && Object.keys(actual).length === 2;
    }));
}
function cleanupStorage(db: DatabaseSync, now: number) {
  db.prepare("DELETE FROM telegram_hot_video_uploads WHERE created_at<=?").run(now - UPLOAD_MS);
  const folder = hotVideoStorageDirectory();
  for (const name of readdirSync(folder).slice(0, 500)) {
    const match = /^([0-9a-f-]{36})\.(?:part|mp4)$/.exec(name);
    if (!match || !UUID.test(match[1]) || db.prepare("SELECT 1 FROM telegram_hot_videos WHERE id=? AND deleted_at=0").get(match[1])
      || db.prepare("SELECT 1 FROM telegram_hot_video_uploads WHERE id=?").get(match[1])) continue;
    try { const stat = lstatSync(path.join(folder, name)); if (stat.mtimeMs <= now - UPLOAD_MS && stat.isFile() && !stat.isSymbolicLink()) unlinkSync(path.join(folder, name)); } catch { /* next bounded cleanup retries */ }
  }
}
export async function deliverHotVideoOnce(decryptToken: DecryptToken, clock = Date.now) {
  const db = getSqlite();
  const claim = transaction(db, () => {
    const now = clock(), current = config(db), cipher = credential(db), tokenHash = hash(cipher);
    db.prepare(`UPDATE telegram_hot_video_jobs SET status=CASE WHEN dispatch_started_at>0 THEN 'unknown' ELSE 'pending' END,
      last_error=CASE WHEN dispatch_started_at>0 THEN ? ELSE last_error END,lease_id='',lease_until=0
      WHERE status='sending' AND lease_until<=?`).run(UNKNOWN_ERROR, now);
    if (current.lease_until > now || current.next_send_at > now) return null;
    cancelObsolete(db, current, tokenHash);
    if (current.enabled && current.next_run_at > 0 && current.next_run_at <= now) {
      const interval = current.interval_hours * HOUR, slot = current.next_run_at + Math.floor((now - current.next_run_at) / interval) * interval;
      // An interrupted or rate-limited old automatic occurrence is not a backlog
      // to publish beside the new slot. Preserve all actual/unknown attempts.
      db.prepare(`UPDATE telegram_hot_video_jobs SET status='cancelled',last_error='错过的自动发送时段已跳过。'
        WHERE kind='automatic' AND status='pending' AND run_at<?`).run(slot);
      const video = db.prepare(`SELECT v.* FROM telegram_hot_videos v WHERE ${AUTO_VIDEO_WHERE}
        ORDER BY CASE WHEN v.sort_order>? THEN 0 ELSE 1 END,v.sort_order,v.id LIMIT 1`).get(current.target_chat_id,current.last_auto_order) as Video | undefined;
      const room = Number((db.prepare("SELECT COUNT(*) AS n FROM telegram_hot_video_jobs WHERE status IN ('pending','sending')").get() as { n: number }).n) < 500;
      if (video && room && cipher && current.target_chat_id < 0 && current.token_hash === tokenHash) {
        db.prepare(`INSERT OR IGNORE INTO telegram_hot_video_jobs(id,request_id,video_id,kind,run_at,created_at,settings_revision,target_chat_id,token_hash,bot_id,next_attempt_at,consumption_key)
          VALUES(?,?,?,'automatic',?,?,?,?,?,?,?,?)`).run(randomUUID(), `auto:${current.revision}:${slot}`, video.id, slot, now, current.revision,
            current.target_chat_id, tokenHash, current.bot_id, now, video.origin === "channel" ? video.id : "");
        db.prepare("UPDATE telegram_hot_video_settings SET last_auto_order=? WHERE id='primary'").run(video.sort_order);
      }
      const waitingForSource=!video && now<slot+60000 && !!db.prepare("SELECT 1 FROM telegram_hot_video_sources WHERE selected=1 LIMIT 1").get();
      if (waitingForSource) db.prepare("UPDATE telegram_hot_video_settings SET last_error='正在同步来源，等待视频进入本次发送队列。' WHERE id='primary'").run();
      else db.prepare(`UPDATE telegram_hot_video_settings SET next_run_at=?,last_error=CASE
        WHEN ?=0 THEN '没有可发送的未使用来源视频，本次时段已跳过；有新视频后按原计划继续。' WHEN ?=0 THEN '待发送任务已满，本次自动时段已跳过。' ELSE last_error END WHERE id='primary'`)
        .run(slot + interval, Number(!!video), Number(room));
    }
    const job = db.prepare("SELECT * FROM telegram_hot_video_jobs WHERE status='pending' AND run_at<=? AND next_attempt_at<=? ORDER BY run_at,created_at,id LIMIT 1").get(now, now) as Job | undefined;
    if (!job) return null;
    const video = db.prepare("SELECT * FROM telegram_hot_videos WHERE id=? AND deleted_at=0").get(job.video_id) as Video | undefined;
    if (!video || !sourceAllowed(db, video, job.target_chat_id) || video.origin === "channel" && (video.last_sent_at > 0 || occupied(db, video.id, job.id)) || job.kind === "automatic" && !video.active) {
      db.prepare("UPDATE telegram_hot_video_jobs SET status='cancelled',last_error='' WHERE id=?").run(job.id); return null;
    }
    const lease = randomUUID();
    db.prepare("UPDATE telegram_hot_video_settings SET lease_id=?,lease_until=?,last_checked_at=? WHERE id='primary'").run(lease, now + LEASE_MS, now);
    db.prepare("UPDATE telegram_hot_video_jobs SET status='sending',attempts=attempts+1,lease_id=?,lease_until=?,dispatch_started_at=0 WHERE id=?")
      .run(lease, now + LEASE_MS, job.id);
    return { job: { ...job, attempts: job.attempts + 1 }, video, lease, cipher };
  });
  if (!claim) return;
  const allowed = () => {
    const current = config(db), cipher = credential(db), at = clock();
    const job = db.prepare("SELECT * FROM telegram_hot_video_jobs WHERE id=?").get(claim.job.id) as Job | undefined;
    const video = db.prepare("SELECT active,deleted_at FROM telegram_hot_videos WHERE id=?").get(claim.video.id) as { active: number; deleted_at: number } | undefined;
    return !!job && job.status === "sending" && job.lease_id === claim.lease && job.lease_until > at && current.lease_id === claim.lease && current.lease_until > at
      && current.target_chat_id === claim.job.target_chat_id && credential(db) === claim.cipher && hash(cipher) === claim.job.token_hash
      && !!video && !video.deleted_at && sourceAllowed(db, claim.video, claim.job.target_chat_id) && (claim.job.kind !== "automatic" || current.enabled === 1 && current.revision === claim.job.settings_revision && video.active === 1);
  };
  let dispatched = false;
  let result: Awaited<ReturnType<typeof telegramVideoFileRequest>>;
  try {
    let token = ""; try { token = decryptToken(claim.cipher); } catch { /* safe error below */ }
    if (!token) throw new HotVideoError(TOKEN_ERROR, 400);
    const verified = await verifyTarget(token, claim.job.target_chat_id, allowed);
    if (verified.botId !== claim.job.bot_id) throw new HotVideoError(TARGET_ERROR, 409);
    const filename = claim.video.origin === "channel" ? "" : await verifyVideoFile(claim.video);
    if (!allowed()) throw new HotVideoError(TARGET_ERROR, 409);
    const markDispatch = () => {
      const ready = transaction(db, () => {
        if (!allowed()) return false;
        db.prepare("UPDATE telegram_hot_video_jobs SET dispatch_started_at=? WHERE id=? AND lease_id=?").run(clock(), claim.job.id, claim.lease);
        db.prepare("UPDATE telegram_hot_video_settings SET target_title=?,verified_at=?,last_checked_at=? WHERE id='primary' AND lease_id=?")
          .run(verified.title, clock(), clock(), claim.lease);
        return true;
      });
      if (!ready) throw new HotVideoError(TARGET_ERROR, 409);
      dispatched = true;
    };
    if (claim.video.origin === "channel" || claim.video.bytes > HOT_VIDEO_CLOUD_BYTES) {
      const { sendLargeHotVideo, sendHotChannelVideo } = await import("./telegram-hot-video-native");
      const renew = () => transaction(db, () => {
        if (!allowed()) throw new HotVideoError(TARGET_ERROR, 409);
        const until = clock() + LEASE_MS;
        db.prepare("UPDATE telegram_hot_video_settings SET lease_until=? WHERE id='primary' AND lease_id=?").run(until, claim.lease);
        db.prepare("UPDATE telegram_hot_video_jobs SET lease_until=? WHERE id=? AND lease_id=? AND status='sending'").run(until, claim.job.id, claim.lease);
      });
      result = claim.video.origin === "channel"
        ? await sendHotChannelVideo({db,token,botId:claim.job.bot_id,targetId:claim.job.target_chat_id,sourceChatId:claim.video.source_chat_id,
          sourceMessageId:claim.video.source_message_id,expectedDocumentId:claim.video.source_document_id,jobId:claim.job.id,
          requireSourcePost:config(db).mark_source_used === 1,valid:allowed,renew,onDispatch:markDispatch})
        : await sendLargeHotVideo({ db, token, botId: claim.job.bot_id, targetId: claim.job.target_chat_id,
          filename, bytes: claim.video.bytes, jobId: claim.job.id, valid: allowed, renew, onDispatch: markDispatch });
    } else {
      markDispatch();
      result = await telegramVideoFileRequest(token, { chat_id: claim.job.target_chat_id, supports_streaming: true,
        reply_markup: { inline_keyboard: hotVideoKeyboard() } }, { path: filename, fileName: "hot-video.mp4", bytes: claim.video.bytes }).catch(() => null);
    }
  } catch (error) {
    const safe = error instanceof HotVideoError ? error : new HotVideoError(FILE_ERROR, 409);
    transaction(db, () => {
      const current = config(db), job = db.prepare("SELECT status,lease_id FROM telegram_hot_video_jobs WHERE id=?").get(claim.job.id) as { status: string; lease_id: string } | undefined;
      if (current.lease_id !== claim.lease || job?.status !== "sending" || job.lease_id !== claim.lease) return;
      const retry = !dispatched && [403, 429, 503].includes(safe.status) && claim.job.attempts < MAX_ATTEMPTS;
      db.prepare("UPDATE telegram_hot_video_jobs SET status=?,last_error=?,next_attempt_at=?,lease_id='',lease_until=0 WHERE id=?")
        .run(dispatched ? "unknown" : retry ? "pending" : safe.status === 409 && safe.message === TARGET_ERROR ? "cancelled" : "failed",
          dispatched ? UNKNOWN_ERROR : safe.message, clock() + Math.max(30_000, safe.retryAfter * 1000), claim.job.id);
      db.prepare("UPDATE telegram_hot_video_settings SET last_error=?,lease_id='',lease_until=0,next_send_at=? WHERE id='primary' AND lease_id=?")
        .run(dispatched ? UNKNOWN_ERROR : safe.message, clock() + GAP_MS, claim.lease);
    });
    return;
  }
  transaction(db, () => {
    const at = clock(), current = config(db), job = db.prepare("SELECT status,lease_id,lease_until FROM telegram_hot_video_jobs WHERE id=?").get(claim.job.id) as Pick<Job, "status" | "lease_id" | "lease_until"> | undefined;
    if (current.lease_id !== claim.lease || current.lease_until <= at || job?.status !== "sending" || job.lease_id !== claim.lease || job.lease_until <= at) return;
    const confirmed = result?.ok && positive(result.result.message_id) && record(result.result.chat)?.id === claim.job.target_chat_id ? result.result : null;
    const trusted = confirmed !== null;
    const retry = result && !result.ok && [429, 403].includes(result.code) && claim.job.attempts < MAX_ATTEMPTS;
    const status = trusted ? "sent" : retry ? "pending" : result && !result.ok && [400, 401, 403, 429].includes(result.code) ? "failed" : "unknown";
    const warning = confirmed ? deliverySafe(confirmed, claim.job.target_chat_id) ? "" : "视频已发送，但 Telegram 返回的媒体或按钮与设置不一致；不会重复发送。"
      : status === "unknown" ? UNKNOWN_ERROR : result && !result.ok && result.code === 429 ? "Telegram 正在限制视频发送频率，稍后重试。" : PERMISSION_ERROR;
    const delay = result && !result.ok ? Math.max(GAP_MS, result.retryAfter * 1000, 30_000 * 2 ** (claim.job.attempts - 1)) : GAP_MS;
    db.prepare("UPDATE telegram_hot_video_jobs SET status=?,last_error=?,next_attempt_at=?,lease_id='',lease_until=0,sent_at=?,message_id=? WHERE id=? AND lease_id=?")
      .run(status, warning, at + delay, trusted ? at : 0, confirmed ? confirmed.message_id as number : 0, claim.job.id, claim.lease);
    if (trusted) {
      db.prepare("UPDATE telegram_hot_videos SET last_sent_at=? WHERE id=?").run(at,claim.video.id);
      if (claim.video.origin === "channel") db.prepare("UPDATE telegram_hot_video_jobs SET marker_status=?,marker_next_attempt_at=? WHERE id=?")
        .run(current.mark_source_used === 1 ? "pending" : "skipped",at,claim.job.id);
    }
    db.prepare("UPDATE telegram_hot_video_settings SET last_error=?,lease_id='',lease_until=0,next_send_at=? WHERE id='primary' AND lease_id=?").run(warning, at + GAP_MS, claim.lease);
  });
}
const MARKER_UNKNOWN = "Telegram 未确认来源频道已使用标记，已停止自动重试；视频不会重发。";
export async function deliverHotVideoMarkerOnce(decryptToken: DecryptToken, clock = Date.now) {
  const db = getSqlite();
  const claim = transaction(db, () => {
    const now=clock(),current=config(db),cipher=credential(db);
    db.prepare(`UPDATE telegram_hot_video_jobs SET marker_status=CASE WHEN marker_dispatch_started_at>0 THEN 'unknown' ELSE 'pending' END,
      marker_error=CASE WHEN marker_dispatch_started_at>0 THEN ? ELSE marker_error END,lease_id='',lease_until=0
      WHERE status='sent' AND marker_status='sending' AND lease_until<=?`).run(MARKER_UNKNOWN,now);
    if (current.lease_until>now) return null;
    const job=db.prepare("SELECT * FROM telegram_hot_video_jobs WHERE status='sent' AND marker_status='pending' AND marker_next_attempt_at<=? ORDER BY sent_at,id LIMIT 1").get(now) as Job|undefined;
    if (!job) return null;
    const video=db.prepare("SELECT * FROM telegram_hot_videos WHERE id=?").get(job.video_id) as Video|undefined;
    if (!video || video.deleted_at || video.origin!=="channel" || !sourceAllowed(db,video,job.target_chat_id) || !current.mark_source_used
      || job.target_chat_id!==current.target_chat_id || !positive(job.message_id) || hash(cipher)!==job.token_hash) {
      db.prepare("UPDATE telegram_hot_video_jobs SET marker_status='skipped',marker_error='来源或标记设置已改变，标记已取消；已发送的视频保持已使用。' WHERE id=?").run(job.id); return null;
    }
    const lease=randomUUID();
    db.prepare("UPDATE telegram_hot_video_settings SET lease_id=?,lease_until=? WHERE id='primary'").run(lease,now+LEASE_MS);
    db.prepare("UPDATE telegram_hot_video_jobs SET marker_status='sending',marker_attempts=marker_attempts+1,marker_dispatch_started_at=0,lease_id=?,lease_until=? WHERE id=?")
      .run(lease,now+LEASE_MS,job.id);
    return {job:{...job,marker_attempts:job.marker_attempts+1},video,cipher,lease};
  });
  if (!claim) return;
  const allowed=()=>{
    const current=config(db),now=clock(),job=db.prepare("SELECT * FROM telegram_hot_video_jobs WHERE id=?").get(claim.job.id) as Job|undefined;
    const video=db.prepare("SELECT * FROM telegram_hot_videos WHERE id=?").get(claim.video.id) as Video|undefined;
    return current.mark_source_used===1 && current.target_chat_id===claim.job.target_chat_id && current.lease_id===claim.lease && current.lease_until>now
      && credential(db)===claim.cipher && job?.status==='sent' && job.marker_status==='sending' && job.lease_id===claim.lease && job.lease_until>now
      && !!video && !video.deleted_at && video.last_sent_at>0 && sourceAllowed(db,video,claim.job.target_chat_id)
      && video.source_document_id===claim.video.source_document_id && job.message_id===claim.job.message_id;
  };
  const renew=()=>transaction(db,()=>{
    if (!allowed()) throw new HotVideoError(TARGET_ERROR,409);
    const until=clock()+LEASE_MS;
    db.prepare("UPDATE telegram_hot_video_settings SET lease_until=? WHERE id='primary' AND lease_id=?").run(until,claim.lease);
    db.prepare("UPDATE telegram_hot_video_jobs SET lease_until=? WHERE id=? AND lease_id=?").run(until,claim.job.id,claim.lease);
  });
  let dispatched=false, result:Awaited<ReturnType<typeof telegramVideoFileRequest>>=null;
  let failure:HotVideoError|undefined;
  try {
    let token="";try{token=decryptToken(claim.cipher);}catch{/* Fixed private error below. */}
    if (!token) throw new HotVideoError(TOKEN_ERROR,400);
    const {markHotChannelVideoUsed}=await import("./telegram-hot-video-native");
    result=await markHotChannelVideoUsed({db,token,botId:claim.job.bot_id,targetId:claim.job.target_chat_id,
      sourceChatId:claim.video.source_chat_id,sourceMessageId:claim.video.source_message_id,expectedDocumentId:claim.video.source_document_id,
      targetMessageId:claim.job.message_id,markerId:claim.job.id,valid:allowed,renew,onDispatch:()=>{
        transaction(db,()=>{if(!allowed())throw new HotVideoError(TARGET_ERROR,409);
          db.prepare("UPDATE telegram_hot_video_jobs SET marker_dispatch_started_at=? WHERE id=? AND lease_id=?").run(clock(),claim.job.id,claim.lease);});
        dispatched=true;
      }});
  } catch(error){failure=error instanceof HotVideoError?error:new HotVideoError("来源标记暂时无法发送，视频保持已发送。",503);}
  transaction(db,()=>{
    const current=config(db),job=db.prepare("SELECT * FROM telegram_hot_video_jobs WHERE id=?").get(claim.job.id) as Job|undefined;
    if(current.lease_id!==claim.lease || job?.lease_id!==claim.lease || job.status!=='sent' || job.marker_status!=='sending')return;
    const at=clock();
    // Even a late result cannot rearm a potentially submitted marker.
    const expired=current.lease_until<=at || job.lease_until<=at;
    const confirmed=!expired && dispatched && result?.ok && positive(result.result.message_id) && record(result.result.chat)?.id===claim.video.source_chat_id
      && result.result.text==='✅ Sent · Used' && record(result.result.reply_to_message)?.message_id===claim.video.source_message_id ? result.result:null;
    const rejected=result && !result.ok?result:null;
    const retry=!expired && !confirmed && claim.job.marker_attempts<MAX_ATTEMPTS
      && (!dispatched && !!failure && [403,429,503].includes(failure.status) || !!rejected && [403,429].includes(rejected.code));
    const unknown=!confirmed && dispatched && (!rejected || ![400,401,403,429].includes(rejected.code));
    const status=confirmed?'sent':unknown?'unknown':retry?'pending':!dispatched && failure?.status===409?'skipped':'failed';
    const warning=confirmed?'':unknown?MARKER_UNKNOWN:failure?.message || '来源频道标记未完成，请检查 ChatBot 的发布权限；视频不会重发。';
    db.prepare("UPDATE telegram_hot_video_jobs SET marker_status=?,marker_error=?,marker_next_attempt_at=?,marker_message_id=?,lease_id='',lease_until=0 WHERE id=? AND lease_id=?")
      .run(status,warning,at+Math.max(30000,(rejected?.retryAfter || failure?.retryAfter || 0)*1000),confirmed?confirmed.message_id as number:0,claim.job.id,claim.lease);
    db.prepare("UPDATE telegram_hot_video_settings SET lease_id='',lease_until=0 WHERE id='primary' AND lease_id=?").run(claim.lease);
  });
}
const workers = globalThis as typeof globalThis & { telegramHotVideoWorkerStarted?: boolean };
export function startTelegramHotVideoWorker(decryptToken: DecryptToken) {
  if (workers.telegramHotVideoWorkerStarted) return;
  workers.telegramHotVideoWorkerStarted=true;
  const owner=randomUUID(),db=getSqlite();
  db.prepare(`INSERT INTO telegram_hot_video_runtime(id,owner_id) VALUES('primary',?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,
    phase='starting',scan_phase='idle',last_error=''`).run(owner);
  let running=false,scanning=false,cleanedAt=0,lastHeartbeat=0,lastScanTick=0,scanAudited=false;
  const tick=async()=>{
    const at=Date.now();
    if(at-lastHeartbeat>=5000){lastHeartbeat=at;db.prepare("UPDATE telegram_hot_video_runtime SET heartbeat_at=? WHERE id='primary' AND owner_id=?").run(at,owner);}
    if(running)return;
    running=true;
    try{
      db.prepare("UPDATE telegram_hot_video_runtime SET last_tick_at=?,phase='checking' WHERE id='primary' AND owner_id=?").run(at,owner);
      if(at-cleanedAt>UPLOAD_MS){cleanupStorage(db,at);cleanedAt=at;}
      await deliverHotVideoOnce(decryptToken);
      await deliverHotVideoMarkerOnce(decryptToken);
      db.prepare("UPDATE telegram_hot_video_runtime SET last_completed_at=?,phase='idle',last_error='' WHERE id='primary' AND owner_id=?").run(Date.now(),owner);
    }catch{
      db.prepare("UPDATE telegram_hot_video_runtime SET last_completed_at=?,phase='error',last_error='发送服务暂时未完成检查，将自动继续。' WHERE id='primary' AND owner_id=?").run(Date.now(),owner);
    }finally{running=false;}
  };
  const scanTick=async()=>{
    const at=Date.now();
    db.prepare("UPDATE telegram_hot_video_runtime SET scan_heartbeat_at=? WHERE id='primary' AND owner_id=?").run(at,owner);
    if(scanning || at-lastScanTick<5000 || !db.prepare("SELECT 1 FROM telegram_hot_video_sources WHERE selected=1 AND next_attempt_at<=? LIMIT 1").get(at))return;
    scanning=true;lastScanTick=at;
    try{
      db.prepare("UPDATE telegram_hot_video_runtime SET scan_started_at=?,scan_phase='running' WHERE id='primary' AND owner_id=?").run(at,owner);
      const {syncHotVideoSources}=await import("./telegram-hot-video-sources");
      const result=await syncHotVideoSources(db);
      db.prepare("UPDATE telegram_hot_video_runtime SET last_scan_at=?,scan_phase='idle' WHERE id='primary' AND owner_id=?").run(Date.now(),owner);
      if(!scanAudited || result.discovered>0){
        scanAudited=true;
        const current=config(db),status=schedulerStatus(db,current,Date.now(),hash(credential(db)));
        console.info("Telegram Hot scheduler status.",JSON.stringify({enabled:current.enabled===1,sourceCount:status.sourceCount,
          eligibleCount:status.eligibleCount,queuedCount:status.queuedCount,workerHealthy:status.workerHealthy,heartbeatAt:status.heartbeatAt,
          nextRunAt:status.nextRunAt,scanPhase:status.scanPhase}));
      }
    }catch{
      db.prepare("UPDATE telegram_hot_video_runtime SET last_scan_at=?,scan_phase='error' WHERE id='primary' AND owner_id=?").run(Date.now(),owner);
    }finally{scanning=false;}
  };
  void tick().catch(()=>undefined);void scanTick().catch(()=>undefined);
  setInterval(()=>void tick().catch(()=>undefined),TICK_MS).unref();
  setInterval(()=>void scanTick().catch(()=>undefined),TICK_MS).unref();
  console.info("Telegram Hot scheduler started.",JSON.stringify({schemaVersion:33,sourceCount:(db.prepare("SELECT COUNT(*) AS n FROM telegram_hot_video_sources WHERE selected=1").get() as {n:number}).n,
    enabled:config(db).enabled===1,intervalHours:config(db).interval_hours,nextRunAt:config(db).next_run_at,independentSourceWorker:true}));
}
