import { readDirectory } from "../../lib/server-directory";
import { apiError } from "../admin/_security";
export const dynamic = "force-dynamic";
export async function GET() {
  try { return Response.json(await readDirectory(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return apiError(error); }
}
