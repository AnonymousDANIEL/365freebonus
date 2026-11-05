import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getChatGPTUser } from "../chatgpt-auth";
import LoginClient from "./LoginClient";
import "./login.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "管理员登入 | 365freebonus",
  robots: { index: false, follow: false },
};

function safeReturnTo(value?: string) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/admin";
  try {
    const url = new URL(value, "https://local.invalid");
    if (url.origin !== "https://local.invalid" || url.pathname === "/login" || url.pathname.startsWith("/api/")) return "/admin";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return "/admin"; }
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ return_to?: string }> }) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.return_to);
  if (await getChatGPTUser()) redirect(returnTo);
  return <LoginClient returnTo={returnTo} />;
}
