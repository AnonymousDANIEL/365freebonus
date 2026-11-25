import { z } from "zod";
import { getSqlite } from "../../../../../lib/sqlite";
import { GameTipsError, gameTipsLogoPreview, removeGameTipsPlatformPart, updateGameTipsPlatform, uploadGameTipsLogo } from "../../../../../lib/telegram-game-tips";
import { ApiError, apiError, authorizeAdmin, jsonBody } from "../../../_security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const platform = { provider: z.string(), previousId: z.union([z.string().uuid(), z.literal("")]) };
const rename = z.object({ ...platform, name: z.string() }).strict();
const remove = z.object({ ...platform, action: z.enum(["removeLogo", "deletePlatform"]) }).strict();
const headers = { "Cache-Control": "private, no-store" };

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
    return Response.json(await uploadGameTipsLogo(getSqlite(), request), { headers });
  } catch (error) { return failure(error); }
}

export async function PUT(request: Request) {
  try {
    await authorizeAdmin(request);
    const input = rename.safeParse(await jsonBody(request));
    if (!input.success) throw new ApiError(400, "请检查平台名称和 Logo 资料。");
    return Response.json(updateGameTipsPlatform(getSqlite(), input.data), { headers });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  try {
    await authorizeAdmin(request);
    const input = remove.safeParse(await jsonBody(request));
    if (!input.success) throw new ApiError(400, "请刷新图库后再操作。");
    return Response.json(removeGameTipsPlatformPart(getSqlite(), input.data), { headers });
  } catch (error) { return failure(error); }
}
