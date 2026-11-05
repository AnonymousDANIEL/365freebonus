import { createBrand, readDirectory } from "../../../lib/server-directory";
import { apiError, authorizeAdmin, jsonBody, ApiError, isUniqueConstraint } from "../_security";
import { brandInput, validate } from "../_validation";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  try { await authorizeAdmin(); return Response.json(await readDirectory(true), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try {
    await authorizeAdmin(request);
    const input = validate(brandInput, await jsonBody(request));
    try { return Response.json({ brand: createBrand({ id: crypto.randomUUID(), ...input }) }, { status: 201 }); }
    catch (error) { if (isUniqueConstraint(error)) throw new ApiError(409, "品牌网址标识已被使用，请更换 slug。"); throw error; }
  } catch (error) { return apiError(error); }
}
