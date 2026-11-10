import { z } from "zod";
import { isSafeSocialUrl } from "../../../lib/directory";
import { isSafeImageUrl } from "../../../lib/image-url";
import { createPopupNotice, deletePopupNotice, readAdminPopupNotices, updatePopupNotice } from "../../../lib/popup-notices";
import { ApiError, apiError, authorizeAdmin, jsonBody } from "../_security";
import { validate } from "../_validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const id = z.number().int().positive().safe();
const noticeInput = z.object({
  title: z.string().trim().min(1).max(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value), "请输入单行标题。"),
  imageUrl: z.string().trim().min(1).max(2048).refine(isSafeImageUrl, "请上传图片或输入 HTTPS 图片链接。"),
  link: z.string().trim().max(2048).refine(value => value === "" || isSafeSocialUrl(value), "请输入完整的 HTTP 或 HTTPS 链接。").default(""),
  enabled: z.boolean(),
  sortOrder: z.number().int().min(0).max(99_999),
}).strict();
const updateInput = noticeInput.extend({ id });
const deleteInput = z.object({ id }).strict();

function respond(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  try {
    await authorizeAdmin(request);
    return respond({ notices: readAdminPopupNotices() });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    await authorizeAdmin(request);
    const input = validate(noticeInput, await jsonBody(request));
    return respond({ notice: createPopupNotice(input) }, 201);
  } catch (error) { return apiError(error); }
}

export async function PUT(request: Request) {
  try {
    await authorizeAdmin(request);
    const input = validate(updateInput, await jsonBody(request));
    const notice = updatePopupNotice(input);
    if (!notice) throw new ApiError(404, "找不到这条弹窗公告。");
    return respond({ notice });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request) {
  try {
    await authorizeAdmin(request);
    const { id: noticeId } = validate(deleteInput, await jsonBody(request));
    if (!deletePopupNotice(noticeId)) throw new ApiError(404, "找不到这条弹窗公告。");
    return respond({ id: noticeId });
  } catch (error) { return apiError(error); }
}
