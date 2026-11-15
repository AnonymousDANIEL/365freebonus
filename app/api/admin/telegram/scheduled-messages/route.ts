import { z } from "zod";
import { telegramScheduledMessageStatus, saveTelegramScheduledMessagePlan,
  deleteTelegramScheduledMessagePlan, verifyTelegramScheduledMessageTargets } from "../../../../lib/telegram-promotions";
import { ScheduledMessageError } from "../../../../lib/telegram-scheduled-messages";
import { ApiError, apiError, authorizeAdmin, jsonBody } from "../../_security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const id = z.string().uuid();
const fields = {
  name: z.string().trim().min(1).max(100),
  // Send the owner's text verbatim, including spacing and line breaks.
  text: z.string().min(1).max(4096).refine(value => Boolean(value.trim())),
  times: z.array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)).min(1).max(24)
    .refine(values => new Set(values).size === values.length),
  enabled: z.boolean(),
};
// A stable key from the draft prevents lost HTTP responses creating duplicates.
const create = z.object({ requestId: id, ...fields }).strict();
const update = z.object({ id, revision: id, ...fields }).strict();
const remove = z.object({ id, revision: id }).strict();
const verify = z.object({ action: z.literal("verify") }).strict();
const respond = (body: ReturnType<typeof telegramScheduledMessageStatus>) =>
  Response.json(body, { headers: { "Cache-Control": "no-store" } });
function failure(error: unknown) {
  return apiError(error instanceof ScheduledMessageError ? new ApiError(error.status, error.message) : error);
}

export async function GET(request: Request) {
  try { await authorizeAdmin(request); return respond(telegramScheduledMessageStatus()); }
  catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    await authorizeAdmin(request);
    const body = await jsonBody(request);
    if (verify.safeParse(body).success) return respond(await verifyTelegramScheduledMessageTargets());
    const input = create.safeParse(body);
    if (!input.success) throw new ApiError(400, "请填写文案名称、文案和不重复的每日发送时间。");
    return respond(await saveTelegramScheduledMessagePlan(input.data));
  } catch (error) { return failure(error); }
}

export async function PUT(request: Request) {
  try {
    await authorizeAdmin(request);
    const input = update.safeParse(await jsonBody(request));
    if (!input.success) throw new ApiError(400, "请检查文案、每日时间和计划版本，刷新后再试。");
    return respond(await saveTelegramScheduledMessagePlan(input.data));
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  try {
    await authorizeAdmin(request);
    const input = remove.safeParse(await jsonBody(request));
    if (!input.success) throw new ApiError(400, "请刷新计划列表后再删除。");
    return respond(await deleteTelegramScheduledMessagePlan(input.data));
  } catch (error) { return failure(error); }
}
