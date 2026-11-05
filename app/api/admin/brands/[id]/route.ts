import { updateBrand, deleteBrand } from "../../../../lib/server-directory";
import { apiError, authorizeAdmin, jsonBody, ApiError, isUniqueConstraint } from "../../_security";
import { brandInput, validate } from "../../_validation";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function PUT(request: Request, context: Context) {
  try {
    await authorizeAdmin(request);
    const { id } = await context.params;
    const input = validate(brandInput, await jsonBody(request));
    try {
      const brand = updateBrand(id, input);
      if (!brand) throw new ApiError(404, "找不到这个品牌。");
      return Response.json({ brand });
    } catch (error) { if (isUniqueConstraint(error)) throw new ApiError(409, "品牌网址标识已被使用，请更换 slug。"); throw error; }
  } catch (error) { return apiError(error); }
}
export async function DELETE(request: Request, context: Context) {
  try {
    await authorizeAdmin(request);
    const { id } = await context.params;
    if (!deleteBrand(id)) throw new ApiError(404, "找不到这个品牌。");
    return Response.json({ ok: true });
  } catch (error) { return apiError(error); }
}
