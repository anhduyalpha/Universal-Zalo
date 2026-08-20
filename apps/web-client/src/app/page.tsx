"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  db,
  Conversation,
  LocalMessage,
  seedInitialConversations,
  deduplicateById,
  deduplicateConversationsByName,
  MessageReaction,
  MentionToken,
} from "../lib/dexie_db";
import { useLiveQuery } from "dexie-react-hooks";
import { nanoid } from "nanoid";
import Link from "next/link";

// 1. Component Avatar chống lỗi 404 / CORS (Avatar Fallback Pipeline)
function AvatarWithFallback({
  name,
  src,
  size = 44,
}: {
  name: string;
  src?: string;
  size?: number;
}) {
  const [hasError, setHasError] = useState(false);
  const cleanName = (name || "Zalo").trim();
  const initial = cleanName.charAt(0).toUpperCase() || "Z";

  const colors = [
    "#0068ff", "#10b981", "#8b5cf6", "#f59e0b",
    "#ec4899", "#3b82f6", "#06b6d4", "#6366f1",
  ];
  let hash = 0;
  for (let i = 0; i < cleanName.length; i++) {
    hash = cleanName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const bgColor = colors[Math.abs(hash) % colors.length];

  if (!src || hasError) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: bgColor,
          color: "#ffffff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 700,
          fontSize: Math.round(size * 0.42),
          flexShrink: 0,
          boxShadow: "0 1px 4px rgba(0,0,0,0.12)",
          userSelect: "none",
        }}
      >
        {initial}
      </div>
    );
  }

  const finalSrc = src.startsWith("http") && typeof window !== "undefined" && !src.startsWith(window.location.origin)
    ? `/api/media/proxy?url=${encodeURIComponent(src)}&name=${encodeURIComponent(cleanName)}`
    : src;

  return (
    <img
      src={finalSrc}
      alt={cleanName}
      onError={() => setHasError(true)}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        objectFit: "cover",
        flexShrink: 0,
        boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
      }}
    />
  );
}

// 2. Component Render Nội dung tin nhắn (hỗ trợ @mentions và link clickable)
function MessageContentRenderer({
  text,
  mentions,
  isMe,
}: {
  text: string;
  mentions?: MentionToken[];
  isMe: boolean;
}) {
  if (!text) return null;

  const URL_REGEX = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
  const parts = text.split(URL_REGEX);

  return (
    <div style={{ fontSize: 14, lineHeight: 1.5, wordBreak: "break-word" }}>
      {parts.map((part, idx) => {
        if (part.match(URL_REGEX)) {
          const href = part.startsWith("http") ? part : `https://${part}`;
          return (
            <a
              key={idx}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: isMe ? "#ffffff" : "#0068ff",
                textDecoration: "underline",
                wordBreak: "break-all",
              }}
            >
              {part}
            </a>
          );
        }

        const mentionMatch = part.match(/@[a-zA-Z0-9_\-\.\s\u00C0-\u024F\u1E00-\u1EFF]+/g);
        if (mentionMatch) {
          return (
            <span key={idx}>
              {part.split(/(@[a-zA-Z0-9_\-\.\s\u00C0-\u024F\u1E00-\u1EFF]+)/g).map((subPart, subIdx) => {
                if (subPart.startsWith("@")) {
                  return (
                    <span
                      key={subIdx}
                      style={{
                        color: isMe ? "#e0f2fe" : "#0284c7",
                        fontWeight: 700,
                        background: isMe ? "rgba(255,255,255,0.2)" : "rgba(2,132,199,0.1)",
                        padding: "1px 5px",
                        borderRadius: 4,
                      }}
                    >
                      {subPart}
                    </span>
                  );
                }
                return subPart;
              })}
            </span>
          );
        }

        return <span key={idx}>{part}</span>;
      })}
    </div>
  );
}

