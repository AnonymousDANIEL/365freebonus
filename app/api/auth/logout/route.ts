import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authConfig, SESSION_COOKIE, verifySession } from "../../../lib/auth-core";
import { revokeSession } from "../../../lib/session-store";
import { apiError, authorizeOrigin } from "../../admin/_security";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    authorizeOrigin(request);
    const config = authConfig();
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    const payload = config && verifySession(token, config);
    if (payload) revokeSession(payload);
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
    return response;
  } catch (error) { return apiError(error); }
}
