import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "../../../lib/auth-core";
import { getAdminAuthConfig } from "../../../lib/admin-credentials";
import { NOTES_COOKIE, logoutNotesAndAdmin } from "../../../lib/secure-notes";
import { apiError, authorizeOrigin } from "../../admin/_security";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    authorizeOrigin(request);
    const config = getAdminAuthConfig();
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    const payload = config && verifySession(token, config);
    logoutNotesAndAdmin(payload || null, jar.get(NOTES_COOKIE)?.value);
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
    response.cookies.set(NOTES_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/api", maxAge: 0 });
    response.cookies.set("directory_notes_unlock", "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/api/admin/notes", maxAge: 0 });
    return response;
  } catch (error) { return apiError(error); }
}
