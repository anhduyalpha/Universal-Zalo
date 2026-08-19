import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gatewayUrl = process.env.GATEWAY_HUB_INTERNAL_URL || "http://gateway-hub:8080";
  const { searchParams } = new URL(req.url);
  const convId = searchParams.get("conversationId") || "";

  try {
    const res = await fetch(`${gatewayUrl}/api/messages?conversationId=${convId}`, { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json([]);
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json([]);
  }
}
