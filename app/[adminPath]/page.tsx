import type { Metadata } from "next";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { chatGPTSignInPath, requireChatGPTUser } from "../chatgpt-auth";
import { getAdminPath } from "../lib/auth-core";
import { brandAnchorPath, isBrandShortSlug } from "../lib/brand-links";
import { readDirectory } from "../lib/server-directory";
import { PUBLIC_SITE_URL } from "../lib/public-brand-pages";
import { isSafeImageUrl } from "../lib/image-url";
import { defaultAvatarImageUrl } from "../lib/brand-media";
import PublicBrandDetail from "../components/PublicBrandDetail";
import AdminWorkspace from "./AdminWorkspace";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ adminPath: string }> };

// Metadata and the body see one public snapshot and one visibility boundary per request.
const readPage = cache(async (segment: string) => {
  const adminPath = getAdminPath();
  if (`/${segment}` === adminPath) return { kind: "admin" as const, adminPath };
  if (!isBrandShortSlug(segment, adminPath)) return { kind: "missing" as const };
  const now = Date.now();
  const data = await readDirectory(false, now, adminPath);
  const brand = data.brands.find(item => item.slug === segment);
  if (!brand) return { kind: "missing" as const };
  const canonicalPath = brand.detailPath ?? null;
  return { kind: "brand" as const, brand, settings: data.settings, canonicalPath };
});

function descriptionExcerpt(value: string) {
  const plain = value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const characters = Array.from(plain);
  return characters.length > 157 ? `${characters.slice(0, 157).join("").trimEnd()}…` : plain;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { adminPath: segment } = await params;
  const page = await readPage(segment);
  if (page.kind === "missing") notFound();
  if (page.kind === "admin") return { title: "Website management | 365 Free Bonus", robots: { index: false, follow: false } };
  if (!page.canonicalPath) return { robots: { index: false, follow: false }, alternates: { canonical: `${PUBLIC_SITE_URL}/` } };
  const title = `${page.brand.name} — Brand Information | 365 Free Bonus`;
  const description = descriptionExcerpt(page.brand.description);
  const canonical = `${PUBLIC_SITE_URL}${page.canonicalPath}`;
  const image = [page.brand.imageUrl, page.settings.avatarImageUrl, defaultAvatarImageUrl]
    .find(value => value && isSafeImageUrl(value)) || defaultAvatarImageUrl;
  const images = [{ url: new URL(image, PUBLIC_SITE_URL).toString(), alt: page.brand.name }];
  return {
    title,
    description,
    alternates: { canonical },
    robots: { index: true, follow: true },
    openGraph: { title, description, url: canonical, siteName: "365 Free Bonus", type: "website", images },
    twitter: { card: "summary_large_image", title, description, images: images.map(item => item.url) },
  };
}

export default async function SingleSegmentPage({ params }: Props) {
  const { adminPath: segment } = await params;
  const page = await readPage(segment);
  if (page.kind === "missing") notFound();
  if (page.kind === "admin") {
    const user = await requireChatGPTUser(page.adminPath);
    return <AdminWorkspace displayName={user.displayName} signInPath={chatGPTSignInPath(page.adminPath)} />;
  }
  if (!page.canonicalPath) redirect(brandAnchorPath(page.brand.id));
  const breadcrumb = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: `${PUBLIC_SITE_URL}/` },
    { "@type": "ListItem", position: 2, name: page.brand.name, item: `${PUBLIC_SITE_URL}${page.canonicalPath}` },
  ] };
  return <>
    <PublicBrandDetail brand={page.brand} settings={page.settings} />
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumb).replace(/</g, "\\u003c") }} />
  </>;
}
