const reservedSlugs = new Set(["login", "api", "admin"]);

export function isBrandShortSlug(slug: string, adminPath: string): boolean {
  return slug.length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
    && !reservedSlugs.has(slug) && `/${slug}` !== adminPath;
}

export function brandAnchorPath(id: string): string {
  return `/#brand-card-${encodeURIComponent(id)}`;
}

export function brandAnnouncementPath(slug: string, id: string, adminPath: string): string {
  return isBrandShortSlug(slug, adminPath) ? `/${slug}` : brandAnchorPath(id);
}
