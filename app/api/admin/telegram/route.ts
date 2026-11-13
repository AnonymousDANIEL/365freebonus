import { z } from "zod";
import { saveTelegramPromotionSettings, telegramPromotionStatus, TelegramSettingsError } from "../../../lib/telegram-promotions";
import { ApiError, apiError, authorizeAdmin, jsonBody } from "../_security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const configInput = z.object({
  enabled: z.boolean(),
  chatId: z.string().trim().max(80),
  token: z.string().trim().max(160).optional(),
  promotionMessage: z.string().trim().max(2_000).optional(),
  relay: z.object({ enabled: z.boolean(), chatId: z.string().trim().max(80) }).strict().optional(),
  welcome: z.object({
    enabled: z.boolean(),
    chatId: z.string().trim().max(80),
    message: z.string().trim().max(2_000),
  }).strict().optional(),
  chatBot: z.object({
    token: z.string().trim().max(160).optional(),
    keywordEnabled: z.boolean(),
    privateEnabled: z.boolean().optional(),
    privateStartMessage: z.string().trim().max(2_000).optional(),
    updates: z.object({ enabled: z.boolean() }).strict().optional(),
    followup: z.object({
      enabled: z.boolean(),
      message: z.string().trim().max(2_000),
    }).strict().optional(),
  }).strict().optional(),
}).strict();

function respond(status: ReturnType<typeof telegramPromotionStatus>) {
  return Response.json(status, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  try {
    await authorizeAdmin(request);
    return respond(telegramPromotionStatus());
  } catch (error) { return apiError(error); }
}

export async function PUT(request: Request) {
  try {
    await authorizeAdmin(request);
    const result = configInput.safeParse(await jsonBody(request));
    if (!result.success) throw new ApiError(400, "请检查 Telegram 设置。");
    return respond(await saveTelegramPromotionSettings(result.data));
  } catch (error) {
    return apiError(error instanceof TelegramSettingsError ? new ApiError(error.status, error.message) : error);
  }
}
