import { z } from "zod";
import { getSqlite } from "../../../../../lib/sqlite";
import { GameTipsError, gameTipsBackgroundPreview, updateGameTipsBackgroundSlots, uploadGameTipsBackground } from "../../../../../lib/telegram-game-tips";
import { ApiError, apiError, authorizeAdmin, jsonBody } from "../../../_security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const position = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).strict();
const geometry = z.object({ id: z.string().uuid(), provider: z.string(), previousId: z.string().uuid(),
  slots: z.array(position).length(3) }).strict();
const headers = { "Cache-Control": "private, no-store" };

function failure(error: unknown) {
  return apiError(error instanceof GameTipsError ? new ApiError(error.status, error.message) : error);
}

export async function GET(request: Request) {
  try {
    await authorizeAdmin(request);
    const id = new URL(request.url).searchParams.get("id") ?? "";
    return gameTipsBackgroundPreview(getSqlite(), id);
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    await authorizeAdmin(request, { requireJson: false });
    return Response.json(await uploadGameTipsBackground(getSqlite(), request), { headers });
  } catch (error) { return failure(error); }
}

export async function PUT(request: Request) {
  try {
    await authorizeAdmin(request);
    const input = geometry.safeParse(await jsonBody(request));
    if (!input.success) throw new ApiError(400, "图片位置资料不完整，请重新设置。");
    return Response.json(updateGameTipsBackgroundSlots(getSqlite(), input.data), { headers });
  } catch (error) { return failure(error); }
}