// 3. Component Tệp đính kèm (File Attachment Card)
function FileAttachmentCard({
  name,
  size,
  url,
  isMe,
}: {
  name?: string;
  size?: number;
  url?: string;
  isMe: boolean;
}) {
  const formatSize = (bytes?: number) => {
    if (!bytes) return "Tệp đính kèm";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  return (
    <a
      href={url || "#"}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        background: isMe ? "rgba(255,255,255,0.15)" : "#f1f5f9",
        borderRadius: 10,
        textDecoration: "none",
        color: isMe ? "#ffffff" : "#1e293b",
        marginBottom: 6,
        border: `1px solid ${isMe ? "rgba(255,255,255,0.3)" : "#e2e8f0"}`,
      }}
    >
      <span style={{ fontSize: 24 }}>📄</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name || "Tai_lieu_dinh_kem.pdf"}
        </div>
        <div style={{ fontSize: 11, opacity: 0.8 }}>{formatSize(size)}</div>
      </div>
      <span style={{ fontSize: 16 }}>⬇️</span>
    </a>
  );
}

export default function ZaloMultiDeviceApp() {
  const [activeConvId, setActiveConvId] = useState<string>("conv_1");
  const [inputText, setInputText] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [wsStatus, setWsStatus] = useState<"CONNECTED" | "DISCONNECTED" | "CONNECTING">("CONNECTING");
  const [isFullSyncing, setIsFullSyncing] = useState(false);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncPercent, setSyncPercent] = useState(0);
  const [syncCurrentName, setSyncCurrentName] = useState("");
  const [syncLogs, setSyncLogs] = useState<string[]>([]);
  const [navTab, setNavTab] = useState<"MESSAGES" | "CONTACTS" | "SETTINGS">("MESSAGES");
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [visibleMessageCount, setVisibleMessageCount] = useState(50);
  const [viewportHeight, setViewportHeight] = useState<string>("100dvh");

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  // Dynamic Viewport & Virtual Keyboard Listener
  useEffect(() => {
    if (typeof window !== "undefined" && window.visualViewport) {
      const handleResize = () => {
        if (window.visualViewport) {
          setViewportHeight(`${window.visualViewport.height}px`);
        }
      };
      window.visualViewport.addEventListener("resize", handleResize);
      window.visualViewport.addEventListener("scroll", handleResize);
      return () => {
        window.visualViewport?.removeEventListener("resize", handleResize);
        window.visualViewport?.removeEventListener("scroll", handleResize);
      };
    }
  }, []);

  // Lấy dữ liệu từ IndexedDB (Dexie) và khử trùng lặp
  const rawConversations = useLiveQuery(() => db.conversations.toArray(), []) || [];
  const localConversations = deduplicateConversationsByName(rawConversations);

  const rawMessages = useLiveQuery(
    () => db.messages.where("conversationId").equals(activeConvId).sortBy("timestamp"),
    [activeConvId]
  ) || [];
  const activeMessages = deduplicateById(rawMessages);

  // Virtualized Slice: Chỉ render tối đa N tin nhắn gần nhất để giữ DOM < 50 nodes
  const windowedMessages = useMemo(() => {
    if (activeMessages.length <= visibleMessageCount) {
      return activeMessages;
    }
    return activeMessages.slice(activeMessages.length - visibleMessageCount);
  }, [activeMessages, visibleMessageCount]);

  const currentActiveConv = localConversations.find((c) => c.id === activeConvId) || localConversations[0];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [windowedMessages.length]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [syncLogs]);

  // Đồng bộ danh sách hội thoại từ Server Volume
  const fetchLiveConversations = async () => {
    try {
      const res = await fetch("/api/conversations");
      if (res.ok) {
        const liveConvs: Conversation[] = await res.json();
        if (liveConvs && liveConvs.length > 0) {
          for (const conv of liveConvs) {
            try { await db.conversations.put(conv); } catch {}
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

  // Tải tin nhắn từ Server Volume
  const fetchServerMessages = async (convId: string, convName?: string, refresh: boolean = false) => {
    try {
      const targetName = convName || currentActiveConv?.name || "";
      const res = await fetch(`/api/messages?conversationId=${encodeURIComponent(convId)}&convName=${encodeURIComponent(targetName)}&refresh=${refresh}`);
      if (res.ok) {
        const msgs: LocalMessage[] = await res.json();
        if (msgs && msgs.length > 0) {
          for (const msg of msgs) {
            try {
              await db.messages.put({
                msgId: msg.msgId,
                conversationId: msg.conversationId || convId,
                textContent: msg.textContent,
                sender: msg.sender,
                status: msg.status || "DELIVERED",
                timestamp: msg.timestamp,
                type: msg.type || "TEXT",
                mediaUrl: msg.mediaUrl,
                mediaName: msg.mediaName,
                mediaSize: msg.mediaSize,
                reactions: msg.reactions,
                mentions: msg.mentions,
              });
            } catch {}
          }
        }
      }
    } catch (e) {}
  };

  const handleSelectConversation = (conv: Conversation) => {
    setActiveConvId(conv.id);
    setVisibleMessageCount(50);
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

  // Khởi tạo WebSocket Gateway Hub
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

          if (data.event === "LIVE_SYNC_PROGRESS") {
            setSyncPercent(data.percent || 0);
            setSyncCurrentName(data.currentName || "");
            if (data.log) {
              setSyncLogs((prev) => [...prev, data.log]);
            }
          }

          if (data.event === "LIVE_SYNC_COMPLETED") {
            setSyncPercent(100);
            setSyncLogs((prev) => [...prev, "🎉 Đã hoàn tất đồng bộ toàn diện vào cơ sở dữ liệu!"]);
            if (data.dumpResult?.conversations && data.dumpResult?.messagesByConversation) {
              await db.reconcileFullState(data.dumpResult.conversations, data.dumpResult.messagesByConversation);
            }
            setTimeout(() => {
              setIsFullSyncing(false);
            }, 1500);
          }

          if (data.event === "MESSAGE_FANOUT") {
            const convId = data.conversationId || activeConvId || "conv_1";
            try {
              await db.messages.put({
                msgId: data.msgId,
                conversationId: convId,
                textContent: data.textContent,
                sender: data.sender || "OTHER",
                status: "DELIVERED",
                timestamp: data.hlc?.physicalTime || Date.now(),
                type: data.type || "TEXT",
                mediaUrl: data.mediaUrl,
                mediaName: data.mediaName,
                mediaSize: data.mediaSize,
                reactions: data.reactions,
                mentions: data.mentions,
              });

              await db.conversations.update(convId, {
                lastMessage: data.textContent || `[${data.type || "Media"}]`,
                lastTimestamp: Date.now(),
              });
            } catch {}
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

    try {
      await db.messages.put({
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
    } catch {}

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

  // Upload Ảnh / Tệp đính kèm
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
            try {
              await db.messages.put({
                msgId: result.message.msgId,
                conversationId: targetConvId,
                textContent: result.message.textContent,
                sender: "ME",
                status: "DELIVERED",
                timestamp: Date.now(),
                type: file.type.startsWith("image/") ? "IMAGE" : "FILE",
                mediaUrl: result.message.mediaUrl,
                mediaName: file.name,
                mediaSize: file.size,
              });
            } catch {}
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

  // KÍCH HOẠT ĐỒNG BỘ TRỰC TIẾP
  const handleTriggerLiveSync = () => {
    setIsFullSyncing(true);
    setShowSyncModal(true);
    setSyncPercent(5);
    setSyncLogs(["🚀 Bắt đầu quá trình đồng bộ Zero-Loss IndexedDB..."]);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "START_LIVE_SYNC" }));
    } else {
      fetch("/api/sync/full-resync", { method: "POST" })
        .then((res) => res.json())
        .then(async (dumpResult) => {
          if (dumpResult?.conversations && dumpResult?.messagesByConversation) {
            await db.reconcileFullState(dumpResult.conversations, dumpResult.messagesByConversation);
            setSyncLogs((prev) => [...prev, `✅ Đã lưu ${dumpResult.totalConversations} hội thoại & ${dumpResult.totalMessages} tin nhắn!`]);
            setSyncPercent(100);
            setTimeout(() => setIsFullSyncing(false), 2000);
          }
        })
        .catch((err) => {
          setSyncLogs((prev) => [...prev, `❌ Lỗi: ${err.message}`]);
          setIsFullSyncing(false);
        });
    }
  };

  const filteredConversations = localConversations.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div
      style={{
        display: "flex",
        height: viewportHeight,
        width: "100vw",
        overflow: "hidden",
        background: "#f0f2f5",
        fontFamily: "system-ui, -apple-system, sans-serif",
        overscrollBehaviorY: "none",
        boxSizing: "border-box",
      }}
    >
      {/* 1. Thanh Menu Điều Hướng Cột Trái Cùng */}
      <div
        style={{
          width: 64,
          background: "#0068ff",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "16px 0",
          justifyContent: "space-between",
          flexShrink: 0,
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, width: "100%" }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: "50%",
              background: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: "bold",
              color: "#0068ff",
              fontSize: 18,
              boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
            }}
          >
            Z
          </div>

          <button
            onClick={() => setNavTab("MESSAGES")}
            title="Tin nhắn"
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: navTab === "MESSAGES" ? "rgba(255,255,255,0.2)" : "transparent",
              border: "none",
              color: "#fff",
              fontSize: 20,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            💬
          </button>
          <button
            onClick={() => setNavTab("CONTACTS")}
            title="Danh bạ"
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: navTab === "CONTACTS" ? "rgba(255,255,255,0.2)" : "transparent",
              border: "none",
              color: "#fff",
              fontSize: 20,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            👥
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
          <Link
            href="/session"
            title="Xem màn hình Master Session"
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: "rgba(255,255,255,0.15)",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              textDecoration: "none",
              fontSize: 18,
            }}
          >
            🖥️
          </Link>
          <div
            title={`Trạng thái kết nối: ${wsStatus}`}
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: wsStatus === "CONNECTED" ? "#10b981" : "#ef4444",
              boxShadow: "0 0 6px rgba(0,0,0,0.3)",
            }}
          />
        </div>
      </div>

      {/* 2. Cột Danh Sách Hội Thoại Không Trùng Lặp */}
      <div
        style={{
          width: 340,
          background: "#ffffff",
          borderRight: "1px solid #e5e7eb",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          height: "100%",
          boxSizing: "border-box",
        }}
      >
        <div style={{ padding: "14px 16px", borderBottom: "1px solid #f1f5f9", flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#1e293b" }}>Hội thoại</h2>
            <button
              onClick={handleTriggerLiveSync}
              disabled={isFullSyncing}
              title="Đồng bộ trực tiếp và xem tiến trình thời gian thực"
              style={{
                padding: "6px 14px",
                background: isFullSyncing ? "#e2e8f0" : "#0068ff",
                border: "none",
                borderRadius: 14,
                fontSize: 12,
                fontWeight: 600,
                color: isFullSyncing ? "#64748b" : "#fff",
                cursor: isFullSyncing ? "wait" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
                boxShadow: "0 2px 6px rgba(0,104,255,0.25)",
              }}
            >
              {isFullSyncing ? "⏳ Đang sync..." : "⚡ Đồng bộ trực tiếp"}
            </button>
          </div>
          <input
            type="text"
            placeholder="🔍 Tìm kiếm tin nhắn, liên hệ..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 14px",
              background: "#f1f5f9",
              border: "none",
              borderRadius: 8,
              outline: "none",
              fontSize: 13,
              boxSizing: "border-box",
            }}
          />
        </div>

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
                  <AvatarWithFallback name={conv.name} src={conv.avatar} size={44} />
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
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#ffffff", height: "100%", minWidth: 0, boxSizing: "border-box" }}>
        {/* Chat Header */}
        <div style={{ height: 64, padding: "0 24px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#ffffff", flexShrink: 0 }}>
          {currentActiveConv ? (
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <AvatarWithFallback name={currentActiveConv.name} src={currentActiveConv.avatar} size={42} />
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#1e293b" }}>{currentActiveConv.name}</div>
                <div style={{ fontSize: 12, color: "#10b981", display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10b981" }}></span>
                  Đang hoạt động (Singleton Multiplexed Hub)
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

        {/* Messages Stream View với Virtualized Windowing */}
        <div style={{ flex: 1, padding: "16px 24px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, background: "#f8fafc", minHeight: 0 }}>
          {activeMessages.length > visibleMessageCount && (
            <button
              onClick={() => setVisibleMessageCount((prev) => prev + 50)}
              style={{
                alignSelf: "center",
                padding: "6px 16px",
                background: "#e2e8f0",
                color: "#475569",
                border: "none",
                borderRadius: 12,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                marginBottom: 6,
              }}
            >
              ⬆️ Tải thêm 50 tin nhắn cũ hơn ({activeMessages.length - visibleMessageCount} tin còn lại)
            </button>
          )}

          {windowedMessages.length === 0 ? (
            <div style={{ margin: "auto", textAlign: "center", color: "#94a3b8" }}>
              <div style={{ fontSize: 40, marginBottom: 10 }}>💬</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#475569" }}>Lịch sử tin nhắn của {currentActiveConv?.name || "cuộc hội thoại"}</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>Bấm <b>"⚡ Đồng bộ trực tiếp"</b> để tải toàn bộ tin nhắn từ IndexedDB!</div>
            </div>
          ) : (
            windowedMessages.map((m) => {
              const isMe = m.sender === "ME";
              return (
                <div
                  key={m.msgId}
                  style={{
                    alignSelf: isMe ? "flex-end" : "flex-start",
                    maxWidth: "65%",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: isMe ? "flex-end" : "flex-start",
                  }}
                >
                  <div
                    style={{
                      background: isMe ? "#0068ff" : "#ffffff",
                      color: isMe ? "#ffffff" : "#1e293b",
                      padding: "10px 16px",
                      borderRadius: 16,
                      borderBottomRightRadius: isMe ? 2 : 16,
                      borderBottomLeftRadius: isMe ? 16 : 2,
                      boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
                      position: "relative",
                    }}
                  >
                    {/* Media: Hình ảnh */}
                    {m.mediaUrl && m.type === "IMAGE" && (
                      <img
                        src={m.mediaUrl}
                        alt="Media Attachment"
                        onClick={() => setPreviewImage(m.mediaUrl || null)}
                        style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 8, marginBottom: 6, display: "block", objectFit: "contain", cursor: "pointer" }}
                      />
                    )}

                    {/* Media: Video */}
                    {m.mediaUrl && m.type === "VIDEO" && (
                      <video
                        controls
                        src={m.mediaUrl}
                        style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 8, marginBottom: 6, display: "block" }}
                      />
                    )}

                    {/* Media: Audio */}
                    {m.mediaUrl && m.type === "VOICE" && (
                      <audio controls src={m.mediaUrl} style={{ width: "100%", marginBottom: 6 }} />
                    )}

                    {/* Media: Tệp đính kèm */}
                    {m.mediaUrl && m.type === "FILE" && (
                      <FileAttachmentCard
                        name={m.mediaName}
                        size={m.mediaSize}
                        url={m.mediaUrl}
                        isMe={isMe}
                      />
                    )}

                    {/* Text Content Renderer với @mentions & URL */}
                    {m.textContent && (
                      <MessageContentRenderer
                        text={m.textContent}
                        mentions={m.mentions}
                        isMe={isMe}
                      />
                    )}

                    <div style={{ fontSize: 10, color: isMe ? "rgba(255,255,255,0.75)" : "#94a3b8", marginTop: 4, textAlign: "right" }}>
                      {new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} {isMe && (m.status === "SENDING" ? "⏳" : "✓✓")}
                    </div>
                  </div>

                  {/* Reaction Pills */}
                  {m.reactions && m.reactions.length > 0 && (
                    <div style={{ display: "flex", gap: 4, marginTop: -6, zIndex: 2, paddingLeft: isMe ? 0 : 8, paddingRight: isMe ? 8 : 0 }}>
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
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* CỬA SỔ THEO DÕI ĐỒNG BỘ TRỰC TIẾP THỜI GIAN THỰC */}
        {showSyncModal && (
          <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(15, 23, 42, 0.75)", backdropFilter: "blur(4px)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
            <div style={{ width: "100%", maxWidth: 640, background: "#1e293b", border: "1px solid #334155", borderRadius: 16, overflow: "hidden", boxShadow: "0 20px 40px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column" }}>
              <div style={{ padding: "16px 20px", background: "#0f172a", borderBottom: "1px solid #334155", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 20 }}>⚡</span>
                  <span style={{ fontWeight: 700, fontSize: 16, color: "#f8fafc" }}>Tiến trình Đồng bộ Trực tiếp (Zero-Loss IndexedDB Stream)</span>
                </div>
                <button
                  onClick={() => setShowSyncModal(false)}
                  disabled={isFullSyncing}
                  style={{ background: "transparent", border: "none", color: "#94a3b8", fontSize: 18, cursor: isFullSyncing ? "not-allowed" : "pointer" }}
                >
                  ✕
                </button>
              </div>

              <div style={{ padding: "18px 20px", borderBottom: "1px solid #334155", background: "#1e293b" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, fontSize: 13, color: "#cbd5e1" }}>
                  <span>{isFullSyncing ? `Đang xử lý: ${syncCurrentName || "Zalo Master"}` : "✅ Đồng bộ thành công!"}</span>
                  <span style={{ fontWeight: 700, color: "#38bdf8" }}>{syncPercent}%</span>
                </div>
                <div style={{ width: "100%", height: 8, background: "#334155", borderRadius: 4, overflow: "hidden" }}>
                  <div
                    style={{
                      width: `${syncPercent}%`,
                      height: "100%",
                      background: "linear-gradient(90deg, #0068ff, #38bdf8)",
                      transition: "width 0.3s ease",
                    }}
                  />
                </div>
              </div>

              <div style={{ height: 260, background: "#090d16", padding: "14px 18px", overflowY: "auto", fontFamily: "monospace", fontSize: 12, color: "#4ade80", display: "flex", flexDirection: "column", gap: 6 }}>
                {syncLogs.map((line, idx) => (
                  <div key={idx} style={{ lineHeight: 1.4, wordBreak: "break-word" }}>
                    {line}
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>

              <div style={{ padding: "14px 20px", background: "#0f172a", borderTop: "1px solid #334155", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "#64748b" }}>
                  {isFullSyncing ? "⚡ Đang trích xuất & lưu vào Server Volume..." : "Dữ liệu đã được nạp 100% vào PWA."}
                </span>
                <button
                  onClick={() => setShowSyncModal(false)}
                  disabled={isFullSyncing}
                  style={{
                    padding: "8px 20px",
                    background: isFullSyncing ? "#334155" : "#0068ff",
                    color: "#fff",
                    border: "none",
                    borderRadius: 8,
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: isFullSyncing ? "wait" : "pointer",
                  }}
                >
                  {isFullSyncing ? "⏳ Đang chạy..." : "Đóng & Bắt đầu Chat"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal Xem ảnh lớn */}
        {previewImage && (
          <div
            onClick={() => setPreviewImage(null)}
            style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.85)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
          >
            <img src={previewImage} alt="Large preview" style={{ maxWidth: "90%", maxHeight: "90%", borderRadius: 8 }} />
          </div>
        )}

        {/* Input Composer */}
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
