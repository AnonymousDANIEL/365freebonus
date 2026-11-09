import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getChatGPTUser } from "../chatgpt-auth";
import { safeReturnPath } from "../lib/auth-core";
import LoginClient from "./LoginClient";
import "./login.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "管理员登入 | 365freebonus",
  robots: { index: false, follow: false },
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ return_to?: string }> }) {
  const params = await searchParams;
  const returnTo = safeReturnPath(params.return_to);
  if (await getChatGPTUser()) redirect(returnTo);
  return <LoginClient returnTo={returnTo} />;
}
