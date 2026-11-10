import { getSqlite } from "../../lib/sqlite";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    getSqlite().prepare("SELECT id FROM site_settings LIMIT 1").get();
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
