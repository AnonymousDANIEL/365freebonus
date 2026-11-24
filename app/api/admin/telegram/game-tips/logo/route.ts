import { getSqlite } from "../../../../../lib/sqlite";
import { GameTipsError, gameTipsLogoPreview, uploadGameTipsLogo } from "../../../../../lib/telegram-game-tips";
import { ApiError, apiError, authorizeAdmin } from "../../../_security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function failure(error: unknown) {
  return apiError(error instanceof GameTipsError ? new ApiError(error.status, error.message) : error);
}

export async function GET(request: Request) {
  try {
    await authorizeAdmin(request);
    const id = new URL(request.url).searchParams.get("id") ?? "";
    return gameTipsLogoPreview(getSqlite(), id);
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    await authorizeAdmin(request, { requireJson: false });
    return Response.json(await uploadGameTipsLogo(getSqlite(), request), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return failure(error); }
}
