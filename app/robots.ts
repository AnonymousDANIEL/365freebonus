import type { MetadataRoute } from "next";
import { PUBLIC_SITE_URL } from "./lib/public-brand-pages";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: ["/", "/api/images/"], disallow: "/api/" },
    sitemap: `${PUBLIC_SITE_URL}/sitemap.xml`,
  };
}
