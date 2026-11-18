import { getSqlite } from "../../../../../lib/sqlite";
import { ScheduledMessageMediaError, scheduledMessageMediaPreview, storeScheduledMessageMedia } from "../../../../../lib/telegram-scheduled-media";
import { ApiError, apiError, authorizeAdmin } from "../../../_security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function failure(error: unknown) {
  return apiError(error instanceof ScheduledMessageMediaError ? new ApiError(error.status, error.message) : error);
}

export async function GET(request: Request) {
  try {
    await authorizeAdmin(request);
    const id = new URL(request.url).searchParams.get("id") ?? "";
    return await scheduledMessageMediaPreview(getSqlite(), id, request.headers.get("range"));
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    await authorizeAdmin(request, { requireJson: false });
    const result = await storeScheduledMessageMedia(getSqlite(), request);
    return Response.json(result, { status: "kind" in result ? 201 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
