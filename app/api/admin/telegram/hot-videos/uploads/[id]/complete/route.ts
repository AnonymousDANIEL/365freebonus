import { getSqlite } from "../../../../../../../lib/sqlite";
import { finalizeHotVideoUpload } from "../../../../../../../lib/telegram-hot-video-chunks";
import { telegramHotVideoStatus } from "../../../../../../../lib/telegram-promotions";
import { HotVideoError } from "../../../../../../../lib/telegram-hot-videos";
import { ApiError, apiError, authorizeAdmin } from "../../../../../_security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await authorizeAdmin(request, { requireJson: false });
    const { id } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new ApiError(400, "上传编号无效。");
    await finalizeHotVideoUpload(getSqlite(), id);
    return Response.json(telegramHotVideoStatus(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error instanceof HotVideoError ? new ApiError(error.status, error.message) : error); }
}
