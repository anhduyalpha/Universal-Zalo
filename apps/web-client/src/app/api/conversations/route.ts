import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const gatewayUrl = process.env.GATEWAY_HUB_INTERNAL_URL || "http://gateway-hub:8080";
  try {
    const res = await fetch(`${gatewayUrl}/api/conversations`, { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json([]);
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json([]);
  }
}
