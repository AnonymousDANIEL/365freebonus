import type { MetadataRoute } from "next";
import { getAdminPath } from "./lib/auth-core";
import { PUBLIC_SITE_URL } from "./lib/public-brand-pages";
import { readPublicBrandDetailPages } from "./lib/server-directory";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const brands = await readPublicBrandDetailPages(getAdminPath());
  // No lastModified is emitted until there is a genuine stored content-update timestamp.
  return [
    { url: `${PUBLIC_SITE_URL}/` },
    ...brands.map(brand => ({ url: `${PUBLIC_SITE_URL}${brand.detailPath}` })),
  ];
}
