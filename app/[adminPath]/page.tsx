import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { chatGPTSignInPath, requireChatGPTUser } from "../chatgpt-auth";
import { getAdminPath } from "../lib/auth-core";
import { brandAnchorPath, isBrandShortSlug } from "../lib/brand-links";
import { readPublicBrandIdBySlug } from "../lib/server-directory";
import AdminClient from "./AdminClient";
import "./admin.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function SingleSegmentPage({ params }: { params: Promise<{ adminPath: string }> }) {
  const { adminPath: segment } = await params;
  const path = getAdminPath();
  if (`/${segment}` === path) {
    const user = await requireChatGPTUser(path);
    return <AdminClient displayName={user.displayName} signInPath={chatGPTSignInPath(path)} />;
  }
  if (!isBrandShortSlug(segment, path)) notFound();
  const brandId = readPublicBrandIdBySlug(segment);
  if (brandId === null) notFound();
  redirect(brandAnchorPath(brandId));
}
