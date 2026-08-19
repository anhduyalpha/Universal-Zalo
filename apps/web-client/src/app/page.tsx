"use client";

import React, { useState, useEffect, useRef } from "react";
import { db, LocalMessage } from "../lib/dexie_db";
import { useLiveQuery } from "dexie-react-hooks";
import { nanoid } from "nanoid";

export default function ChatDashboard() {
  const [inputText, setInputText] = useState("");
  const [wsStatus, setWsStatus] = useState<"CONNECTED" | "DISCONNECTED" | "CONNECTING">("CONNECTING");
  const wsRef = useRef<WebSocket | null>(null);

  const messages = useLiveQuery(() => db.messages.orderBy("timestamp").toArray(), []) || [];

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.hostname || "127.0.0.1";
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL || `${protocol}//${host}:8080`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setWsStatus("CONNECTED");
    ws.onclose = () => setWsStatus("DISCONNECTED");

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.event === "MESSAGE_FANOUT") {
          await db.messages.add({
            msgId: data.msgId,
            conversationId: data.conversationId || "general",
            textContent: data.textContent,
            sender: "OTHER",
            status: "DELIVERED",
            timestamp: data.hlc?.physicalTime || Date.now(),
          });
        }
      } catch (e) {
        console.error("Failed to parse websocket frame:", e);
      }
    };

    return () => {
      ws.close();
    };
  }, []);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    const tempMsgId = nanoid();
    const now = Date.now();

    // 1. Lưu ngay vào IndexedDB nội bộ với trạng thái SENDING
    await db.messages.add({
      msgId: tempMsgId,
      conversationId: "general",
      textContent: inputText,
      sender: "ME",
      status: "SENDING",
      timestamp: now,
    });

    // 2. Gửi qua WebSocket
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "SEND_MESSAGE",
          conversationId: "general",
          textContent: inputText,
          idempotencyKey: tempMsgId,
        })
      );
    }

    setInputText("");
  };

  return (
    <div style={{ maxWidth: 800, margin: "20px auto", background: "#fff", borderRadius: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.08)", overflow: "hidden", display: "flex", flexDirection: "column", height: "90vh" }}>
      {/* Header */}
      <div style={{ padding: "16px 20px", borderBottom: "1px solid #e5e7eb", background: "#0068ff", color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>Universal Zalo Multi-Device Web Client</h2>
          <small style={{ opacity: 0.85 }}>Sub-Client PWA Session</small>
        </div>
        <span style={{ fontSize: 12, padding: "4px 8px", borderRadius: 12, background: wsStatus === "CONNECTED" ? "#10b981" : "#ef4444" }}>
          {wsStatus}
        </span>
      </div>

      {/* Messages View */}
      <div style={{ flex: 1, padding: 20, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
        {messages.length === 0 ? (
          <div style={{ textAlign: "center", color: "#9ca3af", marginTop: 40 }}>Chưa có tin nhắn. Hãy gửi tin nhắn đầu tiên!</div>
        ) : (
          messages.map((m) => (
            <div
              key={m.msgId}
              style={{
                alignSelf: m.sender === "ME" ? "flex-end" : "flex-start",
                maxWidth: "70%",
                background: m.sender === "ME" ? "#e0f2fe" : "#f3f4f6",
                color: "#1f2937",
                padding: "10px 14px",
                borderRadius: 14,
                borderBottomRightRadius: m.sender === "ME" ? 2 : 14,
                borderBottomLeftRadius: m.sender === "OTHER" ? 2 : 14,
              }}
            >
              <div style={{ fontSize: 14 }}>{m.textContent}</div>
              <div style={{ fontSize: 10, color: "#6b7280", marginTop: 4, textAlign: "right" }}>
                {new Date(m.timestamp).toLocaleTimeString()} {m.sender === "ME" && (m.status === "SENDING" ? "⏳" : "✓✓")}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Input Form */}
      <form onSubmit={handleSendMessage} style={{ padding: 16, borderTop: "1px solid #e5e7eb", display: "flex", gap: 10 }}>
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Nhập tin nhắn..."
          style={{ flex: 1, padding: "12px 16px", borderRadius: 24, border: "1px solid #d1d5db", outline: "none", fontSize: 14 }}
        />
        <button
          type="submit"
          style={{ padding: "0 24px", background: "#0068ff", color: "#fff", border: "none", borderRadius: 24, fontWeight: "bold", cursor: "pointer" }}
        >
          Gửi
        </button>
      </form>
    </div>
  );
}
