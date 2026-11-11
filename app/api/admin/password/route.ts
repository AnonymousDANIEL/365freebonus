import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "../../../lib/auth-core";
import { changeAdminPassword, getAdminAuthConfig, PasswordChangeError } from "../../../lib/admin-credentials";
import { clientIpKey, consumeLoginAttempt } from "../../../lib/session-store";
import { ApiError, apiError, authorizeAdmin, jsonBody } from "../_security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    await authorizeAdmin(request);
    const config = getAdminAuthConfig();
    const session = config && verifySession((await cookies()).get(SESSION_COOKIE)?.value, config);
    if (!config || !session) throw new ApiError(401, "登入已失效，请重新登入。");
    const attempt = consumeLoginAttempt(`password-change:${clientIpKey(request)}`);
    if (!attempt.allowed) {
      return Response.json({ error: "尝试次数过多，请稍后再更改密码。" }, { status: 429, headers: { "Retry-After": String(attempt.retryAfter), "Cache-Control": "no-store" } });
    }
    await changeAdminPassword(await jsonBody(request), session, config);
    // Do not log submitted passwords, hashes, cookies or identifiers.
    console.info(JSON.stringify({ type: "security_event", event: "admin_password_changed", timestamp: new Date().toISOString(), status: 200 }));
    const response = NextResponse.json({ ok: true, redirect: "/login" }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
    return response;
  } catch (error) {
    if (error instanceof PasswordChangeError) return apiError(new ApiError(error.status, error.message));
    return apiError(error);
  }
}
