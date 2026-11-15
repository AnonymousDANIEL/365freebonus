import { getSqlite } from "../../../../../../lib/sqlite";
import { hotVideoUploadStatus, appendHotVideoChunk, cancelHotVideoUpload } from "../../../../../../lib/telegram-hot-video-chunks";
import { HotVideoError } from "../../../../../../lib/telegram-hot-videos";
import { ApiError, apiError, authorizeAdmin } from "../../../../_security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
type Context = { params: Promise<{ id: string }> };
const failure = (error: unknown) => apiError(error instanceof HotVideoError ? new ApiError(error.status, error.message) : error);
async function uploadId(context: Context) {
  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new ApiError(400, "上传编号无效，请重新选择视频。");
  return id;
}
const respond = (body: unknown) => Response.json(body, { headers: { "Cache-Control": "no-store" } });
export async function GET(request: Request, context: Context) {
  try { await authorizeAdmin(request); return respond(await hotVideoUploadStatus(getSqlite(), await uploadId(context))); }
  catch (error) { return failure(error); }
}
export async function PUT(request: Request, context: Context) {
  try {
    await authorizeAdmin(request, { requireJson: false });
    const id = await uploadId(context);
    if ((request.headers.get("content-type") || "").toLowerCase().split(";", 1)[0].trim() !== "application/octet-stream") throw new ApiError(415, "请使用视频分段上传。");
    const rawOffset = request.headers.get("x-video-offset") || "";
    if (!/^(?:0|[1-9]\d{0,9})$/.test(rawOffset)) throw new ApiError(400, "视频分段位置不正确，请重新确认上传进度。");
    return respond(await appendHotVideoChunk(getSqlite(), id, Number(rawOffset), request));
  } catch (error) { return failure(error); }
}
export async function DELETE(request: Request, context: Context) {
  try { await authorizeAdmin(request, { requireJson: false }); await cancelHotVideoUpload(getSqlite(), await uploadId(context)); return respond({ cancelled: true }); }
  catch (error) { return failure(error); }
}
