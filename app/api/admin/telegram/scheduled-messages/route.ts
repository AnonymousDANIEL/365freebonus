import { z } from "zod";
import { telegramScheduledMessageStatus, saveTelegramScheduledMessagePlan,
  deleteTelegramScheduledMessagePlan, verifyTelegramScheduledMessageTargets,
  saveTelegramScheduledMessageTarget, deleteTelegramScheduledMessageTarget } from "../../../../lib/telegram-promotions";
import { ScheduledMessageError } from "../../../../lib/telegram-scheduled-messages";
import type { ScheduledMessageTargetKey } from "../../../../lib/telegram-scheduled-messages-types";
import { ApiError, apiError, authorizeAdmin, jsonBody } from "../../_security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const id = z.string().uuid();
const customTargetKey = z.custom<`custom:${string}`>(value =>
  typeof value === "string" && value.startsWith("custom:") && id.safeParse(value.slice(7)).success);
const targetKey: z.ZodType<ScheduledMessageTargetKey> = z.union([z.enum(["official", "group", "hot"]), customTargetKey]);
const fields = {
  name: z.string().trim().min(1).max(100),
  // Send the owner's text verbatim, including spacing and line breaks.
  text: z.string().min(1).max(4096).refine(value => Boolean(value.trim())),
  times: z.array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)).min(1).max(24)
    .refine(values => new Set(values).size === values.length),
  enabled: z.boolean(),
  calendarDate: z.string().regex(/^(?:\d{4}-\d{2}-\d{2})?$/).nullable().optional(),
  targetKeys: z.array(targetKey).min(1).max(23)
    .refine(values => new Set(values).size === values.length).optional(),
  mediaId: id.nullable().optional(),
};
// A stable key from the draft prevents lost HTTP responses creating duplicates.
const create = z.object({ requestId: id, ...fields }).strict();
const update = z.object({ id, revision: id, ...fields }).strict();
const remove = z.object({ id, revision: id }).strict();
const verify = z.object({ action: z.literal("verify") }).strict();
const targetFields = { action: z.literal("upsertTarget"), title: z.string().trim().min(1).max(100),
  address: z.string().trim().min(1).max(150) };
const upsertTarget = z.union([
  z.object({ ...targetFields, requestId: id }).strict(),
  z.object({ ...targetFields, key: customTargetKey, revision: id }).strict(),
]);
const removeTarget = z.object({ targetKey: customTargetKey, revision: id }).strict();
const respond = (body: ReturnType<typeof telegramScheduledMessageStatus>) =>
  Response.json(body, { headers: { "Cache-Control": "no-store" } });
function planPayload<T extends { text: string; mediaId?: string | null }>(input: T): T {
  if (input.mediaId && input.text.length > 1024) throw new ApiError(400, "附上媒体时，文案最多可填写 1,024 字。");
  return input;
}
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
    const target = upsertTarget.safeParse(body);
    if (target.success) {
      const { title, address } = target.data;
      return respond(await saveTelegramScheduledMessageTarget("key" in target.data
        ? { title, address, key: target.data.key, revision: target.data.revision }
        : { title, address, requestId: target.data.requestId }));
    }
    const input = create.safeParse(body);
    if (!input.success) throw new ApiError(400, "请检查文案、发送日期、时间与频道设置。");
    return respond(await saveTelegramScheduledMessagePlan(planPayload(input.data)));
  } catch (error) { return failure(error); }
}

export async function PUT(request: Request) {
  try {
    await authorizeAdmin(request);
    const input = update.safeParse(await jsonBody(request));
    if (!input.success) throw new ApiError(400, "请检查文案、发送日期、时间和计划版本，刷新后再试。");
    return respond(await saveTelegramScheduledMessagePlan(planPayload(input.data)));
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  try {
    await authorizeAdmin(request);
    const body = await jsonBody(request);
    const target = removeTarget.safeParse(body);
    if (target.success) return respond(await deleteTelegramScheduledMessageTarget({ key: target.data.targetKey, revision: target.data.revision }));
    const input = remove.safeParse(body);
    if (!input.success) throw new ApiError(400, "请刷新计划列表后再删除。");
    return respond(await deleteTelegramScheduledMessagePlan(input.data));
  } catch (error) { return failure(error); }
}
