import { NextResponse, type NextRequest } from "next/server";
import { hasVerifiedOrigin, originGuardEnabled } from "./app/lib/origin-guard";

export function proxy(request: NextRequest) {
  // Railway and external monitors need only this minimal, read-only endpoint.
  const publicHealth = request.nextUrl.pathname === "/api/health"
    && (request.method === "GET" || request.method === "HEAD");
  if (!originGuardEnabled() || publicHealth || hasVerifiedOrigin(request)) {
    return NextResponse.next();
  }

  return new NextResponse("Not Found", {
    status: 404,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}

// Include API routes, Next assets and public files: none may bypass the edge.
export const config = { matcher: "/:path*" };
