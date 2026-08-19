import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { title, text, conversationId } = body;

    // Web push payload
    const payload = {
      title: title || "Universal Zalo",
      body: text || "Bạn có tin nhắn mới",
      icon: "/icon-192.png",
      data: { conversationId: conversationId || "general", url: "/" },
    };

    return NextResponse.json({ success: true, payload });
  } catch (error) {
    console.error("Failed to broadcast push notification:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
