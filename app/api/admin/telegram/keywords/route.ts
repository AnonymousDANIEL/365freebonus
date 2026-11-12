import { z } from "zod";
import { createTelegramKeywordRule, deleteTelegramKeywordRule, listTelegramKeywordRules, normalizeTelegramKeyword, updateTelegramKeywordRule } from "../../../../lib/telegram-keywords";
import { ApiError, apiError, authorizeAdmin, isUniqueConstraint, jsonBody } from "../../_security";
import { validate } from "../../_validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const id = z.number().int().safe().positive();
const ruleInput = z.object({
  keyword: z.string().trim().min(1).max(120).refine(keyword => normalizeTelegramKeyword(keyword).length > 0, "请输入关键词。"),
  matchMode: z.enum(["exact", "contains"]),
  response: z.string().trim().min(1).max(2_000),
  showButton: z.boolean().optional(),
}).strict();
const updateInput = ruleInput.extend({ id });
const deleteInput = z.object({ id }).strict();

function respond(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function keywordError(error: unknown) {
  if (isUniqueConstraint(error)) return apiError(new ApiError(409, "同一匹配方式下已存在这个关键词。"));
  return apiError(error);
}

export async function GET(request: Request) {
  try {
    await authorizeAdmin(request);
    return respond({ rules: listTelegramKeywordRules() });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    await authorizeAdmin(request);
    const input = validate(ruleInput, await jsonBody(request));
    return respond({ rule: createTelegramKeywordRule(input) }, 201);
  } catch (error) { return keywordError(error); }
}

export async function PUT(request: Request) {
  try {
    await authorizeAdmin(request);
    const { id, ...input } = validate(updateInput, await jsonBody(request));
    const rule = updateTelegramKeywordRule(id, input);
    if (!rule) throw new ApiError(404, "找不到这条关键词规则。请刷新后重试。");
    return respond({ rule });
  } catch (error) { return keywordError(error); }
}

export async function DELETE(request: Request) {
  try {
    await authorizeAdmin(request);
    const { id } = validate(deleteInput, await jsonBody(request));
    if (!deleteTelegramKeywordRule(id)) throw new ApiError(404, "找不到这条关键词规则。请刷新后重试。");
    return respond({ id });
  } catch (error) { return apiError(error); }
}
