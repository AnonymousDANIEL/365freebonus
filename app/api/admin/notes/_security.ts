import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession } from "../../../lib/auth-core";
import { getAdminAuthConfig } from "../../../lib/admin-credentials";
import { sessionIsActive } from "../../../lib/session-store";
import { NOTES_COOKIE, SecureNotesError } from "../../../lib/secure-notes";
import { apiError, authorizeAdmin } from "../_security";

export async function notesContext(request?: Request) {
  await authorizeAdmin(request);
  const jar = await cookies();
  const config = getAdminAuthConfig();
  const session = config && verifySession(jar.get(SESSION_COOKIE)?.value, config);
  if (!session || !sessionIsActive(session)) throw new SecureNotesError(401, "登入已失效，请重新登入。");
  return { session, token: jar.get(NOTES_COOKIE)?.value };
}
export function notesResponse(value: unknown, status = 200, token?: string, expiresAt?: number | null) {
  const headers: Record<string, string> = { "Cache-Control": "no-store", Vary: "Cookie" };
  if (token !== undefined) {
    const age = token && expiresAt ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : 0;
    headers["Set-Cookie"] = `${NOTES_COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${age}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
  }
  return Response.json(value, { status, headers });
}
export function notesError(error: unknown) {
  if (error instanceof SecureNotesError) {
    const headers: Record<string, string> = { "Cache-Control": "no-store", Vary: "Cookie" };
    if (error.retryAfter) headers["Retry-After"] = String(error.retryAfter);
    return Response.json({ error: error.message }, { status: error.status, headers });
  }
  return apiError(error);
}
