import { createHash } from "node:crypto";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import sharp, { type OverlayOptions } from "sharp";
import { GAME_TIPS_DEFAULT_SLOTS, GAME_TIPS_NAME_LIMIT, GAME_TIPS_PROVIDER_LIMIT, GAME_TIPS_UPLOAD_LIMIT,
  gameTipsProviderKey, validGameTipsBackgroundSlots,
  type GameTipsAsset, type GameTipsBackgroundSlot, type GameTipsLibrary, type GameTipsProvider, type GameTipsSelection } from "./telegram-game-tips-types";

export { gameTipsProviderKey } from "./telegram-game-tips-types";

const initialized = new WeakSet<DatabaseSync>();
const uploadIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const maxLibraryImageMiB = 128;
const maxLibraryImageBytes = maxLibraryImageMiB * 1024 * 1024;
const minimumFreeDiskBytes = 64 * 1024 * 1024;
const sqliteFull = 13;
const maxPixels = 24_000_000;
const maxStoredBytes = 256 * 1024;
const maxLogoBytes = 96 * 1024;
const maxProviderLogos = 100;
const maxLogoRevisions = 200;
const maxBackgroundBytes = 512 * 1024;
const maxProviderBackgrounds = 60;
const maxBackgroundRevisions = 80;
const allowedFormats: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const assetFields = "id, provider, game, enabled, created_at AS createdAt, updated_at AS updatedAt";
type AssetRow = Omit<GameTipsAsset, "enabled"> & { enabled: number };
type Names = { provider: string; game: string; providerKey: string; gameKey: string };
type UploadRecord = { upload_hash: string; deleted_at: number };

