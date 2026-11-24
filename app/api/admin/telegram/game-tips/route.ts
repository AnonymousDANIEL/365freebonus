import { z } from "zod";
import { getSqlite } from "../../../../lib/sqlite";
import { deleteGameTipsAsset, GameTipsError, gameTipsImagePreview, gameTipsLibrary, gameTipsPosterPreview,
  updateGameTipsAsset, uploadGameTipsAsset } from "../../../../lib/telegram-game-tips";
import { ApiError, apiError, authorizeAdmin, jsonBody } from "../../_security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const edit = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  game: z.string(),
  enabled: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
}).strict();
const remove = edit.pick({ id: true, updatedAt: true });
const headers = { "Cache-Control": "private, no-store" };

function failure(error: unknown) {
  return apiError(error instanceof GameTipsError ? new ApiError(error.status, error.message) : error);
}

export async function GET(request: Request) {
  try {
    await authorizeAdmin(request);
    const params = new URL(request.url).searchParams;
    const id = params.get("id"), preview = params.get("preview");
    const db = getSqlite();
    if (id !== null) return gameTipsImagePreview(db, id);
    if (preview !== null) return await gameTipsPosterPreview(db, preview);
    return Response.json(gameTipsLibrary(db), { headers });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    await authorizeAdmin(request, { requireJson: false });
    return Response.json(await uploadGameTipsAsset(getSqlite(), request), { headers });
  } catch (error) { return failure(error); }
}

export async function PUT(request: Request) {
  try {
    await authorizeAdmin(request);
    const input = edit.safeParse(await jsonBody(request));
    if (!input.success) throw new ApiError(400, "图片资料不完整，请刷新图库后再试。");
    return Response.json(updateGameTipsAsset(getSqlite(), input.data), { headers });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  try {
    await authorizeAdmin(request);
    const input = remove.safeParse(await jsonBody(request));
    if (!input.success) throw new ApiError(400, "图片资料不完整，请刷新图库后再试。");
    return Response.json(deleteGameTipsAsset(getSqlite(), input.data), { headers });
  } catch (error) { return failure(error); }
}
