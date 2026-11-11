import { authorizeAdmin, jsonBody } from "../../_security";
import { deleteWebsite, saveWebsite } from "../../../../lib/website-logins";
import { websiteError, websiteId } from "../_response";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function PUT(request: Request, context: Context) {
  try {
    await authorizeAdmin(request);
    const website = saveWebsite(await jsonBody(request), websiteId((await context.params).id));
    return Response.json({ website }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return websiteError(error); }
}
export async function DELETE(request: Request, context: Context) {
  try {
    await authorizeAdmin(request);
    deleteWebsite(websiteId((await context.params).id));
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return websiteError(error); }
}
