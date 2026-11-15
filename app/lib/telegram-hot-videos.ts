import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, mkdirSync, readdirSync, statfsSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getDataDirectory, getSqlite } from "./sqlite";
import { telegramRequest, telegramVideoFileRequest } from "./telegram-bot";

type DecryptToken = (ciphertext: string) => string;
type Config = { enabled: number; target_chat_id: number; target_title: string; interval_hours: number; next_run_at: number;
  revision: string; token_hash: string; bot_id: number; verified_at: number; last_checked_at: number; last_error: string;
  last_auto_order: number; lease_id: string; lease_until: number; next_send_at: number };
type Video = { id: string; title: string; original_name: string; file_name: string; bytes: number; sha256: string;
  active: number; sort_order: number; created_at: number; last_sent_at: number; deleted_at: number };
type Job = { id: string; request_id: string; video_id: string; kind: "manual" | "scheduled" | "automatic"; status: string;
  run_at: number; created_at: number; settings_revision: string; target_chat_id: number; token_hash: string; bot_id: number;
  attempts: number; next_attempt_at: number; lease_id: string; lease_until: number; dispatch_started_at: number;
  last_error: string; sent_at: number; message_id: number };
export type HotVideoSettingsInput = { enabled: boolean; targetChatId: string; intervalHours: number; firstRunAt: number | null; revision?: string };
export type HotVideoRegistration = { id: string; title: string; originalName: string; fileName: string; bytes: number; sha256: string };
export const HOT_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
export const HOT_VIDEO_STORAGE_BYTES = 300 * 1024 * 1024;
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
  const saved = db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM telegram_hot_videos WHERE deleted_at=0").get() as { n: number };
  const reserved = db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM telegram_hot_video_uploads WHERE created_at>?").get(now - UPLOAD_MS) as { n: number };
  return saved.n + reserved.n;
}
export function reserveHotVideoUpload(db: DatabaseSync, input: { id: string; bytes: number }, clock = Date.now, onReserved?: (now: number) => void) {
  if (!UUID.test(input.id) || !positive(input.bytes) || input.bytes > HOT_VIDEO_MAX_BYTES) throw new HotVideoError("请上传不超过 50 MiB 的 MP4 视频。", 413);
  transaction(db, () => {
    const now = clock();
    db.prepare("DELETE FROM telegram_hot_video_uploads WHERE created_at<=?").run(now - UPLOAD_MS);
    if (db.prepare("SELECT 1 FROM telegram_hot_videos WHERE id=?").get(input.id) || db.prepare("SELECT 1 FROM telegram_hot_video_uploads WHERE id=?").get(input.id))
      throw new HotVideoError("上传编号已使用，请重新选择视频。", 409);
    if (Number((db.prepare("SELECT COUNT(*) AS n FROM telegram_hot_video_uploads").get() as { n: number }).n) >= 2) throw new HotVideoError("已有两个视频正在上传，请稍后再试。", 429);
    if (Number((db.prepare("SELECT COUNT(*) AS n FROM telegram_hot_videos WHERE deleted_at=0").get() as { n: number }).n) >= 100
      || storageBytes(db, now) + input.bytes > HOT_VIDEO_STORAGE_BYTES) throw new HotVideoError("视频空间已满，请先删除不再需要的视频。", 413);
    const available = statfsSync(hotVideoStorageDirectory());
    const reservations = Number((db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM telegram_hot_video_uploads").get() as { n: number }).n);
    if (available.bavail * available.bsize < reservations + input.bytes + 64 * 1024 * 1024) throw new HotVideoError("服务器视频空间不足，请先删除部分视频。", 413);
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
  const videos = db.prepare("SELECT * FROM telegram_hot_videos WHERE deleted_at=0 ORDER BY sort_order,id").all() as Video[];
  const jobs = db.prepare(`SELECT j.*,v.title FROM telegram_hot_video_jobs j JOIN telegram_hot_videos v ON v.id=j.video_id
    ORDER BY j.created_at DESC,j.id DESC LIMIT 100`).all() as (Job & { title: string })[];
  const counts = { pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0, cancelled: 0 };
  for (const row of db.prepare("SELECT status,COUNT(*) AS n FROM telegram_hot_video_jobs GROUP BY status").all() as { status: string; n: number }[])
    if (row.status in counts) counts[row.status as keyof typeof counts] = row.n;
  const unresolved = db.prepare(`SELECT last_error FROM telegram_hot_video_jobs WHERE target_chat_id=? AND token_hash=?
    AND status IN ('failed','unknown') AND last_error<>'' ORDER BY created_at DESC,id DESC LIMIT 1`).get(value.target_chat_id, value.token_hash) as { last_error: string } | undefined;
  const candidates = db.prepare("SELECT chat_id,title FROM telegram_join_gate_candidates WHERE token_hash=? ORDER BY verified_at DESC LIMIT 30").all(tokenHash) as { chat_id: number; title: string }[];
  const target = value.target_chat_id || defaultTarget(db);
  return { enabled: value.enabled === 1, targetChatId: target ? String(target) : "", targetTitle: value.target_title || "🔞365 Free Bonus Hot",
    intervalHours: value.interval_hours, nextRunAt: value.enabled && value.next_run_at ? value.next_run_at : null, revision: value.revision,
    ready: value.target_chat_id < 0 && value.verified_at > 0 && value.token_hash === tokenHash && !!cipher && !value.last_error,
    lastError: value.token_hash && value.token_hash !== tokenHash ? TOKEN_ERROR : value.last_error || unresolved?.last_error || "", lastCheckedAt: value.last_checked_at || null,
    storage: { bytes: storageBytes(db, now), maxBytes: HOT_VIDEO_STORAGE_BYTES, maxVideoBytes: HOT_VIDEO_MAX_BYTES },
    videos: videos.map(v => ({ id: v.id, title: v.title, originalName: v.original_name, bytes: v.bytes, active: v.active === 1, createdAt: v.created_at, lastSentAt: v.last_sent_at || null })),
    jobs: jobs.map(j => ({ id: j.id, videoId: j.video_id, title: j.title, kind: j.kind, runAt: j.run_at, status: j.status,
      attempts: j.attempts, lastError: j.last_error, sentAt: j.sent_at || null, messageId: j.message_id || null })), counts,
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
  let checked: { botId: number; title: string } | undefined;
  // Stopping automation must remain possible with revoked credentials or an
  // unreachable Telegram service. A disabled draft never grants send authority.
  if (target && input.enabled) {
    let token = ""; try { token = decryptToken(cipher); } catch { /* credentials stay private */ }
    if (!cipher || !token) throw new HotVideoError(TOKEN_ERROR);
    checked = await verifyTarget(token, target, () => credential(db) === cipher && config(db).revision === previous.revision && config(db).lease_until <= clock());
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
    try { unlinkSync(videoPath(video)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new HotVideoError("暂时无法删除视频文件，请稍后重试。", 503); }
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
  if (!db.prepare("SELECT 1 FROM telegram_hot_videos WHERE id=? AND deleted_at=0").get(input.videoId)) throw new HotVideoError("视频已删除，请刷新。", 404);
  const verified = await verifyTarget(token, target, () => config(db).revision === previous.revision && credential(db) === cipher);
  transaction(db, () => {
    const latest = config(db);
    if (latest.revision !== previous.revision || credential(db) !== cipher) throw new HotVideoError(TARGET_ERROR, 409);
    if (!db.prepare("SELECT 1 FROM telegram_hot_videos WHERE id=? AND deleted_at=0").get(input.videoId)) throw new HotVideoError("视频已删除，请刷新。", 404);
    if (Number((db.prepare("SELECT COUNT(*) AS n FROM telegram_hot_video_jobs WHERE status IN ('pending','sending')").get() as { n: number }).n) >= 500) throw new HotVideoError("待发送任务已满，请先处理现有任务。", 429);
    db.prepare(`UPDATE telegram_hot_video_settings SET target_chat_id=?,target_title=?,token_hash=?,bot_id=?,verified_at=?,last_checked_at=?,last_error='',
      revision=CASE WHEN revision='' THEN ? ELSE revision END WHERE id='primary'`).run(target, verified.title, hash(cipher), verified.botId, clock(), clock(), randomUUID());
    cancelObsolete(db, config(db), hash(cipher));
    db.prepare(`INSERT OR IGNORE INTO telegram_hot_video_jobs(id,request_id,video_id,kind,run_at,created_at,settings_revision,target_chat_id,token_hash,bot_id,next_attempt_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), input.requestId, input.videoId, input.runAt === null ? "manual" : "scheduled", input.runAt ?? now,
        now, config(db).revision, target, hash(cipher), verified.botId, input.runAt ?? now);
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
      const video = db.prepare(`SELECT * FROM telegram_hot_videos WHERE deleted_at=0 AND active=1
        ORDER BY CASE WHEN sort_order>? THEN 0 ELSE 1 END,sort_order,id LIMIT 1`).get(current.last_auto_order) as Video | undefined;
      const room = Number((db.prepare("SELECT COUNT(*) AS n FROM telegram_hot_video_jobs WHERE status IN ('pending','sending')").get() as { n: number }).n) < 500;
      if (video && room && cipher && current.target_chat_id < 0 && current.token_hash === tokenHash) {
        db.prepare(`INSERT OR IGNORE INTO telegram_hot_video_jobs(id,request_id,video_id,kind,run_at,created_at,settings_revision,target_chat_id,token_hash,bot_id,next_attempt_at)
          VALUES(?,?,?,'automatic',?,?,?,?,?,?,?)`).run(randomUUID(), `auto:${current.revision}:${slot}`, video.id, slot, now, current.revision,
            current.target_chat_id, tokenHash, current.bot_id, now);
        db.prepare("UPDATE telegram_hot_video_settings SET last_auto_order=? WHERE id='primary'").run(video.sort_order);
      }
      db.prepare(`UPDATE telegram_hot_video_settings SET next_run_at=?,last_error=CASE
        WHEN ?=0 THEN '没有已启用的视频，本次时段已跳过。' WHEN ?=0 THEN '待发送任务已满，本次自动时段已跳过。' ELSE last_error END WHERE id='primary'`)
        .run(slot + interval, Number(!!video), Number(room));
    }
    const job = db.prepare("SELECT * FROM telegram_hot_video_jobs WHERE status='pending' AND run_at<=? AND next_attempt_at<=? ORDER BY run_at,created_at,id LIMIT 1").get(now, now) as Job | undefined;
    if (!job) return null;
    const video = db.prepare("SELECT * FROM telegram_hot_videos WHERE id=? AND deleted_at=0").get(job.video_id) as Video | undefined;
    if (!video || job.kind === "automatic" && !video.active) {
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
      && !!video && !video.deleted_at && (claim.job.kind !== "automatic" || current.enabled === 1 && current.revision === claim.job.settings_revision && video.active === 1);
  };
  let dispatched = false;
  let result: Awaited<ReturnType<typeof telegramVideoFileRequest>>;
  try {
    let token = ""; try { token = decryptToken(claim.cipher); } catch { /* safe error below */ }
    if (!token) throw new HotVideoError(TOKEN_ERROR, 400);
    const verified = await verifyTarget(token, claim.job.target_chat_id, allowed);
    if (verified.botId !== claim.job.bot_id) throw new HotVideoError(TARGET_ERROR, 409);
    const filename = await verifyVideoFile(claim.video);
    if (!allowed()) throw new HotVideoError(TARGET_ERROR, 409);
    const ready = transaction(db, () => {
      if (!allowed()) return false;
      db.prepare("UPDATE telegram_hot_video_jobs SET dispatch_started_at=? WHERE id=? AND lease_id=?").run(clock(), claim.job.id, claim.lease);
      db.prepare("UPDATE telegram_hot_video_settings SET target_title=?,verified_at=?,last_checked_at=? WHERE id='primary' AND lease_id=?")
        .run(verified.title, clock(), clock(), claim.lease);
      return true;
    });
    if (!ready) throw new HotVideoError(TARGET_ERROR, 409);
    dispatched = true;
    result = await telegramVideoFileRequest(token, { chat_id: claim.job.target_chat_id, supports_streaming: true,
      reply_markup: { inline_keyboard: hotVideoKeyboard() } }, { path: filename, fileName: "hot-video.mp4", bytes: claim.video.bytes }).catch(() => null);
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
    if (trusted) db.prepare("UPDATE telegram_hot_videos SET last_sent_at=? WHERE id=?").run(at, claim.video.id);
    db.prepare("UPDATE telegram_hot_video_settings SET last_error=?,lease_id='',lease_until=0,next_send_at=? WHERE id='primary' AND lease_id=?").run(warning, at + GAP_MS, claim.lease);
  });
}
const workers = globalThis as typeof globalThis & { telegramHotVideoWorkerStarted?: boolean };
export function startTelegramHotVideoWorker(decryptToken: DecryptToken) {
  if (workers.telegramHotVideoWorkerStarted) return;
  workers.telegramHotVideoWorkerStarted = true;
  let running = false, cleanedAt = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (Date.now() - cleanedAt > UPLOAD_MS) { cleanupStorage(getSqlite(), Date.now()); cleanedAt = Date.now(); }
      await deliverHotVideoOnce(decryptToken);
    } catch { /* No credentials, file paths or channel details enter process logs. */ }
    finally { running = false; }
  };
  void tick(); setInterval(() => void tick(), TICK_MS).unref();
}
