import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import sharp, { type OverlayOptions } from "sharp";
import { GAME_TIPS_NAME_LIMIT, GAME_TIPS_PROVIDER_LIMIT, GAME_TIPS_UPLOAD_LIMIT, gameTipsProviderKey,
  type GameTipsAsset, type GameTipsLibrary, type GameTipsProvider, type GameTipsSelection } from "./telegram-game-tips-types";

export { gameTipsProviderKey, gameTipsCaption } from "./telegram-game-tips-types";

const initialized = new WeakSet<DatabaseSync>();
const uploadIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const maxAssets = 250;
const maxPixels = 24_000_000;
const maxStoredBytes = 256 * 1024;
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
  ON telegram_game_tips_assets(provider_key, game_key) WHERE enabled = 1;`);
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
  const rows = db.prepare(`SELECT ${assetFields} FROM telegram_game_tips_assets WHERE enabled = 1
    ${filtered ? "AND provider_key = ?" : ""} ORDER BY provider_key, game_key, id`)
    .all(...(filtered ? [gameTipsProviderKey(provider)] : [])) as AssetRow[];
  return rows.map(asAsset);
}

export function gameTipsProviders(db: DatabaseSync): GameTipsProvider[] {
  ensureGameTipsAssets(db);
  const rows = db.prepare(`SELECT MIN(provider) AS name, COUNT(*) AS count FROM telegram_game_tips_assets
    WHERE enabled = 1 GROUP BY provider_key ORDER BY provider_key`).all() as GameTipsProvider[];
  return rows.map(({ name, count }) => ({ name, count }));
}

export function gameTipsLibrary(db: DatabaseSync): GameTipsLibrary {
  ensureGameTipsAssets(db);
  const assets = (db.prepare(`SELECT ${assetFields} FROM telegram_game_tips_assets WHERE deleted_at = 0
    ORDER BY enabled DESC, provider_key, game_key, created_at DESC`).all() as AssetRow[]).map(asAsset);
  return { assets, providers: gameTipsProviders(db) };
}

function invalidImage() { return new GameTipsError("请选择可识别的 JPG、PNG 或 WebP 静态图片。", 415); }

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

async function normalizeImage(bytes: Buffer, declared: string): Promise<Buffer> {
  const signature = bytes.subarray(0, 12);
  const detected = signature.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? "jpeg"
    : signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
    : signature.toString("ascii", 0, 4) === "RIFF" && signature.toString("ascii", 8, 12) === "WEBP" ? "webp" : null;
  if (!detected || declared !== "application/octet-stream" && declared !== allowedFormats[detected]) throw invalidImage();
  try {
    const input = sharp(bytes, { limitInputPixels: maxPixels, sequentialRead: true, failOn: "warning" });
    const { format, width, height, pages } = await input.metadata();
    if (format !== detected || (pages ?? 1) !== 1 || width < 32 || height < 32 || width * height > maxPixels) throw invalidImage();
    const decoded = await input.timeout({ seconds: 4 }).autoOrient().resize({ width: 640, height: 440, fit: "inside", withoutEnlargement: true })
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

export async function uploadGameTipsAsset(db: DatabaseSync, request: Request, clock = Date.now): Promise<GameTipsLibrary> {
  ensureGameTipsAssets(db);
  const params = new URL(request.url).searchParams;
  const id = params.get("id") ?? "";
  if (!uploadIdPattern.test(id)) throw new GameTipsError("上传编号不正确，请重新选择图片。");
  const names = namesOf(params.get("provider") ?? "", params.get("game") ?? "");
  const declared = (request.headers.get("content-type") || "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
  if (declared !== "application/octet-stream" && !Object.values(allowedFormats).includes(declared)) throw invalidImage();
  const bytes = await readUpload(request);
  const hash = createHash("sha256").update(JSON.stringify([names.provider, names.game])).update(bytes).digest("hex");
  if (uploadMatches(db, id, hash)) return gameTipsLibrary(db);
  const image = await normalizeImage(bytes, declared);
  if (image.length > maxStoredBytes) throw new GameTipsError("这张图片无法压缩到允许大小，请换一张较小的图片。", 413);

  db.exec("BEGIN IMMEDIATE");
  try {
    if (!uploadMatches(db, id, hash)) {
      const { count } = db.prepare("SELECT COUNT(*) AS count FROM telegram_game_tips_assets WHERE deleted_at = 0").get() as { count: number };
      if (count >= maxAssets) throw new GameTipsError(`图库最多可保存 ${maxAssets} 张图片。`, 409);
      ensureDistinctGame(db, names, id);
      const now = clock();
      db.prepare(`INSERT INTO telegram_game_tips_assets
        (id, provider, provider_key, game, game_key, enabled, image, upload_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(id, names.provider, names.providerKey, names.game, names.gameKey, image, hash, now, now);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
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
    const row = currentAsset(db, input.id, input.updatedAt);
    if (row.enabled) throw new GameTipsError("请先停用图片，再从图库移除。", 409);
    const hasSlots = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'telegram_game_tip_slots'").get();
    const inQueue = hasSlots && db.prepare(`SELECT 1 FROM telegram_game_tip_slots s
      WHERE EXISTS (SELECT 1 FROM json_each(s.selection_json, '$.games') AS game WHERE json_extract(game.value, '$.id') = ?)
        AND EXISTS (SELECT 1 FROM telegram_scheduled_message_deliveries d
          WHERE d.plan_id = s.plan_id AND d.plan_revision = s.plan_revision AND d.run_at = s.run_at AND d.status IN ('pending','sending'))
      LIMIT 1`).get(input.id);
    if (inQueue) throw new GameTipsError("已有待发 Game Tips 使用这张图片，请等发送结束后再移除。", 409);
    // Remember the ID so a delayed replay cannot restore the removed media.
    db.prepare("UPDATE telegram_game_tips_assets SET image = X'', deleted_at = ? WHERE id = ?")
      .run(Math.max(clock(), row.updatedAt + 1), input.id);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return gameTipsLibrary(db);
}

