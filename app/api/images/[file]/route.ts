import { openImage } from "../../../lib/image-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  try {
    const image = await openImage((await params).file);
    if (!image) return new Response(null, { status: 404 });
    return new Response(image.stream, { headers: {
      "Content-Type": image.mime,
      "Content-Length": String(image.size),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    } });
  } catch {
    console.error("Unable to serve uploaded image.");
    return new Response(null, { status: 500 });
  }
}
