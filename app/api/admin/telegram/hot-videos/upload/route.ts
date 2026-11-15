import { telegramHotVideoStatus } from "../../../../../lib/telegram-promotions";
import { HotVideoError } from "../../../../../lib/telegram-hot-videos";
import { storeHotVideoUpload } from "../../../../../lib/telegram-hot-video-upload";
import { ApiError, apiError, authorizeAdmin } from "../../../_security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    await authorizeAdmin(request, { requireJson: false });
    await storeHotVideoUpload(request);
    return Response.json(telegramHotVideoStatus(), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error instanceof HotVideoError ? new ApiError(error.status, error.message) : error);
  }
}
