import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gatewayUrl = process.env.GATEWAY_HUB_INTERNAL_URL || "http://gateway-hub:8080";
  try {
    const body = await req.json();
    const res = await fetch(`${gatewayUrl}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || "Lỗi tải tệp lên server" }, { status: 500 });
  }
}
