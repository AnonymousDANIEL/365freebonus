import { NextResponse } from "next/server";
import { issueSession, safeReturnPath, SESSION_COOKIE, SESSION_MAX_AGE, verifyCredentials } from "../../../lib/auth-core";
import { getAdminAuthConfig } from "../../../lib/admin-credentials";
import { clientIpKey, clearLoginAttempts, consumeLoginAttempt, saveSession } from "../../../lib/session-store";
import { apiError, ApiError, authorizeOrigin, jsonBody } from "../../admin/_security";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
function recordLoginEvent(event: "admin_login_failed" | "admin_login_rate_limited", status: number, clientIpHash: string) {
  console.warn(JSON.stringify({ type: "security_event", event, status, timestamp: new Date().toISOString(), clientIpHash }));
}
export async function POST(request: Request) {
  try {
    authorizeOrigin(request);
    const config = getAdminAuthConfig();
    if (!config) throw new ApiError(503, "管理员入口尚未配置完成，请联系网站拥有者。");
    const ipKey = clientIpKey(request);
    const attempt = consumeLoginAttempt(ipKey);
    if (!attempt.allowed) {
      recordLoginEvent("admin_login_rate_limited", 429, ipKey);
      return Response.json({ error: "尝试次数过多，请稍后再登入。" }, { status: 429, headers: { "Retry-After": String(attempt.retryAfter), "Cache-Control": "no-store" } });
    }
    const body = await jsonBody(request);
    if (!body || typeof body !== "object" || typeof body.username !== "string" || typeof body.password !== "string" || body.username.length > 80 || body.password.length < 1 || body.password.length > 1024) throw new ApiError(400, "请填写管理员账号与密码。");
    if (!await verifyCredentials(body.username, body.password, config)) {
      recordLoginEvent("admin_login_failed", 401, ipKey);
      throw new ApiError(401, "账号或密码不正确。");
    }
    clearLoginAttempts(ipKey);
    const { token, payload } = issueSession(config);
    saveSession(payload);
    const response = NextResponse.json({ ok: true, redirect: safeReturnPath(body.returnTo) }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE });
    return response;
  } catch (error) { return apiError(error); }
}
