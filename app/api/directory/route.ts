import { readDirectory } from "../../lib/server-directory";
import { getAdminPath } from "../../lib/auth-core";
import { apiError } from "../admin/_security";
export const dynamic = "force-dynamic";
export async function GET() {
  try { return Response.json(await readDirectory(false, Date.now(), getAdminPath()), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return apiError(error); }
}
