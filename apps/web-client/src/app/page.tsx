"use client";

import React, { useState, useEffect, useRef } from "react";
import { db, Conversation, LocalMessage, seedInitialConversations } from "../lib/dexie_db";
import { useLiveQuery } from "dexie-react-hooks";
import { nanoid } from "nanoid";
import Link from "next/link";

export default function ZaloMultiDeviceApp() {
  const [activeConvId, setActiveConvId] = useState<string>("conv_1");
  const [inputText, setInputText] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [wsStatus, setWsStatus] = useState<"CONNECTED" | "DISCONNECTED" | "CONNECTING">("CONNECTING");
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);
  const [navTab, setNavTab] = useState<"MESSAGES" | "CONTACTS" | "SETTINGS">("MESSAGES");

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Lấy dữ liệu từ IndexedDB (Dexie)
  const localConversations = useLiveQuery(() => db.conversations.toArray(), []) || [];
  const activeMessages = useLiveQuery(
    () => db.messages.where("conversationId").equals(activeConvId).sortBy("timestamp"),
    [activeConvId]
  ) || [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeMessages]);

  // Đồng bộ danh sách hội thoại từ Server Volume & Chromium
  const fetchLiveConversations = async () => {
    try {
      const res = await fetch("/api/conversations");
      if (res.ok) {
        const liveConvs: Conversation[] = await res.json();
        if (liveConvs && liveConvs.length > 0) {
          for (const conv of liveConvs) {
            await db.conversations.put(conv);
          }
          if (!activeConvId && liveConvs[0]) {
            setActiveConvId(liveConvs[0].id);
          }
        }
      }
    } catch (e) {
      console.warn("Failed to fetch live conversations:", e);
    }
  };

  // Tải toàn bộ tin nhắn & Media đã lưu trên Server Volume cho cuộc hội thoại hiện tại
  const fetchServerMessages = async (convId: string) => {
    try {
      const res = await fetch(`/api/messages?conversationId=${convId}`);
      if (res.ok) {
        const msgs: LocalMessage[] = await res.json();
        if (msgs && msgs.length > 0) {
          for (const msg of msgs) {
            await db.messages.put({
              msgId: msg.msgId,
              conversationId: msg.conversationId || convId,
              textContent: msg.textContent,
              sender: msg.sender,
              status: msg.status || "DELIVERED",
              timestamp: msg.timestamp,
              type: msg.type || "TEXT",
              mediaUrl: msg.mediaUrl,
            });
          }
        }
      }
    } catch (e) {}
  };

  useEffect(() => {
    if (activeConvId) {
      fetchServerMessages(activeConvId);
    }
  }, [activeConvId]);

  // Khởi tạo và kết nối WebSocket Gateway
  useEffect(() => {
    if (typeof window !== "undefined") {
      seedInitialConversations();
      fetchLiveConversations();

      const hostname = window.location.hostname || "127.0.0.1";
      const wsUrl = `ws://${hostname}:8080`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => setWsStatus("CONNECTED");
      ws.onclose = () => setWsStatus("DISCONNECTED");

      ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.event === "MESSAGE_FANOUT") {
            const convId = data.conversationId || activeConvId || "conv_1";
            await db.messages.add({
              msgId: data.msgId,
              conversationId: convId,
              textContent: data.textContent,
              sender: data.sender || "OTHER",
              status: "DELIVERED",
              timestamp: data.hlc?.physicalTime || Date.now(),
              type: data.type || "TEXT",
              mediaUrl: data.mediaUrl,
            });

            await db.conversations.update(convId, {
              lastMessage: data.textContent || `[${data.type || "Media"}]`,
              lastTimestamp: Date.now(),
            });
          }
        } catch (e) {
          console.error("Failed to parse websocket frame:", e);
        }
      };

      const timer = setInterval(fetchLiveConversations, 8000);

      return () => {
        clearInterval(timer);
        ws.close();
      };
    }
  }, [activeConvId]);

  // Gửi tin nhắn
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    const tempMsgId = nanoid();
    const now = Date.now();
    const targetConvId = activeConvId || "conv_1";

    await db.messages.add({
      msgId: tempMsgId,
      conversationId: targetConvId,
      textContent: inputText,
      sender: "ME",
      status: "SENDING",
      timestamp: now,
      type: "TEXT",
    });

    await db.conversations.update(targetConvId, {
      lastMessage: `Bạn: ${inputText}`,
      lastTimestamp: now,
    });

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "SEND_MESSAGE",
          conversationId: targetConvId,
          textContent: inputText,
          idempotencyKey: tempMsgId,
        })
      );
    }

    setInputText("");
  };

  // Kích hoạt đồng bộ tin nhắn từ Zalo Cloud
  const handleTriggerSync = async () => {
    setIsSyncing(true);
    setSyncFeedback("Đang kích hoạt đồng bộ tin nhắn từ Zalo Cloud...");
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      setSyncFeedback(data.message || "Đã gửi lệnh đồng bộ.");
      await fetchLiveConversations();
      setTimeout(() => setSyncFeedback(null), 5000);
    } catch (e: any) {
      setSyncFeedback(`Lỗi: ${e.message}`);
      setTimeout(() => setSyncFeedback(null), 5000);
    } finally {
      setIsSyncing(false);
    }
  };

  const filteredConversations = localConversations.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const currentActiveConv = localConversations.find((c) => c.id === activeConvId) || localConversations[0];

  return (
    <div style={{ display: "flex", height: "100vh", width: "100vw", overflow: "hidden", background: "#f0f2f5", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      {/* 1. Thanh Menu Điều Hướng Cột Trái Cùng */}
      <div style={{ width: 64, background: "#0068ff", display: "flex", flexDirection: "column", alignItems: "center", padding: "16px 0", justifyContent: "space-between", flexShrink: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, width: "100%" }}>
          <div style={{ width: 44, height: 44, borderRadius: "50%", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "bold", color: "#0068ff", fontSize: 18, boxShadow: "0 2px 6px rgba(0,0,0,0.15)" }}>
            Z
          </div>

          <button
            onClick={() => setNavTab("MESSAGES")}
            title="Tin nhắn"
            style={{ width: 44, height: 44, borderRadius: 12, background: navTab === "MESSAGES" ? "rgba(255,255,255,0.2)" : "transparent", border: "none", color: "#fff", fontSize: 20, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            💬
          </button>
          <button
            onClick={() => setNavTab("CONTACTS")}
            title="Danh bạ"
            style={{ width: 44, height: 44, borderRadius: 12, background: navTab === "CONTACTS" ? "rgba(255,255,255,0.2)" : "transparent", border: "none", color: "#fff", fontSize: 20, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            👥
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
          <Link
            href="/session"
            title="Xem màn hình Master Session"
            style={{ width: 44, height: 44, borderRadius: 12, background: "rgba(255,255,255,0.15)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none", fontSize: 18 }}
          >
            🖥️
          </Link>
          <div
            title={`Trạng thái kết nối: ${wsStatus}`}
            style={{ width: 12, height: 12, borderRadius: "50%", background: wsStatus === "CONNECTED" ? "#10b981" : "#ef4444", boxShadow: "0 0 6px rgba(0,0,0,0.3)" }}
          />
        </div>
      </div>

      {/* 2. Cột Danh Sách Hội Thoại với Cuộn Mượt */}
      <div style={{ width: 340, background: "#ffffff", borderRight: "1px solid #e5e7eb", display: "flex", flexDirection: "column", flexShrink: 0, height: "100%" }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid #f1f5f9", flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#1e293b" }}>Hội thoại</h2>
            <button
              onClick={handleTriggerSync}
              disabled={isSyncing}
              title="Đồng bộ danh sách từ Zalo Web"
              style={{ padding: "4px 10px", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 14, fontSize: 12, fontWeight: 600, color: "#0068ff", cursor: "pointer" }}
            >
              {isSyncing ? "⏳ Đang sync..." : "🔄 Đồng bộ"}
            </button>
          </div>
          <input
            type="text"
            placeholder="🔍 Tìm kiếm tin nhắn, liên hệ..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ width: "100%", padding: "8px 14px", background: "#f1f5f9", border: "none", borderRadius: 8, outline: "none", fontSize: 13, boxSizing: "border-box" }}
          />
        </div>

        {syncFeedback && (
          <div style={{ padding: "8px 14px", background: "#e0f2fe", fontSize: 12, color: "#0369a1", borderBottom: "1px solid #bae6fd", flexShrink: 0 }}>
            💡 {syncFeedback}
          </div>
        )}

        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {filteredConversations.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 20px", color: "#94a3b8", fontSize: 14 }}>
              Đang tải danh sách hội thoại từ Server...
            </div>
          ) : (
            filteredConversations.map((conv) => {
              const isSelected = conv.id === activeConvId;
              return (
                <div
                  key={conv.id}
                  onClick={() => setActiveConvId(conv.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "12px 16px",
                    gap: 12,
                    cursor: "pointer",
                    background: isSelected ? "#e5efff" : "transparent",
                    borderBottom: "1px solid #f8fafc",
                    transition: "background 0.15s ease",
                  }}
                >
                  <img
                    src={conv.avatar}
                    alt={conv.name}
                    style={{ width: 44, height: 44, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(conv.name)}`;
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                      <span style={{ fontSize: 14, fontWeight: isSelected ? 700 : 600, color: "#1e293b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {conv.name}
                      </span>
                      <span style={{ fontSize: 11, color: "#94a3b8", flexShrink: 0 }}>
                        {new Date(conv.lastTimestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: isSelected ? "#0068ff" : "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {conv.lastMessage}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 3. Khung Chat Chính (Main Chat Area) */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#ffffff", height: "100%", minWidth: 0 }}>
        {/* Chat Header */}
        <div style={{ height: 64, padding: "0 24px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#ffffff", flexShrink: 0 }}>
          {currentActiveConv ? (
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <img
                src={currentActiveConv.avatar}
                alt={currentActiveConv.name}
                style={{ width: 42, height: 42, borderRadius: "50%", objectFit: "cover" }}
              />
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#1e293b" }}>{currentActiveConv.name}</div>
                <div style={{ fontSize: 12, color: "#10b981", display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10b981" }}></span>
                  Đang hoạt động (Lưu vĩnh viễn trên Server Volume)
                </div>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 16, fontWeight: 600, color: "#64748b" }}>Chọn cuộc trò chuyện để bắt đầu</div>
          )}

          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={handleTriggerSync}
              style={{ padding: "7px 14px", background: "#f1f5f9", color: "#0068ff", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
            >
              ⚡ Đồng bộ tin nhắn
            </button>
            <Link
              href="/session"
              style={{ padding: "7px 14px", background: "#0068ff", color: "#fff", textDecoration: "none", borderRadius: 8, fontSize: 13, fontWeight: 600 }}
            >
              🖥️ Xem Master View
            </Link>
          </div>
        </div>

        {/* Messages Stream View hỗ trợ hiển thị Media (Ảnh, Video, Audio) */}
        <div style={{ flex: 1, padding: "20px 24px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, background: "#f8fafc", minHeight: 0 }}>
          {activeMessages.length === 0 ? (
            <div style={{ margin: "auto", textAlign: "center", color: "#94a3b8" }}>
              <div style={{ fontSize: 40, marginBottom: 10 }}>💬</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#475569" }}>Chưa có tin nhắn trong cuộc trò chuyện này</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>Hãy gửi tin nhắn đầu tiên bên dưới!</div>
            </div>
          ) : (
            activeMessages.map((m) => (
              <div
                key={m.msgId}
                style={{
                  alignSelf: m.sender === "ME" ? "flex-end" : "flex-start",
                  maxWidth: "65%",
                  background: m.sender === "ME" ? "#0068ff" : "#ffffff",
                  color: m.sender === "ME" ? "#ffffff" : "#1e293b",
                  padding: "10px 16px",
                  borderRadius: 16,
                  borderBottomRightRadius: m.sender === "ME" ? 2 : 16,
                  borderBottomLeftRadius: m.sender === "OTHER" ? 2 : 16,
                  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
                }}
              >
                {/* Media Content (Ảnh / Video / Audio) */}
                {m.mediaUrl && m.type === "IMAGE" && (
                  <img
                    src={m.mediaUrl}
                    alt="Media Attachment"
                    style={{ maxWidth: "100%", maxHeight: 260, borderRadius: 8, marginBottom: 6, display: "block", objectFit: "contain" }}
                  />
                )}
                {m.mediaUrl && m.type === "VIDEO" && (
                  <video
                    controls
                    src={m.mediaUrl}
                    style={{ maxWidth: "100%", maxHeight: 260, borderRadius: 8, marginBottom: 6, display: "block" }}
                  />
                )}
                {m.mediaUrl && m.type === "VOICE" && (
                  <audio controls src={m.mediaUrl} style={{ width: "100%", marginBottom: 6 }} />
                )}

                {/* Text Content */}
                {m.textContent && (
                  <div style={{ fontSize: 14, lineHeight: 1.5, wordBreak: "break-word" }}>{m.textContent}</div>
                )}

                <div style={{ fontSize: 10, color: m.sender === "ME" ? "rgba(255,255,255,0.75)" : "#94a3b8", marginTop: 4, textAlign: "right" }}>
                  {new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} {m.sender === "ME" && (m.status === "SENDING" ? "⏳" : "✓✓")}
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Composer */}
        <form onSubmit={handleSendMessage} style={{ padding: "14px 20px", borderTop: "1px solid #e5e7eb", background: "#ffffff", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
          <button type="button" title="Gửi ảnh / Tệp" style={{ background: "transparent", border: "none", fontSize: 20, cursor: "pointer", color: "#64748b" }}>
            📎
          </button>
          <button type="button" title="Emoji & Sticker" style={{ background: "transparent", border: "none", fontSize: 20, cursor: "pointer", color: "#64748b" }}>
            😊
          </button>
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder={`Nhập tin nhắn gửi tới ${currentActiveConv ? currentActiveConv.name : "Zalo"}...`}
            style={{ flex: 1, padding: "12px 18px", borderRadius: 24, border: "1px solid #d1d5db", outline: "none", fontSize: 14 }}
          />
          <button
            type="submit"
            style={{ padding: "10px 24px", background: "#0068ff", color: "#fff", border: "none", borderRadius: 24, fontWeight: "bold", fontSize: 14, cursor: "pointer", boxShadow: "0 2px 6px rgba(0,104,255,0.3)" }}
          >
            Gửi
          </button>
        </form>
      </div>
    </div>
  );
}
