import { z } from "zod";
import { telegramHotVideoStatus, saveTelegramHotVideoSettings, queueTelegramHotVideo,
  updateTelegramHotVideo, deleteTelegramHotVideo, cancelTelegramHotVideoJob, syncTelegramHotVideoSources } from "../../../../lib/telegram-promotions";
import { HotVideoError } from "../../../../lib/telegram-hot-videos";
import { ApiError, apiError, authorizeAdmin, jsonBody } from "../../_security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const id = z.string().uuid();
const sourceId = z.string().regex(/^-[1-9]\d{0,15}$/).refine(value => Number.isSafeInteger(Number(value)) && Number(value) < -1_000_000_000_000);
const timestamp = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const settings = z.object({ enabled: z.boolean(), targetChatId: z.string().trim().max(80).refine(value =>
  value === "" || /^-[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))),
  intervalHours: z.number().int().min(1).max(24), firstRunAt: timestamp.nullable(), revision: z.string().max(80),
  sources: z.array(sourceId).max(20).refine(values => new Set(values).size === values.length).optional(), markSourceUsed: z.boolean().optional(),
}).strict();
const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sync_sources") }).strict(),
  z.object({ action: z.literal("send"), videoId: id, runAt: timestamp.nullable(), requestId: id }).strict(),
  z.object({ action: z.literal("update"), id, title: z.string().trim().min(1).max(160).optional(), active: z.boolean().optional() }).strict()
    .refine(value => value.title !== undefined || value.active !== undefined),
  z.object({ action: z.literal("delete"), id }).strict(),
  z.object({ action: z.literal("cancel"), id }).strict(),
]);
const respond = (body: ReturnType<typeof telegramHotVideoStatus>) => Response.json(body, { headers: { "Cache-Control": "no-store" } });
function failure(error: unknown) { return apiError(error instanceof HotVideoError ? new ApiError(error.status, error.message) : error); }

export async function GET(request: Request) {
  try { await authorizeAdmin(request); return respond(telegramHotVideoStatus()); }
  catch (error) { return failure(error); }
}
export async function PUT(request: Request) {
  try {
    await authorizeAdmin(request);
    const input = settings.safeParse(await jsonBody(request));
    if (!input.success) throw new ApiError(400, "请检查 Hot 频道、自动发布间隔和首次发送时间。");
    return respond(await saveTelegramHotVideoSettings(input.data));
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    await authorizeAdmin(request);
    const input = action.safeParse(await jsonBody(request));
    if (!input.success) throw new ApiError(400, "请检查视频操作和发送时间。");
    const value = input.data;
    if (value.action === "sync_sources") await syncTelegramHotVideoSources();
    else if (value.action === "send") await queueTelegramHotVideo({ videoId: value.videoId, runAt: value.runAt, requestId: value.requestId });
    else if (value.action === "update") await updateTelegramHotVideo({ id: value.id, title: value.title, active: value.active });
    else if (value.action === "delete") await deleteTelegramHotVideo(value.id);
    else await cancelTelegramHotVideoJob(value.id);
    return respond(telegramHotVideoStatus());
  } catch (error) { return failure(error); }
}
