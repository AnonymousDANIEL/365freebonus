import type { DatabaseSync } from "node:sqlite";
import { effectiveBrandCategory, normalizeBrandCategory } from "./directory";
import type { TelegramBrandCard } from "./telegram-brand-card";

type BrandRow = TelegramBrandCard & {
  promotionStartsAt: number | null;
  promotionExpiresAt: number | null;
};
const columns = `id, name, slug, category, tagline, description, link, image_url AS imageUrl,
  promotion_starts_at AS promotionStartsAt, promotion_expires_at AS promotionExpiresAt`;
const visible = "published = 1 AND (publish_at IS NULL OR publish_at <= ?)";

function publicCard(row: BrandRow, now: number): TelegramBrandCard {
  return { ...row, category: effectiveBrandCategory({ ...row, category: normalizeBrandCategory(row.category) }, now) };
}

function normalizedName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function readPublicTelegramBrand(db: DatabaseSync, id: string, now: number): TelegramBrandCard | null {
  const row = db.prepare(`SELECT ${columns} FROM brands WHERE id = ? AND ${visible}`).get(id, now) as BrandRow | undefined;
  return row ? publicCard(row, now) : null;
}

export function searchPublicTelegramBrands(db: DatabaseSync, text: string, now: number): TelegramBrandCard[] {
  // A short brand fragment is enough; punctuation/spacing and letter case are ignored.
  // Commands and one-character fragments do not trigger broad directory replies.
  if (text.trim().startsWith("/") || text.length > 200) return [];
  const query = normalizedName(text);
  const length = Array.from(query).length;
  if (length < 2 || length > 100) return [];
  const rows = db.prepare(`SELECT ${columns} FROM brands WHERE ${visible} ORDER BY sort_order, name`).all(now) as BrandRow[];
  const matches = rows.flatMap(row => {
    const names = [normalizedName(row.name), normalizedName(row.slug)];
    const rank = names.includes(query) ? 0 : names.some(name => name.startsWith(query)) ? 1
      : names.some(name => name.includes(query)) ? 2 : -1;
    return rank < 0 ? [] : [{ row, rank }];
  }).sort((a, b) => a.rank - b.rank);
  const exact = matches.filter(match => match.rank === 0);
  return (exact.length ? exact : matches).map(match => publicCard(match.row, now));
}
