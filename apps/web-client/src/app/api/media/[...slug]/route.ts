import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { slug: string[] } }) {
  const gatewayUrl = process.env.GATEWAY_HUB_INTERNAL_URL || "http://gateway-hub:8080";
  const mediaPath = params.slug.join("/");

  try {
    const res = await fetch(`${gatewayUrl}/api/media/${mediaPath}`, { cache: "no-store" });
    if (!res.ok) {
      return new NextResponse("Media not found", { status: 404 });
    }

    const contentType = res.headers.get("Content-Type") || "application/octet-stream";
    const imageBuffer = await res.arrayBuffer();

    return new NextResponse(imageBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (e: any) {
    return new NextResponse(`Error loading media: ${e.message}`, { status: 500 });
  }
}
