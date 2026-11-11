import { authorizeAdmin, jsonBody } from "../_security";
import { listWebsites, saveWebsite } from "../../../lib/website-logins";
import { startWebsiteLoginWorker } from "../../../lib/website-login-worker";
import { websiteError } from "./_response";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    await authorizeAdmin();
    return Response.json(listWebsites(Number(new URL(request.url).searchParams.get("page") || 1)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return websiteError(error); }
}
export async function POST(request: Request) {
  try {
    await authorizeAdmin(request);
    const website = saveWebsite(await jsonBody(request));
    startWebsiteLoginWorker();
    return Response.json({ website }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return websiteError(error); }
}
