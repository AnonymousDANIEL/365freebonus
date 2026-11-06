import { ImageMediaError, readImageUpload, saveImage } from "../../../lib/image-media";
import { apiError, ApiError, authorizeAdmin } from "../_security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await authorizeAdmin(request, { requireJson: false });
    const url = await saveImage(await readImageUpload(request));
    return Response.json({ url }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error instanceof ImageMediaError ? new ApiError(error.status, error.message) : error); }
}
