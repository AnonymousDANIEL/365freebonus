import { z } from "zod";
import { getSqlite } from "../../../../../lib/sqlite";
import { startHotVideoUpload } from "../../../../../lib/telegram-hot-video-chunks";
import { HotVideoError } from "../../../../../lib/telegram-hot-videos";
import { ApiError, apiError, authorizeAdmin, jsonBody } from "../../../_security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const input = z.object({ requestId: z.string().uuid(), title: z.string().trim().min(1).max(160),
  originalName: z.string().min(1).max(255), bytes: z.number().int().min(24).max(50 * 1024 * 1024),
}).strict();
export async function POST(request: Request) {
  try {
    await authorizeAdmin(request);
    const parsed = input.safeParse(await jsonBody(request));
    if (!parsed.success) throw new ApiError(400, "请选择不超过 50 MB 的 MP4 视频，并填写后台名称。");
    return Response.json(await startHotVideoUpload(getSqlite(), parsed.data), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error instanceof HotVideoError ? new ApiError(error.status, error.message) : error); }
}
