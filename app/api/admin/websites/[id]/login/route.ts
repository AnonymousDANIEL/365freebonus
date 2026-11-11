import { authorizeAdmin, jsonBody } from "../../../_security";
import { queueWebsiteLogin } from "../../../../../lib/website-logins";
import { startWebsiteLoginWorker } from "../../../../../lib/website-login-worker";
import { websiteError, websiteId } from "../../_response";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await authorizeAdmin(request);
    await jsonBody(request);
    const website = queueWebsiteLogin(websiteId((await context.params).id));
    startWebsiteLoginWorker();
    return Response.json({ ok: true, website }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return websiteError(error); }
}
