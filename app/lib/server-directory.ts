import { getSqlite } from "./sqlite";
import { defaultSettings, seedBrands, type Brand, type SiteSettings, type DirectoryData } from "./directory";

const brandColumns = "id, name, slug, category, tagline, description, color, icon, image_url AS imageUrl, featured, published, sort_order AS sortOrder, link";
const settingsColumns = "name, eyebrow, headline, description, announcement, contact_url AS contactUrl, cover_image_url AS coverImageUrl, avatar_image_url AS avatarImageUrl";
function asBrand(row: Record<string, unknown>): Brand {
  return { ...row, featured: Boolean(row.featured), published: Boolean(row.published) } as Brand;
}
function brandValues(brand: Brand) {
  return [brand.id, brand.name, brand.slug, brand.category, brand.tagline, brand.description, brand.color, brand.icon, brand.imageUrl, Number(brand.featured), Number(brand.published), brand.sortOrder, brand.link];
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
        const insert = db.prepare("INSERT OR IGNORE INTO brands (id, name, slug, category, tagline, description, color, icon, image_url, featured, published, sort_order, link) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (const brand of seedBrands) insert.run(...brandValues(brand));
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return db;
}

export async function readDirectory(includeDrafts = false): Promise<DirectoryData> {
  const db = initializeDirectory();
  const settings = db.prepare(`SELECT ${settingsColumns} FROM site_settings WHERE id = 'primary'`).get() as SiteSettings | undefined;
  if (!settings) throw new Error("Website settings could not be loaded.");
  const rows = db.prepare(`SELECT ${brandColumns} FROM brands ${includeDrafts ? "" : "WHERE published = 1"} ORDER BY sort_order, name`).all();
  return { settings: { ...settings }, brands: rows.map(asBrand) };
}

export function createBrand(brand: Brand): Brand {
  const db = initializeDirectory();
  db.prepare("INSERT INTO brands (id, name, slug, category, tagline, description, color, icon, image_url, featured, published, sort_order, link) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(...brandValues(brand));
  return brand;
}

export function updateBrand(id: string, input: Omit<Brand, "id">): Brand | null {
  const db = initializeDirectory();
  const brand = { id, ...input };
  const values = brandValues(brand);
  const result = db.prepare("UPDATE brands SET name=?, slug=?, category=?, tagline=?, description=?, color=?, icon=?, image_url=?, featured=?, published=?, sort_order=?, link=? WHERE id=?").run(...values.slice(1), id);
  return result.changes ? brand : null;
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
