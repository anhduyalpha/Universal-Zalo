import { NextResponse } from "next/server";

// In-memory or database store for active Push subscriptions
const subscriptions: PushSubscription[] = [];

export async function POST(request: Request) {
  try {
    const sub = await request.json();
    if (!sub || !sub.endpoint) {
      return NextResponse.json({ error: "Invalid subscription payload" }, { status: 400 });
    }

    // Upsert subscription
    const existingIndex = subscriptions.findIndex((s) => s.endpoint === sub.endpoint);
    if (existingIndex >= 0) {
      subscriptions[existingIndex] = sub;
    } else {
      subscriptions.push(sub);
    }

    return NextResponse.json({ success: true, count: subscriptions.length });
  } catch (error) {
    console.error("Failed to save push subscription:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
