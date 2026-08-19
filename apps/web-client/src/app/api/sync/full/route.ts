import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  const gatewayUrl = process.env.GATEWAY_HUB_INTERNAL_URL || "http://gateway-hub:8080";
  try {
    const res = await fetch(`${gatewayUrl}/api/sync/full-resync`, {
      method: "POST",
      cache: "no-store",
    });
    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json({ success: false, error: errText }, { status: res.status });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || "Lỗi kết nối Gateway Hub" }, { status: 500 });
  }
}
