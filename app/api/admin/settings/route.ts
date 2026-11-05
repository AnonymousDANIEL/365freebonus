import { updateSettings } from "../../../lib/server-directory";
import { apiError, authorizeAdmin, jsonBody } from "../_security";
import { settingsInput, validate } from "../_validation";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function PUT(request: Request) {
  try {
    await authorizeAdmin(request);
    const settings = validate(settingsInput, await jsonBody(request));
    return Response.json({ settings: updateSettings(settings) });
  } catch (error) { return apiError(error); }
}
