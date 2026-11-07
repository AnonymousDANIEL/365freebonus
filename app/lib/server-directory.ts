import { getSqlite } from "./sqlite";
import { defaultSettings, seedBrands, DEFAULT_PROMOTION_DAYS, PROMOTION_DAY_MS, effectiveBrandCategory, normalizeBrandCategory, type Brand, type BrandCategory, type SiteSettings, type DirectoryData } from "./directory";

const brandColumns = "id, name, slug, category, tagline, description, color, icon, image_url AS imageUrl, featured, published, sort_order AS sortOrder, link, promotion_days AS promotionDays, promotion_expires_at AS promotionExpiresAt";
const settingsColumns = "name, eyebrow, headline, description, announcement, contact_url AS contactUrl, cover_image_url AS coverImageUrl, avatar_image_url AS avatarImageUrl";
function asBrand(row: Record<string, unknown>): Brand {
  const category = normalizeBrandCategory(row.category);
  const promotionDays = category !== "All" && typeof row.promotionDays === "number" && Number.isInteger(row.promotionDays) && row.promotionDays >= 1 && row.promotionDays <= 365 ? row.promotionDays : null;
  const promotionExpiresAt = category !== "All" && typeof row.promotionExpiresAt === "number" && Number.isSafeInteger(row.promotionExpiresAt) && row.promotionExpiresAt > 0 ? row.promotionExpiresAt : null;
  return { ...row, category, promotionDays, promotionExpiresAt, featured: Boolean(row.featured), published: Boolean(row.published) } as Brand;
}
function brandValues(brand: Brand) {
  return [brand.id, brand.name, brand.slug, brand.category, brand.tagline, brand.description, brand.color, brand.icon, brand.imageUrl, Number(brand.featured), Number(brand.published), brand.sortOrder, brand.link, brand.promotionDays, brand.promotionExpiresAt];
}
function initializeDirectory() {
  const db = getSqlite();
  if (!db.prepare("SELECT id FROM site_settings WHERE id = 'primary'").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Seeding is atomic and runs once; deleting a brand will never recreate it.
      const settings = defaultSettings;
      const result = db.prepare("INSERT OR IGNORE INTO site_settings (id, name, eyebrow, headline, description, announcement, contact_url, cover_image_url, avatar_image_url) VALUES ('primary', ?, ?, ?, ?, ?, ?, ?, ?)").run(settings.name, settings.eyebrow, settings.headline, settings.description, settings.announcement, settings.contactUrl, settings.coverImageUrl, settings.avatarImageUrl);
      if (result.changes) {
        const insert = db.prepare("INSERT OR IGNORE INTO brands (id, name, slug, category, tagline, description, color, icon, image_url, featured, published, sort_order, link, promotion_days, promotion_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (const brand of seedBrands) insert.run(...brandValues(brand));
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return db;
}

export async function readDirectory(includeDrafts = false, now = Date.now()): Promise<DirectoryData> {
  const db = initializeDirectory();
  const settings = db.prepare(`SELECT ${settingsColumns} FROM site_settings WHERE id = 'primary'`).get() as SiteSettings | undefined;
  if (!settings) throw new Error("Website settings could not be loaded.");
  const rows = db.prepare(`SELECT ${brandColumns} FROM brands ${includeDrafts ? "" : "WHERE published = 1"} ORDER BY sort_order, name`).all();
  const brands = rows.map(asBrand);
  return { settings: { ...settings }, brands: includeDrafts ? brands : brands.map(brand => ({ ...brand, category: effectiveBrandCategory(brand, now) })) };
}

export type BrandWriteInput = Omit<Brand, "id" | "category" | "promotionDays" | "promotionExpiresAt"> & {
  category?: BrandCategory | "Gaming" | "Lifestyle" | "Entertainment";
  promotionDays?: number | null;
  promotionExpiresAt?: number | null;
};

function promotionDuration(input: number | null | undefined, fallback: number): number {
  if (input === null || input === undefined) return fallback;
  if (!Number.isInteger(input) || input < 1 || input > 365) throw new RangeError("Promotion duration must be between 1 and 365 days.");
  return input;
}

export function createBrand(input: BrandWriteInput & { id: string }, now = Date.now()): Brand {
  const db = initializeDirectory();
  const category = normalizeBrandCategory(input.category);
  const promotionDays = category === "All" ? null : promotionDuration(input.promotionDays, DEFAULT_PROMOTION_DAYS);
  // Client-supplied timestamps never decide or extend a promotion's deadline.
  const brand: Brand = { ...input, category, promotionDays, promotionExpiresAt: promotionDays === null ? null : now + promotionDays * PROMOTION_DAY_MS };
  db.prepare("INSERT INTO brands (id, name, slug, category, tagline, description, color, icon, image_url, featured, published, sort_order, link, promotion_days, promotion_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(...brandValues(brand));
  return brand;
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
    const promotionChanged = category !== previous.category || promotionDays !== previous.promotionDays;
    const promotionExpiresAt = promotionDays === null ? null : promotionChanged ? now + promotionDays * PROMOTION_DAY_MS : previous.promotionExpiresAt;
    const brand: Brand = { id, ...input, category, promotionDays, promotionExpiresAt };
    // Reading and updating under one SQLite write lock makes repeated identical
    // requests preserve the first deadline, including retries after expiry.
    db.prepare("UPDATE brands SET name=?, slug=?, category=?, tagline=?, description=?, color=?, icon=?, image_url=?, featured=?, published=?, sort_order=?, link=?, promotion_days=?, promotion_expires_at=? WHERE id=?").run(...brandValues(brand).slice(1), id);
    db.exec("COMMIT");
    return brand;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function deleteBrand(id: string): boolean {
  return Boolean(initializeDirectory().prepare("DELETE FROM brands WHERE id=?").run(id).changes);
}

type ImageSettings = Pick<SiteSettings, "coverImageUrl" | "avatarImageUrl">;
type SettingsUpdate = Omit<SiteSettings, keyof ImageSettings> & Partial<ImageSettings>;
export function updateSettings(settings: SettingsUpdate): SiteSettings {
  const saved = initializeDirectory().prepare(`UPDATE site_settings SET
    name=?, eyebrow=?, headline=?, description=?, announcement=?, contact_url=?,
    cover_image_url=COALESCE(?, cover_image_url), avatar_image_url=COALESCE(?, avatar_image_url)
    WHERE id='primary' RETURNING ${settingsColumns}`).get(settings.name, settings.eyebrow, settings.headline, settings.description, settings.announcement, settings.contactUrl, settings.coverImageUrl ?? null, settings.avatarImageUrl ?? null) as SiteSettings | undefined;
  if (!saved) throw new Error("Website settings could not be updated.");
  return { ...saved };
}
