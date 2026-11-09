import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { chatGPTSignInPath, requireChatGPTUser } from "../chatgpt-auth";
import { getAdminPath } from "../lib/auth-core";
import AdminClient from "./AdminClient";
import "./admin.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AdminPage({ params }: { params: Promise<{ adminPath: string }> }) {
  const path = getAdminPath();
  if (`/${(await params).adminPath}` !== path) notFound();
  const user = await requireChatGPTUser(path);
  return <AdminClient displayName={user.displayName} signInPath={chatGPTSignInPath(path)} />;
}
