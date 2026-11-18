import { isBrandPublished, seedBrands, type Brand } from "./directory";
import { isBrandShortSlug } from "./brand-links";

/** Public identity is fixed; request hosts and deployment URLs never become canonical URLs. */
export const PUBLIC_SITE_URL = "https://365freebonus.com";

function normalizedText(value: string): string {
  return value.normalize("NFKC").replace(/<[^>]*>/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
}

function descriptionKey(brand: Pick<Brand, "name" | "description">): string {
  const text = normalizedText(brand.description);
  const name = normalizedText(brand.name);
  return (name ? text.split(name).join(" ") : text).replace(/\s+/g, " ").trim();
}

const demoDescriptions = new Set(seedBrands.map(descriptionKey));

function hasSubstantiveDescription(brand: Brand): boolean {
  const name = normalizedText(brand.name), description = normalizedText(brand.description);
  // This is an application content guard, not a search-engine word-count requirement.
  return !!name && (description.match(/[\p{L}\p{N}]/gu)?.length || 0) >= 40
    && description !== name && description !== normalizedText(brand.tagline)
    && !demoDescriptions.has(descriptionKey(brand));
}

/** One rule for detail-page indexing, directory links and the sitemap. Thin published shares retain their old redirect. */
export function publicBrandDetailPath(brand: Brand, adminPath: string, now = Date.now(), peers: readonly Brand[] = []): string | null {
  if (!isBrandPublished(brand, now) || !isBrandShortSlug(brand.slug, adminPath) || !hasSubstantiveDescription(brand)) return null;
  const key = descriptionKey(brand);
  if (peers.some(other => other.id !== brand.id && isBrandPublished(other, now)
    && isBrandShortSlug(other.slug, adminPath) && hasSubstantiveDescription(other) && descriptionKey(other) === key)) return null;
  return `/${brand.slug}`;
}
