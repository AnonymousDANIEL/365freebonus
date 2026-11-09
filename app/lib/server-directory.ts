import { randomUUID } from "node:crypto";
import { getSqlite } from "./sqlite";
import { defaultSettings, seedBrands, DEFAULT_PROMOTION_DAYS, PROMOTION_DAY_MS, effectiveBrandCategory, normalizeBrandCategory, isSafeSocialUrl, isValidPromotionStart, PromotionValidationError, SettingsValidationError, type Brand, type BrandCategory, type SiteSettings, type DirectoryData } from "./directory";

const brandColumns = "id, name, slug, category, tagline, description, color, icon, image_url AS imageUrl, featured, published, sort_order AS sortOrder, link, promotion_days AS promotionDays, promotion_expires_at AS promotionExpiresAt, promotion_starts_at AS promotionStartsAt";
const settingsColumns = "name, eyebrow, headline, description, announcement, contact_url AS contactUrl, cover_image_url AS coverImageUrl, avatar_image_url AS avatarImageUrl, whatsapp_url AS whatsappUrl, whatsapp_enabled AS whatsappEnabled, telegram_url AS telegramUrl, telegram_enabled AS telegramEnabled, facebook_url AS facebookUrl, facebook_enabled AS facebookEnabled";
function asSettings(row: Record<string, unknown>): SiteSettings {
  return { ...row, whatsappEnabled: row.whatsappEnabled === 1, telegramEnabled: row.telegramEnabled === 1, facebookEnabled: row.facebookEnabled === 1 } as SiteSettings;
}
function asBrand(row: Record<string, unknown>): Brand {
  const category = normalizeBrandCategory(row.category);
  const promotionDays = category !== "All" && typeof row.promotionDays === "number" && Number.isInteger(row.promotionDays) && row.promotionDays >= 1 && row.promotionDays <= 365 ? row.promotionDays : null;
  const promotionExpiresAt = category !== "All" && typeof row.promotionExpiresAt === "number" && Number.isSafeInteger(row.promotionExpiresAt) && row.promotionExpiresAt > 0 ? row.promotionExpiresAt : null;
  const promotionStartsAt = category !== "All" && isValidPromotionStart(row.promotionStartsAt) ? row.promotionStartsAt : null;
  return { ...row, category, promotionDays, promotionExpiresAt, promotionStartsAt, featured: Boolean(row.featured), published: Boolean(row.published) } as Brand;
}
function publicBrand(brand: Brand, now: number): Brand {
  const start = brand.promotionStartsAt;
  if (brand.category !== "All" && typeof start === "number" && start > now && brand.promotionExpiresAt !== null && brand.promotionExpiresAt > start) {
    return { ...brand, category: "All", scheduledCategory: brand.category };
  }
  return { ...brand, category: effectiveBrandCategory(brand, now) };
}
function brandValues(brand: Brand) {
  return [brand.id, brand.name, brand.slug, brand.category, brand.tagline, brand.description, brand.color, brand.icon, brand.imageUrl, Number(brand.featured), Number(brand.published), brand.sortOrder, brand.link, brand.promotionDays, brand.promotionExpiresAt, brand.promotionStartsAt ?? null];
}
function initializeDirectory() {
  const db = getSqlite();
  if (!db.prepare("SELECT id FROM site_settings WHERE id = 'primary'").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Seeding is atomic and runs once; deleting a brand will never recreate it.
      const settings = defaultSettings;
      const result = db.prepare("INSERT OR IGNORE INTO site_settings (id, name, eyebrow, headline, description, announcement, contact_url, cover_image_url, avatar_image_url, whatsapp_url, whatsapp_enabled, telegram_url, telegram_enabled, facebook_url, facebook_enabled) VALUES ('primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(settings.name, settings.eyebrow, settings.headline, settings.description, settings.announcement, settings.contactUrl, settings.coverImageUrl, settings.avatarImageUrl, settings.whatsappUrl, Number(settings.whatsappEnabled), settings.telegramUrl, Number(settings.telegramEnabled), settings.facebookUrl, Number(settings.facebookEnabled));
      if (result.changes) {
        const insert = db.prepare("INSERT OR IGNORE INTO brands (id, name, slug, category, tagline, description, color, icon, image_url, featured, published, sort_order, link, promotion_days, promotion_expires_at, promotion_starts_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (const brand of seedBrands) insert.run(...brandValues(brand));
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return db;
}

export async function readDirectory(includeDrafts = false, now = Date.now()): Promise<DirectoryData> {
  const db = initializeDirectory();
  const settings = db.prepare(`SELECT ${settingsColumns} FROM site_settings WHERE id = 'primary'`).get();
  if (!settings) throw new Error("Website settings could not be loaded.");
  const rows = db.prepare(`SELECT ${brandColumns} FROM brands ${includeDrafts ? "" : "WHERE published = 1"} ORDER BY sort_order, name`).all();
  const brands = rows.map(asBrand);
  const savedSettings = asSettings(settings);
  const visibleSettings = includeDrafts ? savedSettings : {
    ...savedSettings,
    whatsappUrl: savedSettings.whatsappEnabled ? savedSettings.whatsappUrl : "",
    telegramUrl: savedSettings.telegramEnabled ? savedSettings.telegramUrl : "",
    facebookUrl: savedSettings.facebookEnabled ? savedSettings.facebookUrl : "",
  };
  return { settings: visibleSettings, brands: includeDrafts ? brands : brands.map(brand => publicBrand(brand, now)) };
}

export type BrandWriteInput = Omit<Brand, "id" | "category" | "promotionDays" | "promotionExpiresAt" | "scheduledCategory"> & {
  category?: BrandCategory | "Gaming" | "Lifestyle" | "Entertainment";
  promotionDays?: number | null;
  promotionExpiresAt?: number | null;
};

function promotionDuration(input: number | null | undefined, fallback: number): number {
  if (input === null || input === undefined) return fallback;
  if (!Number.isInteger(input) || input < 1 || input > 365) throw new RangeError("Promotion duration must be between 1 and 365 days.");
  return input;
}

function promotionStart(input: number | null | undefined, previous: number | null, now: number): number | null {
  if (input === undefined) return previous;
  if (input === null) return null;
  if (!isValidPromotionStart(input)) throw new PromotionValidationError("请输入有效的推广开始时间。");
  if (input !== previous && input < now) throw new PromotionValidationError("推广开始时间不能早于现在。若要立即开始，请清空定时时间。");
  return input;
}

function enqueuePromotion(db: ReturnType<typeof getSqlite>, brandId: string) {
  db.prepare(`INSERT INTO telegram_promotion_outbox (brand_id, revision) VALUES (?, ?)
    ON CONFLICT(brand_id) DO UPDATE SET revision=excluded.revision, status='pending',
      attempts=0, next_attempt_at=0, last_error='', sent_at=NULL, message_id=NULL
  `).run(brandId, randomUUID());
}

export function createBrand(input: BrandWriteInput & { id: string }, now = Date.now()): Brand {
  const db = initializeDirectory();
  const category = normalizeBrandCategory(input.category);
  const promotionDays = category === "All" ? null : promotionDuration(input.promotionDays, DEFAULT_PROMOTION_DAYS);
  const promotionStartsAt = category === "All" ? null : promotionStart(input.promotionStartsAt, null, now);
  // Derive the deadline from the accepted start and duration.
  const promotionExpiresAt = promotionDays === null ? null : (promotionStartsAt ?? now) + promotionDays * PROMOTION_DAY_MS;
  const brand: Brand = { ...input, category, promotionDays, promotionStartsAt, promotionExpiresAt };
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO brands (id, name, slug, category, tagline, description, color, icon, image_url, featured, published, sort_order, link, promotion_days, promotion_expires_at, promotion_starts_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(...brandValues(brand));
    if (category !== "All") enqueuePromotion(db, brand.id);
    db.exec("COMMIT");
    return brand;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function updateBrand(id: string, input: BrandWriteInput, now = Date.now()): Brand | null {
  const db = initializeDirectory();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`SELECT ${brandColumns} FROM brands WHERE id=?`).get(id);
    if (!row) { db.exec("COMMIT"); return null; }
    const previous = asBrand(row);
    const category = normalizeBrandCategory(input.category);
    const promotionDays = category === "All" ? null : promotionDuration(input.promotionDays, previous.promotionDays ?? DEFAULT_PROMOTION_DAYS);
    const previousStart = previous.promotionStartsAt ?? null;
    const categoryChanged = category !== previous.category;
    // Older clients can reassign a started promotion without a start field.
    // A new assignment starts now unless a future schedule or explicit start is supplied.
    const startsImmediately = categoryChanged && input.promotionStartsAt === undefined && previousStart !== null && previousStart < now;
    const promotionStartsAt = category === "All" || startsImmediately ? null : promotionStart(input.promotionStartsAt, previousStart, now);
    const assignmentChanged = categoryChanged || promotionStartsAt !== previousStart;
    const durationChanged = promotionDays !== previous.promotionDays;
    let promotionExpiresAt = previous.promotionExpiresAt;
    if (promotionDays === null) promotionExpiresAt = null;
    else if (assignmentChanged || durationChanged) promotionExpiresAt = (promotionStartsAt ?? now) + promotionDays * PROMOTION_DAY_MS;
    const brand: Brand = { ...input, id, category, promotionDays, promotionStartsAt, promotionExpiresAt };
    const reactivated = durationChanged && previous.promotionExpiresAt !== null && previous.promotionExpiresAt <= now && effectiveBrandCategory(brand, now) !== "All";
    // Reading and updating under one SQLite write lock makes repeated identical
    // requests preserve the first deadline, including retries after expiry.
    db.prepare("UPDATE brands SET name=?, slug=?, category=?, tagline=?, description=?, color=?, icon=?, image_url=?, featured=?, published=?, sort_order=?, link=?, promotion_days=?, promotion_expires_at=?, promotion_starts_at=? WHERE id=?").run(...brandValues(brand).slice(1), id);
    if (category === "All") db.prepare("DELETE FROM telegram_promotion_outbox WHERE brand_id=?").run(id);
    else if (assignmentChanged || reactivated) enqueuePromotion(db, id);
    db.exec("COMMIT");
    return brand;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function deleteBrand(id: string): boolean {
  return Boolean(initializeDirectory().prepare("DELETE FROM brands WHERE id=?").run(id).changes);
}

type OptionalSettings = Pick<SiteSettings, "coverImageUrl" | "avatarImageUrl" | "whatsappUrl" | "whatsappEnabled" | "telegramUrl" | "telegramEnabled" | "facebookUrl" | "facebookEnabled">;
type SettingsUpdate = Omit<SiteSettings, keyof OptionalSettings> & Partial<OptionalSettings>;
const socialChannels = [
  { name: "WhatsApp", urlKey: "whatsappUrl", enabledKey: "whatsappEnabled" },
  { name: "Telegram", urlKey: "telegramUrl", enabledKey: "telegramEnabled" },
  { name: "Facebook", urlKey: "facebookUrl", enabledKey: "facebookEnabled" },
] as const;

export function updateSettings(settings: SettingsUpdate): SiteSettings {
  const db = initializeDirectory();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`SELECT ${settingsColumns} FROM site_settings WHERE id='primary'`).get();
    if (!row) throw new Error("Website settings could not be loaded.");
    const previous = asSettings(row);
    const social = {} as Pick<SiteSettings, "whatsappUrl" | "whatsappEnabled" | "telegramUrl" | "telegramEnabled" | "facebookUrl" | "facebookEnabled">;
    for (const { name, urlKey, enabledKey } of socialChannels) {
      const rawUrl = settings[urlKey] === undefined ? previous[urlKey] : settings[urlKey];
      const enabled = settings[enabledKey] === undefined ? previous[enabledKey] : settings[enabledKey];
      if (typeof rawUrl !== "string" || typeof enabled !== "boolean") throw new SettingsValidationError(`${name} 联系设置格式不正确。`);
      const url = rawUrl.trim();
      if ((url && !isSafeSocialUrl(url)) || (enabled && !url)) throw new SettingsValidationError(`请为 ${name} 填写完整的 http:// 或 https:// 链接后再显示。`);
      social[urlKey] = url;
      social[enabledKey] = enabled;
    }
    // Merge under the same write lock so older saves cannot erase social links
    // or invalidate a concurrent enable/disable change.
    const saved = db.prepare(`UPDATE site_settings SET
      name=?, eyebrow=?, headline=?, description=?, announcement=?, contact_url=?,
      cover_image_url=COALESCE(?, cover_image_url), avatar_image_url=COALESCE(?, avatar_image_url),
      whatsapp_url=?, whatsapp_enabled=?, telegram_url=?, telegram_enabled=?, facebook_url=?, facebook_enabled=?
      WHERE id='primary' RETURNING ${settingsColumns}`).get(settings.name, settings.eyebrow, settings.headline, settings.description, settings.announcement, settings.contactUrl, settings.coverImageUrl ?? null, settings.avatarImageUrl ?? null, social.whatsappUrl, Number(social.whatsappEnabled), social.telegramUrl, Number(social.telegramEnabled), social.facebookUrl, Number(social.facebookEnabled));
    if (!saved) throw new Error("Website settings could not be updated.");
    db.exec("COMMIT");
    return asSettings(saved);
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
