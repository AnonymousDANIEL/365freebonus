import { z } from "zod";
import { accountStatus, handleAccountAction, TelegramAccountError } from "../../../../lib/telegram-account";
import { ApiError, apiError, authorizeAdmin, jsonBody } from "../../_security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const actionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sendCode"), apiId: z.number().int().positive().max(2_147_483_647),
    apiHash: z.string().trim().regex(/^[a-fA-F0-9]{32}$/), phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/) }).strict(),
  z.object({ action: z.literal("code"), code: z.string().trim().regex(/^\d{3,12}$/) }).strict(),
  z.object({ action: z.literal("password"), password: z.string().min(1).max(256) }).strict(),
  z.object({ action: z.literal("refresh") }).strict(),
  z.object({ action: z.literal("select"), channelIds: z.array(z.string().regex(/^-100\d{1,13}$/)).max(500)
    .refine(ids => new Set(ids).size === ids.length) }).strict(),
  z.object({ action: z.literal("disconnect") }).strict(),
]);

function respond(status: ReturnType<typeof accountStatus>) {
  return Response.json(status, { headers: { "Cache-Control": "no-store" } });
}

function failure(error: unknown) {
  return apiError(error instanceof TelegramAccountError ? new ApiError(error.status, error.message) : error);
}

export async function GET(request: Request) {
  try {
    await authorizeAdmin(request);
    return respond(accountStatus());
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    await authorizeAdmin(request);
    const parsed = actionInput.safeParse(await jsonBody(request));
    if (!parsed.success) throw new ApiError(400, "请检查 Telegram 个人账号输入内容。");
    return respond(await handleAccountAction(parsed.data));
  } catch (error) { return failure(error); }
}
