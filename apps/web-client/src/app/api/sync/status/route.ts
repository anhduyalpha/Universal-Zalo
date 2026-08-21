import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const gatewayUrl = process.env.GATEWAY_HUB_INTERNAL_URL || "http://gateway-hub:8080";
  try {
    const upstream = await fetch(`${gatewayUrl}/api/sync/status`, {
      cache: "no-store",
    });

    if (!upstream.body) {
      return NextResponse.json({ state: "HYDRATED", progress: 100, message: "" });
    }

    return new Response(upstream.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (e: any) {
    return NextResponse.json({ state: "HYDRATED", progress: 100, message: "" });
  }
}
