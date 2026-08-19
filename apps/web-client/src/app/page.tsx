"use client";

import React, { useState, useEffect, useRef } from "react";
import { db, LocalMessage } from "../lib/dexie_db";
import { useLiveQuery } from "dexie-react-hooks";
import { nanoid } from "nanoid";

export default function ChatDashboard() {
  const [inputText, setInputText] = useState("");
  const [wsStatus, setWsStatus] = useState<"CONNECTED" | "DISCONNECTED" | "CONNECTING">("CONNECTING");
  const [showQrModal, setShowQrModal] = useState(false);
  const [qrTimestamp, setQrTimestamp] = useState(Date.now());
  const wsRef = useRef<WebSocket | null>(null);

  const messages = useLiveQuery(() => db.messages.orderBy("timestamp").toArray(), []) || [];

  // Tự động phát hiện Host để kết nối WebSocket và lấy QR
  const [hubHost, setHubHost] = useState("127.0.0.1");

  useEffect(() => {
    if (typeof window !== "undefined") {
      const hostname = window.location.hostname || "127.0.0.1";
      setHubHost(hostname);

      const wsUrl = `ws://${hostname}:8080`;
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
              type: "TEXT",
            });
          }
        } catch (e) {
          console.error("Failed to parse websocket frame:", e);
        }
      };

      return () => {
        ws.close();
      };
    }
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
      type: "TEXT",
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
    <div style={{ maxWidth: 850, margin: "20px auto", background: "#fff", borderRadius: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.1)", overflow: "hidden", display: "flex", flexDirection: "column", height: "90vh", position: "relative" }}>
      {/* Header */}
      <div style={{ padding: "14px 20px", borderBottom: "1px solid #e5e7eb", background: "#0068ff", color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Universal Zalo Multi-Device Web Client</h2>
          <small style={{ opacity: 0.85 }}>Sub-Client PWA Session</small>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            onClick={() => {
              setQrTimestamp(Date.now());
              setShowQrModal(true);
            }}
            style={{ padding: "6px 14px", background: "#ffffff", color: "#0068ff", border: "none", borderRadius: 18, fontWeight: 600, fontSize: 13, cursor: "pointer", boxShadow: "0 2px 4px rgba(0,0,0,0.1)" }}
          >
            📲 Quét mã QR Zalo
          </button>
          <span style={{ fontSize: 12, padding: "4px 10px", borderRadius: 12, background: wsStatus === "CONNECTED" ? "#10b981" : "#ef4444", fontWeight: 500 }}>
            {wsStatus}
          </span>
        </div>
      </div>

      {/* QR Modal */}
      {showQrModal && (
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, backdropFilter: "blur(4px)" }}>
          <div style={{ background: "#fff", padding: 24, borderRadius: 16, width: 440, maxWidth: "90%", textAlign: "center", boxShadow: "0 10px 25px rgba(0,0,0,0.2)" }}>
            <h3 style={{ margin: "0 0 10px 0", color: "#1f2937", fontSize: 18 }}>Quét mã QR để Đăng nhập Zalo</h3>
            <p style={{ margin: "0 0 16px 0", fontSize: 13, color: "#6b7280" }}>
              Mở ứng dụng Zalo trên điện thoại $\rightarrow$ Chọn biểu tượng Quét mã QR trên đầu màn hình.
            </p>

            <div style={{ minHeight: 280, display: "flex", alignItems: "center", justifyContent: "center", background: "#f9fafb", borderRadius: 12, overflow: "hidden", border: "1px solid #e5e7eb" }}>
              <img
                src={`http://${hubHost}:8080/qr?t=${qrTimestamp}`}
                alt="Zalo QR Code Live"
                style={{ width: "100%", height: "auto", display: "block" }}
                onError={(e) => {
                  (e.target as HTMLElement).style.display = "none";
                }}
              />
            </div>

            <div style={{ marginTop: 18, display: "flex", gap: 10, justifyContent: "center" }}>
              <button
                onClick={() => setQrTimestamp(Date.now())}
                style={{ padding: "8px 18px", background: "#f3f4f6", border: "1px solid #d1d5db", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer" }}
              >
                🔄 Làm mới ảnh
              </button>
              <button
                onClick={() => setShowQrModal(false)}
                style={{ padding: "8px 22px", background: "#0068ff", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
              >
                Đã đăng nhập xong
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Messages View */}
      <div style={{ flex: 1, padding: 20, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, background: "#f8fafc" }}>
        {messages.length === 0 ? (
          <div style={{ textAlign: "center", color: "#9ca3af", marginTop: 60, fontSize: 14 }}>
            Chưa có tin nhắn. Hãy bấm <b>"📲 Quét mã QR Zalo"</b> ở góc trên để liên kết tài khoản!
          </div>
        ) : (
          messages.map((m) => (
            <div
              key={m.msgId}
              style={{
                alignSelf: m.sender === "ME" ? "flex-end" : "flex-start",
                maxWidth: "70%",
                background: m.sender === "ME" ? "#0068ff" : "#ffffff",
                color: m.sender === "ME" ? "#ffffff" : "#1f2937",
                padding: "10px 14px",
                borderRadius: 14,
                borderBottomRightRadius: m.sender === "ME" ? 2 : 14,
                borderBottomLeftRadius: m.sender === "OTHER" ? 2 : 14,
                boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
              }}
            >
              <div style={{ fontSize: 14 }}>{m.textContent}</div>
              <div style={{ fontSize: 10, color: m.sender === "ME" ? "rgba(255,255,255,0.75)" : "#9ca3af", marginTop: 4, textAlign: "right" }}>
                {new Date(m.timestamp).toLocaleTimeString()} {m.sender === "ME" && (m.status === "SENDING" ? "⏳" : "✓✓")}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Input Form */}
      <form onSubmit={handleSendMessage} style={{ padding: "14px 18px", borderTop: "1px solid #e5e7eb", background: "#ffffff", display: "flex", gap: 10 }}>
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Nhập tin nhắn Zalo..."
          style={{ flex: 1, padding: "12px 18px", borderRadius: 24, border: "1px solid #d1d5db", outline: "none", fontSize: 14 }}
        />
        <button
          type="submit"
          style={{ padding: "0 24px", background: "#0068ff", color: "#fff", border: "none", borderRadius: 24, fontWeight: "bold", fontSize: 14, cursor: "pointer" }}
        >
          Gửi
        </button>
      </form>
    </div>
  );
}
