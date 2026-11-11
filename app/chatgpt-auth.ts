import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { safeReturnPath, SESSION_COOKIE, verifySession } from "./lib/auth-core";
import { getAdminAuthConfig } from "./lib/admin-credentials";
import { sessionIsActive } from "./lib/session-store";

// Compatibility exports for the existing dashboard. Authentication uses this
// application's signed, revocable administrator cookie; no identity headers.
export type ChatGPTUser = { userId: string; displayName: string; email: string; fullName: string | null };
export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const config = getAdminAuthConfig();
  if (!config) return null;
  const payload = verifySession((await cookies()).get(SESSION_COOKIE)?.value, config);
  if (!payload || !sessionIsActive(payload)) return null;
  return { userId: payload.sub, displayName: payload.sub, email: "", fullName: null };
}
export async function requireChatGPTUser(returnTo: string): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;
  redirect(chatGPTSignInPath(returnTo));
}
export function chatGPTSignInPath(returnTo: string) { return `/login?return_to=${encodeURIComponent(safeReturnPath(returnTo))}`; }