export class GameTipsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function ensureGameTipsAssets(db: DatabaseSync) {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_game_tips_assets (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_key TEXT NOT NULL,
    game TEXT NOT NULL,
    game_key TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    image BLOB NOT NULL,
    upload_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS telegram_game_tips_unique_live_game
  ON telegram_game_tips_assets(provider_key, game_key) WHERE enabled = 1;
  CREATE INDEX IF NOT EXISTS telegram_game_tips_image_bytes
  ON telegram_game_tips_assets(length(image)) WHERE length(image) > 0;
  CREATE INDEX IF NOT EXISTS telegram_game_tips_deleted_pending_cleanup
  ON telegram_game_tips_assets(id) WHERE deleted_at <> 0 AND length(image) > 0;
  CREATE TABLE IF NOT EXISTS telegram_game_tips_logos (
    id TEXT PRIMARY KEY,
    provider_key TEXT NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    image BLOB NOT NULL,
    upload_hash TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS telegram_game_tips_current_logo
  ON telegram_game_tips_logos(provider_key) WHERE active = 1;
  CREATE TABLE IF NOT EXISTS telegram_game_tips_backgrounds (
    id TEXT PRIMARY KEY,
    provider_key TEXT NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    image BLOB NOT NULL,
    slots_json TEXT NOT NULL,
    upload_hash TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS telegram_game_tips_current_background
  ON telegram_game_tips_backgrounds(provider_key) WHERE active = 1;`);
  if (!db.isTransaction) initialized.add(db);
}

function nameLabel(input: string, max: number, field: string): string {
  const value = input.normalize("NFC").trim().replace(/ +/gu, " ");
  if (!value || Array.from(value).length > max || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)) {
    throw new GameTipsError(`请填写 1 至 ${max} 个字的${field}，并保持为单行。`);
  }
  return value;
}

function namesOf(rawProvider: string, rawGame: string): Names {
  const provider = nameLabel(rawProvider, GAME_TIPS_PROVIDER_LIMIT, "平台名称");
  const game = nameLabel(rawGame, GAME_TIPS_NAME_LIMIT, "游戏名称");
  return { provider, game, providerKey: gameTipsProviderKey(provider), gameKey: gameTipsProviderKey(game) };
}

function asAsset(row: AssetRow): GameTipsAsset {
  return { ...row, enabled: row.enabled === 1 };
}

export function listGameTipAssets(db: DatabaseSync, provider?: string): GameTipsAsset[] {
  ensureGameTipsAssets(db);
  const filtered = provider !== undefined;
  const rows = db.prepare(`SELECT ${assetFields} FROM telegram_game_tips_assets WHERE enabled = 1 AND deleted_at = 0
    ${filtered ? "AND provider_key = ?" : ""} ORDER BY provider_key, game_key, id`)
    .all(...(filtered ? [gameTipsProviderKey(provider)] : [])) as AssetRow[];
  return rows.map(asAsset);
}

export function gameTipsProviders(db: DatabaseSync): GameTipsProvider[] {
  ensureGameTipsAssets(db);
  const rows = db.prepare(`WITH game_providers AS (
      SELECT provider_key, MIN(provider) AS name, COUNT(*) AS count FROM telegram_game_tips_assets
      WHERE enabled = 1 AND deleted_at = 0 GROUP BY provider_key
    ), current_logos AS (
      SELECT provider_key, id, name FROM telegram_game_tips_logos WHERE active = 1
    ), current_backgrounds AS (
      SELECT provider_key, id, name, slots_json FROM telegram_game_tips_backgrounds WHERE active = 1
    ), providers AS (
      SELECT provider_key FROM game_providers UNION SELECT provider_key FROM current_logos UNION SELECT provider_key FROM current_backgrounds
    )
    SELECT COALESCE(l.name, b.name, g.name) AS name, COALESCE(g.count, 0) AS count, l.id AS logoId,
      b.id AS backgroundId, b.slots_json AS slotsJson
    FROM providers p LEFT JOIN game_providers g USING(provider_key) LEFT JOIN current_logos l USING(provider_key)
      LEFT JOIN current_backgrounds b USING(provider_key) ORDER BY p.provider_key`).all() as Array<{
    name: string; count: number; logoId: string | null; backgroundId: string | null; slotsJson: string | null;
  }>;
  return rows.map(({ name, count, logoId, backgroundId, slotsJson }) => ({
    name, count, ...(logoId ? { logoId } : {}), ...(backgroundId && slotsJson ? { backgroundId, backgroundSlots: parseSlots(slotsJson) } : {}),
  }));
}

export function gameTipsProviderLogo(db: DatabaseSync, provider: string): { name: string; logoId: string } | undefined {
  ensureGameTipsAssets(db);
  const row = db.prepare("SELECT name, id AS logoId FROM telegram_game_tips_logos WHERE provider_key = ? AND active = 1")
    .get(gameTipsProviderKey(provider)) as { name: string; logoId: string } | undefined;
  return row && { ...row };
}

export function gameTipsLibrary(db: DatabaseSync): GameTipsLibrary {
  ensureGameTipsAssets(db);
  const assets = (db.prepare(`SELECT ${assetFields} FROM telegram_game_tips_assets WHERE deleted_at = 0
    ORDER BY enabled DESC, provider_key, game_key, created_at DESC`).all() as AssetRow[]).map(asAsset);
  return { assets, providers: gameTipsProviders(db) };
}

function invalidImage() { return new GameTipsError("请选择可识别的 JPG、PNG 或 WebP 静态图片。", 415); }

function uploadContentType(request: Request): string {
  const declared = (request.headers.get("content-type") || "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
  if (declared !== "application/octet-stream" && !Object.values(allowedFormats).includes(declared)) throw invalidImage();
  return declared;
}

async function readUpload(request: Request): Promise<Buffer> {
  const tooLarge = () => new GameTipsError("每张图片最多 4 MB。", 413);
  if (Number(request.headers.get("content-length")) > GAME_TIPS_UPLOAD_LIMIT) {
    await request.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!request.body) throw invalidImage();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > GAME_TIPS_UPLOAD_LIMIT) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw invalidImage();
  return Buffer.concat(chunks, size);
}

async function decodeImage(bytes: Buffer, declared: string) {
  const signature = bytes.subarray(0, 12);
  const detected = signature.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? "jpeg"
    : signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
    : signature.toString("ascii", 0, 4) === "RIFF" && signature.toString("ascii", 8, 12) === "WEBP" ? "webp" : null;
  if (!detected || declared !== "application/octet-stream" && declared !== allowedFormats[detected]) throw invalidImage();
  const input = sharp(bytes, { limitInputPixels: maxPixels, sequentialRead: true, failOn: "warning" });
  const { format, width, height, pages } = await input.metadata();
  if (format !== detected || (pages ?? 1) !== 1 || width < 32 || height < 32 || width * height > maxPixels) throw invalidImage();
  return input.timeout({ seconds: 4 }).autoOrient();
}

async function normalizeImage(bytes: Buffer, declared: string): Promise<Buffer> {
  try {
    const input = await decodeImage(bytes, declared);
    const decoded = await input.resize({ width: 640, height: 440, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#0b1637" }).jpeg({ quality: 88 }).toBuffer();
    if (decoded.length <= maxStoredBytes) return decoded;
    return await sharp(decoded).jpeg({ quality: 68 }).toBuffer();
  } catch { throw invalidImage(); }
}

function uploadMatches(db: DatabaseSync, id: string, proposed: string) {
  const existing = db.prepare("SELECT upload_hash, deleted_at FROM telegram_game_tips_assets WHERE id = ?").get(id) as UploadRecord | undefined;
  if (!existing) return false;
  if (existing.upload_hash !== proposed || existing.deleted_at !== 0) {
    throw new GameTipsError("这个上传编号已使用，请重新选择图片再试。", 409);
  }
  return true;
}

function ensureDistinctGame(db: DatabaseSync, names: Names, id: string) {
  if (db.prepare(`SELECT 1 FROM telegram_game_tips_assets
    WHERE provider_key = ? AND game_key = ? AND enabled = 1 AND id <> ?`).get(names.providerKey, names.gameKey, id)) {
    throw new GameTipsError("该平台已有同名游戏图片。请先停用旧图，或改为其他游戏名称。", 409);
  }
}

function gameTipsDiskFull() {
  return new GameTipsError("服务器剩余储存空间不足，暂时无法上传 Game Tips 图片。", 507);
}

function ensureAssetUploadSpace(db: DatabaseSync, imageBytes: number) {
  const { bytes } = db.prepare(`SELECT COALESCE(SUM(length(image)), 0) AS bytes
    FROM telegram_game_tips_assets WHERE length(image) > 0`).get() as { bytes: number };
  if (bytes + imageBytes > maxLibraryImageBytes) {
    throw new GameTipsError(`Game Tips 图库已达 ${maxLibraryImageMiB} MiB 容量上限，请先删除不再使用的图片。`, 507);
  }

  const databasePath = db.location();
  if (databasePath) {
    const disk = statfsSync(dirname(databasePath), { bigint: true });
    // Leave room for both the new SQLite pages and their write-ahead log entries.
    if (disk.bavail * disk.bsize < BigInt(minimumFreeDiskBytes + 3 * imageBytes)) throw gameTipsDiskFull();
  }
}

export async function uploadGameTipsAsset(db: DatabaseSync, request: Request, clock = Date.now): Promise<GameTipsLibrary> {
  ensureGameTipsAssets(db);
  const params = new URL(request.url).searchParams;
  const id = params.get("id") ?? "";
  if (!uploadIdPattern.test(id)) throw new GameTipsError("上传编号不正确，请重新选择图片。");
  const names = namesOf(params.get("provider") ?? "", params.get("game") ?? "");
  const declared = uploadContentType(request);
  const bytes = await readUpload(request);
  const hash = createHash("sha256").update(JSON.stringify([names.provider, names.game])).update(bytes).digest("hex");
  if (uploadMatches(db, id, hash)) return gameTipsLibrary(db);
  const image = await normalizeImage(bytes, declared);
  if (image.length > maxStoredBytes) throw new GameTipsError("这张图片无法压缩到允许大小，请换一张较小的图片。", 413);

  db.exec("BEGIN IMMEDIATE");
  try {
    if (!uploadMatches(db, id, hash)) {
      ensureDistinctGame(db, names, id);
      releaseDeletedGameTipsAssets(db);
      ensureAssetUploadSpace(db, image.length);
      const now = clock();
      db.prepare(`INSERT INTO telegram_game_tips_assets
        (id, provider, provider_key, game, game_key, enabled, image, upload_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(id, names.provider, names.providerKey, names.game, names.gameKey, image, hash, now, now);
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    if ((error as { errcode?: number }).errcode === sqliteFull) throw gameTipsDiskFull();
    throw error;
  }
  return gameTipsLibrary(db);
}

export function updateGameTipsAsset(db: DatabaseSync, input: Pick<GameTipsAsset, "id" | "provider" | "game" | "enabled" | "updatedAt">, clock = Date.now): GameTipsLibrary {
  ensureGameTipsAssets(db);
  if (!uploadIdPattern.test(input.id)) throw new GameTipsError("图片编号不正确。");
  const names = namesOf(input.provider, input.game);
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = currentAsset(db, input.id, input.updatedAt);
    if (input.enabled) ensureDistinctGame(db, names, input.id);
    const updatedAt = Math.max(clock(), row.updatedAt + 1);
    db.prepare(`UPDATE telegram_game_tips_assets SET provider = ?, provider_key = ?, game = ?, game_key = ?, enabled = ?, updated_at = ?
      WHERE id = ?`).run(names.provider, names.providerKey, names.game, names.gameKey, Number(input.enabled), updatedAt, input.id);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return gameTipsLibrary(db);
}

function currentAsset(db: DatabaseSync, id: string, updatedAt: number): AssetRow {
  const row = db.prepare(`SELECT ${assetFields} FROM telegram_game_tips_assets WHERE id = ? AND deleted_at = 0`).get(id) as AssetRow | undefined;
  if (!row) throw new GameTipsError("找不到这张图片。", 404);
  if (row.updatedAt !== updatedAt) throw new GameTipsError("图片资料已更新，请刷新图库后再操作。", 409);
  return row;
}

export function deleteGameTipsAsset(db: DatabaseSync, input: Pick<GameTipsAsset, "id" | "updatedAt">, clock = Date.now): GameTipsLibrary {
  ensureGameTipsAssets(db);
  if (!uploadIdPattern.test(input.id)) throw new GameTipsError("图片编号不正确。");
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT updated_at, deleted_at FROM telegram_game_tips_assets WHERE id = ?").get(input.id) as
      { updated_at: number; deleted_at: number } | undefined;
    if (!row) throw new GameTipsError("找不到这张图片。", 404);
    if (row.updated_at !== input.updatedAt) throw new GameTipsError("图片资料已更新，请刷新图库后再操作。", 409);
    if (row.deleted_at === 0) {
      // Keep the edit revision on the tombstone so an accepted delete can be replayed safely.
      db.prepare("UPDATE telegram_game_tips_assets SET enabled = 0, deleted_at = ? WHERE id = ?")
        .run(Math.max(clock(), row.updated_at + 1), input.id);
    }
    releaseDeletedGameTipsAssets(db);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return gameTipsLibrary(db);
}

export function releaseDeletedGameTipsAssets(db: DatabaseSync): void {
  if (!initialized.has(db) && !db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'telegram_game_tips_assets'").get()) return;
  if (!db.prepare("SELECT 1 FROM telegram_game_tips_assets WHERE deleted_at <> 0 AND length(image) > 0 LIMIT 1").get()) return;
  const hasSlots = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'telegram_game_tip_slots'").get();
  db.exec(`UPDATE telegram_game_tips_assets AS asset SET image = X''
    WHERE deleted_at <> 0 AND length(image) > 0 ${hasSlots ? `AND NOT EXISTS (
      SELECT 1 FROM telegram_game_tip_slots s
      JOIN telegram_scheduled_message_deliveries d
        ON d.plan_id = s.plan_id AND d.plan_revision = s.plan_revision AND d.run_at = s.run_at
      JOIN json_each(CASE WHEN json_valid(s.selection_json) THEN s.selection_json ELSE '{}' END, '$.games') game
      WHERE d.status IN ('pending', 'sending')
        AND CASE WHEN game.type = 'object' THEN game.value ->> '$.id' END = asset.id
    )` : ""}`);
}

function imageBytes(db: DatabaseSync, id: string, visibleOnly = false): Uint8Array {
  const row = db.prepare(`SELECT image FROM telegram_game_tips_assets
    WHERE id = ? AND length(image) > 0 ${visibleOnly ? "AND deleted_at = 0" : ""}`).get(id) as { image: Uint8Array } | undefined;
  if (!row) throw new GameTipsError("找不到这张图片。", 404);
  return row.image;
}

function privatePreview(image: Uint8Array, type = "image/jpeg"): Response {
  return new Response(new Uint8Array(image), {
    headers: { "Cache-Control": "private, no-store", "Content-Type": type, "X-Content-Type-Options": "nosniff" },
  });
}

export function gameTipsImagePreview(db: DatabaseSync, id: string): Response {
  ensureGameTipsAssets(db);
  if (!uploadIdPattern.test(id)) throw new GameTipsError("图片编号不正确。");
  return privatePreview(imageBytes(db, id, true));
}

async function normalizeLogo(bytes: Buffer, declared: string): Promise<Buffer> {
  let image: Buffer;
  try {
    const input = await decodeImage(bytes, declared);
    image = await input.resize({ width: 360, height: 220, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 86, alphaQuality: 90 }).toBuffer();
    if (image.length > maxLogoBytes) image = await sharp(image).webp({ quality: 68, alphaQuality: 78 }).toBuffer();
  } catch { throw invalidImage(); }
  if (image.length > maxLogoBytes) throw new GameTipsError("请换一张较小的平台 Logo 图片。", 413);
  return image;
}

function logoUploadMatches(db: DatabaseSync, id: string, hash: string) {
  const existing = db.prepare("SELECT upload_hash FROM telegram_game_tips_logos WHERE id = ?").get(id) as { upload_hash: string } | undefined;
  if (!existing) return false;
  if (existing.upload_hash !== hash) throw new GameTipsError("这个 Logo 上传编号已使用，请重新选择图片。", 409);
  return true;
}

function releaseRetiredImages(db: DatabaseSync, table: "telegram_game_tips_logos" | "telegram_game_tips_backgrounds", slotField: "$.logoId" | "$.backgroundId") {
  const hasSlots = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'telegram_game_tip_slots'").get();
  // Retain the identity for upload replays and the bytes only while a queued send can need them.
  db.prepare(`UPDATE ${table} AS version SET image = X''
    WHERE active = 0 AND length(image) > 0 ${hasSlots ? `AND NOT EXISTS (
      SELECT 1 FROM telegram_game_tip_slots s
      JOIN telegram_scheduled_message_deliveries d
        ON d.plan_id = s.plan_id AND d.plan_revision = s.plan_revision AND d.run_at = s.run_at
      WHERE s.provider_key = version.provider_key AND json_extract(s.selection_json, ?) = version.id
        AND d.status IN ('pending', 'sending')
    )` : ""}`).run(...(hasSlots ? [slotField] : []));
}

export async function uploadGameTipsLogo(db: DatabaseSync, request: Request): Promise<GameTipsLibrary> {
  ensureGameTipsAssets(db);
  const params = new URL(request.url).searchParams;
  const id = params.get("id") ?? "", previousId = params.get("previousId") ?? "";
  if (!uploadIdPattern.test(id) || previousId && !uploadIdPattern.test(previousId)) {
    throw new GameTipsError("Logo 上传编号不正确，请重新选择图片。");
  }
  const provider = nameLabel(params.get("provider") ?? "", GAME_TIPS_PROVIDER_LIMIT, "平台名称");
  const providerKey = gameTipsProviderKey(provider);
  const declared = uploadContentType(request);
  const bytes = await readUpload(request);
  const hash = createHash("sha256").update(JSON.stringify([providerKey, previousId])).update(bytes).digest("hex");
  if (logoUploadMatches(db, id, hash)) return gameTipsLibrary(db);
  const image = await normalizeLogo(bytes, declared);

  db.exec("BEGIN IMMEDIATE");
  try {
    if (!logoUploadMatches(db, id, hash)) {
      const existing = gameTipsProviderLogo(db, provider);
      if ((existing?.logoId ?? "") !== previousId) throw new GameTipsError("平台 Logo 已更新，请刷新图库后再上传。", 409);
      if (!existing) {
        const { count } = db.prepare("SELECT COUNT(*) AS count FROM telegram_game_tips_logos WHERE active = 1").get() as { count: number };
        if (count >= maxProviderLogos) throw new GameTipsError(`图库最多可保存 ${maxProviderLogos} 个平台 Logo。`, 409);
      } else db.prepare("UPDATE telegram_game_tips_logos SET active = 0 WHERE id = ?").run(existing.logoId);
      releaseRetiredImages(db, "telegram_game_tips_logos", "$.logoId");
      const { count } = db.prepare("SELECT COUNT(*) AS count FROM telegram_game_tips_logos WHERE length(image) > 0").get() as { count: number };
      if (count >= maxLogoRevisions) throw new GameTipsError("待发队列暂时占用了较多 Logo 版本，请等发送结束后再试。", 409);
      db.prepare("INSERT INTO telegram_game_tips_logos(id, provider_key, name, active, image, upload_hash) VALUES (?, ?, ?, 1, ?, ?)")
        .run(id, providerKey, existing?.name ?? provider, image, hash);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return gameTipsLibrary(db);
}

function logoBytes(db: DatabaseSync, id: string, activeOnly = false): Uint8Array {
  const row = db.prepare(`SELECT image FROM telegram_game_tips_logos WHERE id = ? AND length(image) > 0 ${activeOnly ? "AND active = 1" : ""}`)
    .get(id) as { image: Uint8Array } | undefined;
  if (!row) throw new GameTipsError("找不到这个平台 Logo。", 404);
  return row.image;
}

export function gameTipsLogoPreview(db: DatabaseSync, id: string): Response {
  ensureGameTipsAssets(db);
  if (!uploadIdPattern.test(id)) throw new GameTipsError("Logo 编号不正确。");
  return privatePreview(logoBytes(db, id, true), "image/webp");
}

function normalizeSlots(input: unknown): GameTipsBackgroundSlot[] {
  if (!validGameTipsBackgroundSlots(input)) {
    throw new GameTipsError("请设置 3 个不重叠且在图片范围内的游戏位置。宽和高至少为 5%。");
  }
  return input.map(({ x, y, width, height }) => ({ x, y, width, height }));
}

function parseSlots(value: string): GameTipsBackgroundSlot[] {
  if (value.length > 2_048) throw new GameTipsError("游戏位置设定过大。");
  let input: unknown;
  try { input = JSON.parse(value); }
  catch { throw new GameTipsError("游戏位置格式不正确。"); }
  return normalizeSlots(input);
}

type BackgroundEdit = { id: string; provider: string; previousId: string; slots: unknown };

function prepareBackgroundVersion(input: BackgroundEdit) {
  if (!uploadIdPattern.test(input.id) || input.previousId && !uploadIdPattern.test(input.previousId)) {
    throw new GameTipsError("背景编号不正确，请重新选择图片。");
  }
  const name = nameLabel(input.provider, GAME_TIPS_PROVIDER_LIMIT, "平台名称");
  return { ...input, name, key: gameTipsProviderKey(name), slotsJson: JSON.stringify(normalizeSlots(input.slots)) };
}

export function gameTipsProviderBackgroundId(db: DatabaseSync, provider: string): string | undefined {
  ensureGameTipsAssets(db);
  const row = db.prepare("SELECT id FROM telegram_game_tips_backgrounds WHERE provider_key = ? AND active = 1")
    .get(gameTipsProviderKey(provider)) as { id: string } | undefined;
  return row?.id;
}

function backgroundUploadMatches(db: DatabaseSync, id: string, hash: string) {
  const existing = db.prepare("SELECT upload_hash FROM telegram_game_tips_backgrounds WHERE id = ?").get(id) as { upload_hash: string } | undefined;
  if (!existing) return false;
  if (existing.upload_hash !== hash) throw new GameTipsError("这个背景上传编号已使用，请重新上传。", 409);
  return true;
}

async function normalizeBackground(bytes: Buffer, declared: string): Promise<Buffer> {
  let image: Buffer;
  try {
    const input = await decodeImage(bytes, declared);
    const metadata = await input.metadata();
    if (Math.max(metadata.width, metadata.height) / Math.min(metadata.width, metadata.height) > 20) throw invalidImage();
    image = await input.resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#0b1637" }).webp({ quality: 88 }).toBuffer();
    if (image.length > maxBackgroundBytes) image = await sharp(image).webp({ quality: 73 }).toBuffer();
  } catch { throw invalidImage(); }
  if (image.length > maxBackgroundBytes) throw new GameTipsError("请换一张较小的背景图片。", 413);
  return image;
}

function backgroundVersion(db: DatabaseSync, id: string, activeOnly = false) {
  const row = db.prepare(`SELECT image, slots_json FROM telegram_game_tips_backgrounds
    WHERE id = ? AND length(image) > 0 ${activeOnly ? "AND active = 1" : ""}`).get(id) as { image: Uint8Array; slots_json: string } | undefined;
  if (!row) throw new GameTipsError("找不到这个平台背景。", 404);
  return row;
}

function saveBackgroundVersion(db: DatabaseSync, version: ReturnType<typeof prepareBackgroundVersion>, hash: string, image?: Buffer): GameTipsLibrary {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!backgroundUploadMatches(db, version.id, hash)) {
      const previous = db.prepare("SELECT id, name FROM telegram_game_tips_backgrounds WHERE provider_key = ? AND active = 1")
        .get(version.key) as { id: string; name: string } | undefined;
      if ((previous?.id ?? "") !== version.previousId) throw new GameTipsError("平台背景已更新，请刷新图库后再保存。", 409);
      const game = db.prepare("SELECT provider AS name FROM telegram_game_tips_assets WHERE provider_key = ? AND deleted_at = 0 ORDER BY enabled DESC, provider LIMIT 1")
        .get(version.key) as { name: string } | undefined;
      const name = gameTipsProviderLogo(db, version.name)?.name ?? previous?.name ?? game?.name;
      if (!name) throw new GameTipsError("请先新增这个平台或为该平台上传游戏图片。", 404);

      const content = image ?? backgroundVersion(db, version.previousId, true).image;
      if (!previous) {
        const { count } = db.prepare("SELECT COUNT(*) AS count FROM telegram_game_tips_backgrounds WHERE active = 1").get() as { count: number };
        if (count >= maxProviderBackgrounds) throw new GameTipsError(`图库最多可保存 ${maxProviderBackgrounds} 个平台背景。`, 409);
      } else {
        db.prepare("UPDATE telegram_game_tips_backgrounds SET active = 0 WHERE id = ?").run(previous.id);
      }
      releaseRetiredImages(db, "telegram_game_tips_backgrounds", "$.backgroundId");
      const { count } = db.prepare("SELECT COUNT(*) AS count FROM telegram_game_tips_backgrounds WHERE length(image) > 0").get() as { count: number };
      if (count >= maxBackgroundRevisions) throw new GameTipsError("待发队列暂时占用了较多背景版本，请等发送结束后再试。", 409);
      db.prepare("INSERT INTO telegram_game_tips_backgrounds(id, provider_key, name, active, image, slots_json, upload_hash) VALUES (?, ?, ?, 1, ?, ?, ?)")
        .run(version.id, version.key, name, content, version.slotsJson, hash);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return gameTipsLibrary(db);
}

export async function uploadGameTipsBackground(db: DatabaseSync, request: Request): Promise<GameTipsLibrary> {
  ensureGameTipsAssets(db);
  const params = new URL(request.url).searchParams;
  const slots = params.get("slots");
  const version = prepareBackgroundVersion({
    id: params.get("id") ?? "",
    provider: params.get("provider") ?? "",
    previousId: params.get("previousId") ?? "",
    slots: slots === null ? GAME_TIPS_DEFAULT_SLOTS : parseSlots(slots),
  });
  const declared = uploadContentType(request);
  const bytes = await readUpload(request);
  const hash = createHash("sha256").update(JSON.stringify(["upload", version.key, version.previousId, version.slotsJson])).update(bytes).digest("hex");
  if (backgroundUploadMatches(db, version.id, hash)) return gameTipsLibrary(db);
  return saveBackgroundVersion(db, version, hash, await normalizeBackground(bytes, declared));
}

export function updateGameTipsBackgroundSlots(db: DatabaseSync, input: BackgroundEdit): GameTipsLibrary {
  ensureGameTipsAssets(db);
  if (!input.previousId) throw new GameTipsError("请先上传平台背景。");
  const version = prepareBackgroundVersion(input);
  const hash = createHash("sha256").update(JSON.stringify(["slots", version.key, version.previousId, version.slotsJson])).digest("hex");
  return saveBackgroundVersion(db, version, hash);
}

export function gameTipsBackgroundPreview(db: DatabaseSync, id: string): Response {
  ensureGameTipsAssets(db);
  if (!uploadIdPattern.test(id)) throw new GameTipsError("背景编号不正确。");
  return privatePreview(backgroundVersion(db, id, true).image, "image/webp");
}

export async function gameTipsPosterPreview(db: DatabaseSync, name: string): Promise<Response> {
  const provider = nameLabel(name, GAME_TIPS_PROVIDER_LIMIT, "平台名称");
  const games = listGameTipAssets(db, provider).slice(0, 3);
  if (games.length < 3) throw new GameTipsError("预览需要同一平台至少三款已启用的游戏。");
  const logo = gameTipsProviderLogo(db, provider);
  return privatePreview(await renderGameTips(db, { provider: logo?.name ?? games[0].provider, games, logoId: logo?.logoId,
    backgroundId: gameTipsProviderBackgroundId(db, provider) }));
}

const width = 1500, height = 900;
const cardWidth = 450, cardOffset = 475, cardLeft = 50;
const logoPlate = Buffer.from(`<svg width="280" height="96" xmlns="http://www.w3.org/2000/svg">
  <rect x="1" y="1" width="278" height="94" rx="18" fill="#151841" stroke="#d7b363" stroke-width="2"/>
</svg>`);
const posterBackground = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="base" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">
      <stop offset="0" stop-color="#070e2e"/><stop offset="0.59" stop-color="#141745"/><stop offset="1" stop-color="#062849"/>
    </linearGradient>
    <radialGradient id="glow">
      <stop offset="0" stop-color="#4b2c87" stop-opacity=".78"/><stop offset="1" stop-color="#171c45" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="edge">
      <stop offset="0" stop-color="#4fc9ed"/><stop offset=".48" stop-color="#866ae8"/><stop offset="1" stop-color="#4fc9ed"/>
    </linearGradient>
  </defs>
  <rect width="1500" height="900" fill="url(#base)"/>
  <ellipse cx="750" cy="230" rx="790" ry="360" fill="url(#glow)"/>
  <path d="M0 58h256l97 26h794l97-26h256M0 107h205l99 38h892l99-38h205"
    stroke="#8261db" fill="none" opacity=".20"/>
  <path d="M0 741 Q380 710 750 821 T1500 741 M0 804 Q320 740 750 846 T1500 804"
    stroke="#4fcbf2" fill="none" opacity=".27"/>
  <path d="M400 287H1100" stroke="url(#edge)" stroke-width="2"/>
  ${Array.from({ length: 3 }, (_, index) => {
    const x = cardLeft + cardOffset * index;
    return `<rect x="${x}" y="328" width="${cardWidth}" height="402" rx="25" fill="#0d133b" stroke="url(#edge)" stroke-width="3"/>
      <path d="M${x + 18} 639h${cardWidth - 36}" stroke="#435e94" opacity=".8"/>`;
  }).join("")}
  <rect x="470" y="773" width="560" height="91" rx="20" fill="#162951" stroke="#d7b363" opacity=".95"/>
</svg>`);

function escapeMarkup(text: string): string {
  return text.replace(/[&<>]/gu, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!);
}

async function posterLabel(value: string, center: number, middle: number, lineWidth: number, maxHeight: number, size: number, color: string): Promise<OverlayOptions> {
  const text = { text: `<span foreground="${color}">${escapeMarkup(value)}</span>`,
    font: `Noto Sans CJK SC Bold ${size}`, rgba: true, align: "center" as const, width: lineWidth, wrap: "word-char" as const };
  let result = await sharp({ text }).png().toBuffer({ resolveWithObject: true });
  if (result.info.height > maxHeight) result = await sharp({ text: { ...text, height: maxHeight } }).png().toBuffer({ resolveWithObject: true });
  return { input: result.data, left: Math.round(center - result.info.width / 2), top: Math.round(middle - result.info.height / 2) };
}

async function templateTile(image: Uint8Array, slot: GameTipsBackgroundSlot, width: number, height: number): Promise<OverlayOptions> {
  const left = Math.round(width * slot.x / 100), top = Math.round(height * slot.y / 100);
  const availableWidth = Math.round(width * (slot.x + slot.width) / 100) - left;
  const availableHeight = Math.round(height * (slot.y + slot.height) / 100) - top;
  const tile = await sharp(image).resize(availableWidth, availableHeight, { fit: "inside" })
    .ensureAlpha().png().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = tile.info;
  const radius = Math.min(14, Math.floor(Math.min(w, h) / 6));
  const mask = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${h}" rx="${radius}" fill="#fff"/></svg>`);
  return {
    input: await sharp(tile.data).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer(),
    left: left + Math.floor((availableWidth - w) / 2),
    top: top + Math.floor((availableHeight - h) / 2),
  };
}

async function renderBackgroundPoster(template: { image: Uint8Array; slots_json: string }, images: Uint8Array[]): Promise<Buffer> {
  const background = sharp(template.image);
  const { width, height } = await background.metadata();
  const slots = parseSlots(template.slots_json);
  const overlays = await Promise.all(slots.map((slot, index) => templateTile(images[index], slot, width, height)));
  return background.composite(overlays).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
}

export async function renderGameTips(db: DatabaseSync, selection: GameTipsSelection): Promise<Buffer> {
  ensureGameTipsAssets(db);
  if (selection.games.length !== 3 || new Set(selection.games.map(game => game.id)).size !== 3) {
    throw new GameTipsError("Game Tips 海报需要三款不同的游戏。");
  }
  const images = selection.games.map(game => imageBytes(db, game.id));
  if (selection.backgroundId) return renderBackgroundPoster(backgroundVersion(db, selection.backgroundId), images);
  const logo = selection.logoId ? logoBytes(db, selection.logoId) : null;
  const overlays = [
    posterLabel(`365FreeBonus  X  ${selection.provider}`, logo ? 625 : 750, 87, logo ? 815 : 1160, 64, 42, "#f7dfaa"),
    posterLabel("GAME TIPS", 750, 172, 1250, 108, 100, "#ffcf63"),
    posterLabel("3 FEATURED GAMES", 750, 246, 900, 42, 35, "#c3dbff"),
    posterLabel("EXPLORE BONUS OFFERS", 750, 807, 510, 34, 29, "#ffe29a"),
    posterLabel("365freebonus.com", 750, 839, 490, 24, 23, "#f3f7ff"),
  ];
  if (logo) {
    const plate = { input: logoPlate, left: 1050, top: 39 };
    overlays.push(Promise.resolve(plate),
      sharp(logo).resize(254, 76, { fit: "contain", background: "#00000000" }).png().toBuffer()
        .then(input => ({ input, left: plate.left + 13, top: plate.top + 10 })));
  }
  for (const [index, game] of selection.games.entries()) {
    const center = cardLeft + index * cardOffset + cardWidth / 2;
    overlays.push(
      sharp(images[index]).resize(420, 278, { fit: "contain", background: "#0b1637" }).jpeg({ quality: 90 }).toBuffer()
        .then(input => ({ input, left: center - 210, top: 348 })),
      posterLabel(game.game, center, 682, 414, 67, 34, "#f7f3ff"),
    );
  }
  return await sharp(posterBackground).composite(await Promise.all(overlays)).jpeg({ quality: 91 }).toBuffer();
}
