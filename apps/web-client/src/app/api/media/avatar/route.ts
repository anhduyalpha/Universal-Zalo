import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gatewayUrl = process.env.GATEWAY_HUB_INTERNAL_URL || "http://gateway-hub:8080";
  const { searchParams } = new URL(req.url);
  const contactId = searchParams.get("id") || "";
  const name = searchParams.get("name") || "Z";

  try {
    const upstream = await fetch(
      `${gatewayUrl}/api/media/avatar?id=${encodeURIComponent(contactId)}&name=${encodeURIComponent(name)}`,
      { cache: "no-store" }
    );

    const contentType = upstream.headers.get("Content-Type") || "image/svg+xml";
    const buffer = await upstream.arrayBuffer();

    return new NextResponse(buffer, {
      status: upstream.status,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (e: any) {
    return new NextResponse("Error fetching avatar", { status: 500 });
  }
}
