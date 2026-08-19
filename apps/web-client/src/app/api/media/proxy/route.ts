import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gatewayUrl = process.env.GATEWAY_HUB_INTERNAL_URL || "http://gateway-hub:8080";
  const { searchParams } = new URL(req.url);
  const targetUrl = searchParams.get("url") || "";
  const name = searchParams.get("name") || "Z";

  try {
    const res = await fetch(
      `${gatewayUrl}/api/media/proxy?url=${encodeURIComponent(targetUrl)}&name=${encodeURIComponent(name)}`,
      { cache: "no-store" }
    );

    if (!res.ok) {
      return new NextResponse("Error loading image", { status: res.status });
    }

    const contentType = res.headers.get("Content-Type") || "image/jpeg";
    const imageBuffer = await res.arrayBuffer();

    return new NextResponse(imageBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (e: any) {
    return new NextResponse(`Media proxy error: ${e.message}`, { status: 500 });
  }
}
