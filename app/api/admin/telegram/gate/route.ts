import { z } from "zod";
import { saveTelegramJoinGateSettings, telegramJoinGateStatus } from "../../../../lib/telegram-promotions";
import { JoinGateError } from "../../../../lib/telegram-join-gate";
import { ApiError, apiError, authorizeAdmin, jsonBody } from "../../_security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const chatReference = z.string().trim().max(160).refine(value =>
  /^-[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))
  || /^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(value)
  || /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{3,31}\/?$/.test(value), "请填写频道 ID、@用户名或公开 Telegram 链接。");
const requirement = z.object({
  chatId: chatReference,
  label: z.string().trim().min(1).max(80),
  url: z.string().trim().max(160).regex(/^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{3,31}\/?$/),
}).strict();
const configInput = z.object({
  enabled: z.boolean(),
  targetChatId: z.string().trim().max(80).refine(value => value === "" || /^-[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))),
  requiredChats: z.array(requirement).max(8),
  revision: z.string().max(80).optional(),
}).strict().superRefine((value, context) => {
  if (value.enabled && (!value.targetChatId || !value.requiredChats.length)) {
    context.addIssue({ code: "custom", message: "启用前请选择 Hot 频道，并至少添加一个加入条件。" });
  }
});

function respond(body: ReturnType<typeof telegramJoinGateStatus>) {
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
function failure(error: unknown) {
  return apiError(error instanceof JoinGateError ? new ApiError(error.status, error.message) : error);
}

export async function GET(request: Request) {
  try {
    await authorizeAdmin(request);
    return respond(telegramJoinGateStatus());
  } catch (error) { return failure(error); }
}
export async function PUT(request: Request) {
  try {
    await authorizeAdmin(request);
    const result = configInput.safeParse(await jsonBody(request));
    if (!result.success) throw new ApiError(400, "请检查 Hot 频道和必须加入的频道设置。");
    return respond(await saveTelegramJoinGateSettings(result.data));
  } catch (error) { return failure(error); }
}
