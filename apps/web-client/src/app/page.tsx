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
  const [isFullSyncing, setIsFullSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ stage: string; percent: number } | null>(null);
  const [navTab, setNavTab] = useState<"MESSAGES" | "CONTACTS" | "SETTINGS">("MESSAGES");
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Lấy dữ liệu từ IndexedDB (Dexie)
  const localConversations = useLiveQuery(() => db.conversations.toArray(), []) || [];
  const activeMessages = useLiveQuery(
    () => db.messages.where("conversationId").equals(activeConvId).sortBy("timestamp"),
    [activeConvId]
  ) || [];

  const currentActiveConv = localConversations.find((c) => c.id === activeConvId) || localConversations[0];

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
  const fetchServerMessages = async (convId: string, convName?: string, refresh: boolean = false) => {
    try {
      const targetName = convName || currentActiveConv?.name || "";
      const res = await fetch(`/api/messages?conversationId=${encodeURIComponent(convId)}&convName=${encodeURIComponent(targetName)}&refresh=${refresh}`);
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
              reactions: msg.reactions,
            });
          }
        }
      }
    } catch (e) {}
  };

  // Khi người dùng chọn cuộc hội thoại, tự động chuyển chat trên Chromium và cào tin nhắn
  const handleSelectConversation = (conv: Conversation) => {
    setActiveConvId(conv.id);
    fetchServerMessages(conv.id, conv.name);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "SELECT_CONVERSATION",
          conversationId: conv.id,
          conversationName: conv.name,
        })
      );
    }
  };

  useEffect(() => {
    if (activeConvId && currentActiveConv) {
      fetchServerMessages(activeConvId, currentActiveConv.name);
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
              reactions: data.reactions,
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

      const timer = setInterval(fetchLiveConversations, 10000);

      return () => {
        clearInterval(timer);
        ws.close();
      };
    }
  }, [activeConvId]);

  // Gửi tin nhắn Text
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
          conversationName: currentActiveConv?.name,
          textContent: inputText,
          idempotencyKey: tempMsgId,
        })
      );
    }

    setInputText("");
  };

  // Upload Ảnh / Tệp đính kèm lên Server Volume
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    const targetConvId = activeConvId || "conv_1";

    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64Data = reader.result as string;
        const res = await fetch("/api/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            data: base64Data,
            filename: file.name,
            conversationId: targetConvId,
            caption: inputText,
          }),
        });

        if (res.ok) {
          const result = await res.json();
          if (result.message) {
            await db.messages.put({
              msgId: result.message.msgId,
              conversationId: targetConvId,
              textContent: result.message.textContent,
              sender: "ME",
              status: "DELIVERED",
              timestamp: Date.now(),
              type: "IMAGE",
              mediaUrl: result.message.mediaUrl,
            });
          }
        }
        setUploading(false);
        setInputText("");
      };
      reader.readAsDataURL(file);
    } catch (err) {
      setUploading(false);
    }
  };

  // THỰC THI FULL MASTER RESYNC TOÀN DIỆN
  const handleTriggerFullResync = async () => {
    setIsFullSyncing(true);
    setSyncProgress({ stage: "1/4: Đang kết nối tới Headless Master Session...", percent: 20 });

    try {
      setTimeout(() => {
        setSyncProgress({ stage: "2/4: Đang cào cây hội thoại & tải bộ đệm tin nhắn lịch sử...", percent: 50 });
      }, 1500);

      setTimeout(() => {
        setSyncProgress({ stage: "3/4: Đang làm sạch biểu tượng rác & trích xuất Reaction AST...", percent: 75 });
      }, 3500);

      const res = await fetch("/api/sync/full-resync", { method: "POST" });
      const dumpResult = await res.json();

      if (dumpResult && dumpResult.success) {
        setSyncProgress({ stage: "4/4: Đang đối soát và lập chỉ mục cơ sở dữ liệu IndexedDB...", percent: 95 });

        // Đối soát và cập nhật cơ sở dữ liệu Dexie cục bộ
        if (dumpResult.conversations && dumpResult.messagesByConversation) {
          await db.reconcileFullState(dumpResult.conversations, dumpResult.messagesByConversation);
        }

        setSyncProgress({ stage: `✅ Hoàn tất đồng bộ ${dumpResult.totalConversations} hội thoại & ${dumpResult.totalMessages} tin nhắn!`, percent: 100 });
        setTimeout(() => {
          setIsFullSyncing(false);
          setSyncProgress(null);
        }, 2000);
      } else {
        throw new Error(dumpResult?.error || "Lỗi đồng bộ dữ liệu từ server.");
      }
    } catch (e: any) {
      setSyncProgress({ stage: `❌ Lỗi: ${e.message}`, percent: 100 });
      setTimeout(() => {
        setIsFullSyncing(false);
        setSyncProgress(null);
      }, 4000);
    }
  };

  const filteredConversations = localConversations.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

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
              onClick={handleTriggerFullResync}
              disabled={isFullSyncing}
              title="Đồng bộ sâu toàn bộ lịch sử tin nhắn và làm sạch reaction"
              style={{ padding: "5px 12px", background: isFullSyncing ? "#e2e8f0" : "#0068ff", border: "none", borderRadius: 14, fontSize: 12, fontWeight: 600, color: isFullSyncing ? "#64748b" : "#fff", cursor: isFullSyncing ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 6, boxShadow: "0 2px 6px rgba(0,104,255,0.2)" }}
            >
              {isFullSyncing ? "⏳ Đang đồng bộ..." : "⚡ Đồng bộ toàn bộ"}
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

        {/* Progress Bar khi đang Full Sync */}
        {syncProgress && (
          <div style={{ padding: "10px 14px", background: "#e0f2fe", borderBottom: "1px solid #bae6fd", flexShrink: 0 }}>
            <div style={{ fontSize: 12, color: "#0369a1", fontWeight: 600, marginBottom: 6 }}>
              {syncProgress.stage}
            </div>
            <div style={{ width: "100%", height: 6, background: "#bae6fd", borderRadius: 3, overflow: "hidden" }}>
              <div
                style={{
                  width: `${syncProgress.percent}%`,
                  height: "100%",
                  background: "#0284c7",
                  transition: "width 0.3s ease",
                }}
              />
            </div>
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
                  onClick={() => handleSelectConversation(conv)}
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
                  Đang hoạt động (Đồng bộ sạch & Lưu vĩnh viễn)
                </div>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 16, fontWeight: 600, color: "#64748b" }}>Chọn cuộc trò chuyện để bắt đầu</div>
          )}

          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => currentActiveConv && fetchServerMessages(activeConvId, currentActiveConv.name, true)}
              style={{ padding: "7px 14px", background: "#f1f5f9", color: "#0068ff", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
            >
              🔄 Tải lại tin nhắn
            </button>
            <Link
              href="/session"
              style={{ padding: "7px 14px", background: "#0068ff", color: "#fff", textDecoration: "none", borderRadius: 8, fontSize: 13, fontWeight: 600 }}
            >
              🖥️ Xem Master View
            </Link>
          </div>
        </div>

        {/* Messages Stream View hỗ trợ hiển thị Media & Huy hiệu Reaction */}
        <div style={{ flex: 1, padding: "20px 24px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 14, background: "#f8fafc", minHeight: 0 }}>
          {activeMessages.length === 0 ? (
            <div style={{ margin: "auto", textAlign: "center", color: "#94a3b8" }}>
              <div style={{ fontSize: 40, marginBottom: 10 }}>💬</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#475569" }}>Lịch sử tin nhắn của {currentActiveConv?.name || "cuộc hội thoại"}</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>Bấm <b>"⚡ Đồng bộ toàn bộ"</b> để tải và làm sạch toàn bộ tin nhắn!</div>
            </div>
          ) : (
            activeMessages.map((m) => (
              <div
                key={m.msgId}
                style={{
                  alignSelf: m.sender === "ME" ? "flex-end" : "flex-start",
                  maxWidth: "65%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: m.sender === "ME" ? "flex-end" : "flex-start",
                }}
              >
                <div
                  style={{
                    background: m.sender === "ME" ? "#0068ff" : "#ffffff",
                    color: m.sender === "ME" ? "#ffffff" : "#1e293b",
                    padding: "10px 16px",
                    borderRadius: 16,
                    borderBottomRightRadius: m.sender === "ME" ? 2 : 16,
                    borderBottomLeftRadius: m.sender === "OTHER" ? 2 : 16,
                    boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
                    position: "relative",
                  }}
                >
                  {/* Media Content (Ảnh / Video / Audio) */}
                  {m.mediaUrl && m.type === "IMAGE" && (
                    <img
                      src={m.mediaUrl}
                      alt="Media Attachment"
                      onClick={() => setPreviewImage(m.mediaUrl || null)}
                      style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 8, marginBottom: 6, display: "block", objectFit: "contain", cursor: "pointer" }}
                    />
                  )}
                  {m.mediaUrl && m.type === "VIDEO" && (
                    <video
                      controls
                      src={m.mediaUrl}
                      style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 8, marginBottom: 6, display: "block" }}
                    />
                  )}
                  {m.mediaUrl && m.type === "VOICE" && (
                    <audio controls src={m.mediaUrl} style={{ width: "100%", marginBottom: 6 }} />
                  )}

                  {/* Clean Text Content (Đã bóc tách reaction rác) */}
                  {m.textContent && (
                    <div style={{ fontSize: 14, lineHeight: 1.5, wordBreak: "break-word" }}>{m.textContent}</div>
                  )}

                  <div style={{ fontSize: 10, color: m.sender === "ME" ? "rgba(255,255,255,0.75)" : "#94a3b8", marginTop: 4, textAlign: "right" }}>
                    {new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} {m.sender === "ME" && (m.status === "SENDING" ? "⏳" : "✓✓")}
                  </div>
                </div>

                {/* Huy hiệu Reaction có cấu trúc (Structured Reaction Badges) */}
                {m.reactions && m.reactions.length > 0 && (
                  <div style={{ display: "flex", gap: 4, marginTop: -6, zIndex: 2, paddingLeft: m.sender === "ME" ? 0 : 8, paddingRight: m.sender === "ME" ? 8 : 0 }}>
                    {m.reactions.map((r, rIdx) => (
                      <span
                        key={rIdx}
                        style={{
                          background: "#ffffff",
                          border: "1px solid #e2e8f0",
                          borderRadius: 12,
                          padding: "2px 6px",
                          fontSize: 11,
                          display: "flex",
                          alignItems: "center",
                          gap: 3,
                          boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
                        }}
                      >
                        <span>{r.emoji}</span>
                        {r.count > 1 && <span style={{ fontWeight: 600, color: "#64748b" }}>{r.count}</span>}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Modal Xem ảnh lớn */}
        {previewImage && (
          <div
            onClick={() => setPreviewImage(null)}
            style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.85)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
          >
            <img src={previewImage} alt="Large preview" style={{ maxWidth: "90%", maxHeight: "90%", borderRadius: 8 }} />
          </div>
        )}

        {/* Input Composer có hỗ trợ Tải file & Gửi ảnh */}
        <form onSubmit={handleSendMessage} style={{ padding: "14px 20px", borderTop: "1px solid #e5e7eb", background: "#ffffff", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept="image/*,video/*,.pdf,.doc,.docx"
            style={{ display: "none" }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Gửi ảnh / Tệp tin"
            style={{ background: "transparent", border: "none", fontSize: 20, cursor: "pointer", color: "#64748b" }}
          >
            {uploading ? "⏳" : "📎"}
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
