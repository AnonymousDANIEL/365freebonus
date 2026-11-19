export function GET() {
  return new Response(null, {
    status: 307,
    headers: { Location: "/", "Cache-Control": "no-store" },
  });
}

export const HEAD = GET;