function imageBytes(db: DatabaseSync, id: string): Uint8Array {
  const row = db.prepare("SELECT image FROM telegram_game_tips_assets WHERE id = ? AND deleted_at = 0").get(id) as { image: Uint8Array } | undefined;
  if (!row) throw new GameTipsError("找不到这张图片。", 404);
  return row.image;
}

function privatePreview(image: Uint8Array): Response {
  return new Response(new Uint8Array(image), {
    headers: { "Cache-Control": "private, no-store", "Content-Type": "image/jpeg", "X-Content-Type-Options": "nosniff" },
  });
}

export function gameTipsImagePreview(db: DatabaseSync, id: string): Response {
  ensureGameTipsAssets(db);
  if (!uploadIdPattern.test(id)) throw new GameTipsError("图片编号不正确。");
  return privatePreview(imageBytes(db, id));
}

export async function gameTipsPosterPreview(db: DatabaseSync, name: string): Promise<Response> {
  const provider = nameLabel(name, GAME_TIPS_PROVIDER_LIMIT, "平台名称");
  const games = listGameTipAssets(db, provider).slice(0, 3);
  if (games.length < 3) throw new GameTipsError("预览需要同一平台至少三款已启用的游戏。");
  return privatePreview(await renderGameTips(db, { provider: games[0].provider, games }));
}

const width = 1500, height = 900;
const cardWidth = 450, cardOffset = 475, cardLeft = 50;
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

export async function renderGameTips(db: DatabaseSync, selection: GameTipsSelection): Promise<Buffer> {
  ensureGameTipsAssets(db);
  if (selection.games.length !== 3 || new Set(selection.games.map(game => game.id)).size !== 3) {
    throw new GameTipsError("Game Tips 海报需要三款不同的游戏。");
  }
  const images = selection.games.map(game => imageBytes(db, game.id));
  const overlays = [
    posterLabel(`365FreeBonus  X  ${selection.provider}`, 750, 87, 1160, 64, 42, "#f7dfaa"),
    posterLabel("GAME TIPS", 750, 172, 1250, 108, 100, "#ffcf63"),
    posterLabel("3 FEATURED GAMES", 750, 246, 900, 42, 35, "#c3dbff"),
    posterLabel("EXPLORE BONUS OFFERS", 750, 807, 510, 34, 29, "#ffe29a"),
    posterLabel("365freebonus.com", 750, 839, 490, 24, 23, "#f3f7ff"),
  ];
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
