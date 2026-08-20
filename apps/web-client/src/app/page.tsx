"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  db,
  Conversation,
  LocalMessage,
  seedInitialConversations,
  deduplicateById,
  deduplicateConversationsByName,
  MentionToken,
} from "../lib/dexie_db";
import { useLiveQuery } from "dexie-react-hooks";
import { nanoid } from "nanoid";
import Link from "next/link";

// 1. Component Avatar chống lỗi 404 / CORS với phong cách Dark Pro
function AvatarWithFallback({
  name,
  src,
  size = 42,
}: {
  name: string;
  src?: string;
  size?: number;
}) {
  const [hasError, setHasError] = useState(false);
  const cleanName = (name || "Zalo").trim();
  const initial = cleanName.charAt(0).toUpperCase() || "Z";

  const colors = [
    "#10b981", "#059669", "#0068ff", "#6366f1",
    "#8b5cf6", "#ec4899", "#f59e0b", "#06b6d4"
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
          boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
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
        boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
        border: "1px solid rgba(255,255,255,0.1)",
      }}
    />
  );
}

// 2. Component Phát Tin Nhắn Thoại (Audio Voice Player - Dark Theme)
function AudioVoicePlayer({ src, isMe }: { src: string; isMe: boolean }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const finalSrc = src.startsWith("http") && typeof window !== "undefined" && !src.startsWith(window.location.origin)
    ? `/api/media/proxy?url=${encodeURIComponent(src)}`
    : src;

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(() => {});
    }
    setIsPlaying(!isPlaying);
  };

  const formatTime = (sec: number) => {
    if (isNaN(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        background: isMe ? "rgba(255,255,255,0.12)" : "rgba(15, 23, 42, 0.6)",
        borderRadius: 24,
        marginBottom: 6,
        minWidth: 220,
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <audio
        ref={audioRef}
        src={finalSrc}
        onTimeUpdate={() => audioRef.current && setCurrentTime(audioRef.current.currentTime)}
        onLoadedMetadata={() => audioRef.current && setDuration(audioRef.current.duration)}
        onEnded={() => setIsPlaying(false)}
      />
      <button
        type="button"
        onClick={togglePlay}
        style={{
          width: 34,
          height: 34,
          borderRadius: "50%",
          background: isMe ? "#ffffff" : "#10b981",
          color: isMe ? "#0f172a" : "#ffffff",
          border: "none",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
          flexShrink: 0,
          boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
        }}
      >
        {isPlaying ? "⏸️" : "▶️"}
      </button>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
        <input
          type="range"
          min={0}
          max={duration || 100}
          value={currentTime}
          onChange={(e) => {
            if (audioRef.current) {
              audioRef.current.currentTime = Number(e.target.value);
              setCurrentTime(Number(e.target.value));
            }
          }}
          style={{ width: "100%", height: 4, accentColor: isMe ? "#ffffff" : "#10b981", cursor: "pointer" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: isMe ? "#e2e8f0" : "#94a3b8" }}>
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>
    </div>
  );
}

// 3. Component Render Nội dung tin nhắn (hỗ trợ @mentions và link clickable)
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
    <div style={{ fontSize: 13.5, lineHeight: 1.55, wordBreak: "break-word", color: isMe ? "#ffffff" : "#f1f5f9" }}>
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
                color: isMe ? "#93c5fd" : "#38bdf8",
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
                        color: "#38bdf8",
                        fontWeight: 700,
                        background: "rgba(56, 189, 248, 0.15)",
                        padding: "1px 6px",
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

// 4. Component Tệp đính kèm (File Attachment Card)
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

  const finalUrl = url && url.startsWith("http") && typeof window !== "undefined" && !url.startsWith(window.location.origin)
    ? `/api/media/proxy?url=${encodeURIComponent(url)}`
    : (url || "#");

  return (
    <a
      href={finalUrl}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        background: isMe ? "rgba(255,255,255,0.12)" : "rgba(15, 23, 42, 0.6)",
        borderRadius: 12,
        textDecoration: "none",
        color: isMe ? "#ffffff" : "#f8fafc",
        marginBottom: 6,
        border: "1px solid rgba(255,255,255,0.1)",
      }}
    >
      <span style={{ fontSize: 24 }}>📄</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name || "Tai_lieu_dinh_kem.pdf"}
        </div>
        <div style={{ fontSize: 11, color: "#94a3b8" }}>{formatSize(size)}</div>
      </div>
      <span style={{ fontSize: 16 }}>⬇️</span>
    </a>
  );
}

export default function ZChatDeskApp() {
  const [activeConvId, setActiveConvId] = useState<string>("general");
  const [filterType, setFilterType] = useState<"ALL" | "DIRECT" | "GROUP">("ALL");
  const [inputText, setInputText] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [wsStatus, setWsStatus] = useState<"CONNECTED" | "DISCONNECTED" | "CONNECTING">("CONNECTING");
  const [isFullSyncing, setIsFullSyncing] = useState(false);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncPercent, setSyncPercent] = useState(0);
  const [syncCurrentName, setSyncCurrentName] = useState("");
  const [syncLogs, setSyncLogs] = useState<string[]>([]);
  const [navTab, setNavTab] = useState<"MESSAGES" | "CONTACTS" | "AUTOMATION">("MESSAGES");
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [visibleMessageCount, setVisibleMessageCount] = useState(60);
  const [viewportHeight, setViewportHeight] = useState<string>("100dvh");
  const [isLoadingConversations, setIsLoadingConversations] = useState(true);

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

  // Virtualized Windowing
  const windowedMessages = useMemo(() => {
    if (activeMessages.length <= visibleMessageCount) {
      return activeMessages;
    }
    return activeMessages.slice(activeMessages.length - visibleMessageCount);
  }, [activeMessages, visibleMessageCount]);

  const currentActiveConv = localConversations.find((c) => c.id === activeConvId) || localConversations[0];

  // Phân loại danh sách hội thoại
  const allCount = localConversations.length;
  const directCount = localConversations.filter((c) => c.type === "DIRECT").length;
  const groupCount = localConversations.filter((c) => c.type === "GROUP").length;

  const filteredConversations = useMemo(() => {
    let list = localConversations;
    if (filterType === "DIRECT") {
      list = list.filter((c) => c.type === "DIRECT");
    } else if (filterType === "GROUP") {
      list = list.filter((c) => c.type === "GROUP");
    }
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(query) || c.lastMessage.toLowerCase().includes(query));
    }
    return list;
  }, [localConversations, filterType, searchQuery]);

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
        if (Array.isArray(liveConvs) && liveConvs.length > 0) {
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
    } finally {
      setIsLoadingConversations(false);
    }
  };

  // Tải tin nhắn từ Server Volume
  const fetchServerMessages = async (convId: string, convName?: string, refresh: boolean = false) => {
    try {
      const targetName = convName || currentActiveConv?.name || "";
      const res = await fetch(`/api/messages?conversationId=${encodeURIComponent(convId)}&convName=${encodeURIComponent(targetName)}&refresh=${refresh}`);
      if (res.ok) {
        const msgs: LocalMessage[] = await res.json();
        if (Array.isArray(msgs) && msgs.length > 0) {
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
    setVisibleMessageCount(60);
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

  // Khởi tạo WebSocket Gateway Hub & Seed bảo vệ
  useEffect(() => {
    if (typeof window !== "undefined") {
      seedInitialConversations().then(() => {
        fetchLiveConversations();
      });

      const loadingTimeout = setTimeout(() => {
        setIsLoadingConversations(false);
      }, 2000);

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
            setIsLoadingConversations(false);
            setTimeout(() => {
              setIsFullSyncing(false);
            }, 1500);
          }

          if (data.event === "MESSAGE_FANOUT") {
            const convId = data.conversationId || activeConvId || "general";
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
        clearTimeout(loadingTimeout);
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
    const targetConvId = activeConvId || "general";

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

  // Upload Ảnh / Media
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    const targetConvId = activeConvId || "general";

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
                type: file.type.startsWith("image/") ? "IMAGE" : (file.type.startsWith("audio/") ? "VOICE" : "FILE"),
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

  // KÍCH HOẠT ĐỒNG BỘ TOÀN DIỆN KHÔNG GIỚI HẠN
  const handleTriggerLiveSync = () => {
    setIsFullSyncing(true);
    setShowSyncModal(true);
    setSyncPercent(5);
    setSyncLogs(["🚀 Bắt đầu quá trình đồng bộ toàn diện Unbounded Zalo Engine..."]);

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

  return (
    <div
      style={{
        display: "flex",
        height: viewportHeight,
        width: "100vw",
        overflow: "hidden",
        background: "#090d16",
        color: "#f8fafc",
        fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
        overscrollBehaviorY: "none",
        boxSizing: "border-box",
      }}
    >
      {/* ========================================================================= */}
      {/* 1. THANH ĐIỀU HƯỚNG DỌC (CỘT 1 - FAR-LEFT ICON NAVBAR)                    */}
      {/* ========================================================================= */}
      <div
        style={{
          width: 68,
          background: "#080c14",
          borderRight: "1px solid #1e293b",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "16px 0",
          justifyContent: "space-between",
          flexShrink: 0,
          boxSizing: "border-box",
          zIndex: 30,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18, width: "100%" }}>
          {/* Logo ZCHAT DESK */}
          <div
            title="ZCHAT DESK Pro"
            style={{
              width: 44,
              height: 44,
              borderRadius: 14,
              background: "linear-gradient(135deg, #10b981, #059669)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 900,
              color: "#ffffff",
              fontSize: 20,
              boxShadow: "0 4px 14px rgba(16, 185, 129, 0.35)",
              cursor: "pointer",
            }}
          >
            Z
          </div>

          {/* Navigation Buttons */}
          <button
            onClick={() => setNavTab("MESSAGES")}
            title="Hội thoại & Tin nhắn"
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: navTab === "MESSAGES" ? "rgba(16, 185, 129, 0.15)" : "transparent",
              color: navTab === "MESSAGES" ? "#10b981" : "#94a3b8",
              border: navTab === "MESSAGES" ? "1px solid rgba(16, 185, 129, 0.3)" : "none",
              fontSize: 18,
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 2,
            }}
          >
            <span>💬</span>
            <span style={{ fontSize: 9, fontWeight: 700 }}>Tin nhắn</span>
          </button>

          <button
            onClick={() => setNavTab("CONTACTS")}
            title="Danh bạ"
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: navTab === "CONTACTS" ? "rgba(16, 185, 129, 0.15)" : "transparent",
              color: navTab === "CONTACTS" ? "#10b981" : "#94a3b8",
              border: navTab === "CONTACTS" ? "1px solid rgba(16, 185, 129, 0.3)" : "none",
              fontSize: 18,
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 2,
            }}
          >
            <span>👥</span>
            <span style={{ fontSize: 9, fontWeight: 600 }}>Danh bạ</span>
          </button>

          <button
            onClick={() => setNavTab("AUTOMATION")}
            title="Tự động hóa"
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: navTab === "AUTOMATION" ? "rgba(16, 185, 129, 0.15)" : "transparent",
              color: navTab === "AUTOMATION" ? "#10b981" : "#94a3b8",
              border: navTab === "AUTOMATION" ? "1px solid rgba(16, 185, 129, 0.3)" : "none",
              fontSize: 18,
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 2,
            }}
          >
            <span>⚡</span>
            <span style={{ fontSize: 8, fontWeight: 600 }}>Tự động hóa</span>
          </button>
        </div>

        {/* User Profile & Live Link */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
          <Link
            href="/session"
            title="Xem màn hình Master Session"
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: "rgba(255,255,255,0.06)",
              color: "#38bdf8",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              textDecoration: "none",
              fontSize: 16,
              border: "1px solid rgba(56, 189, 248, 0.2)",
            }}
          >
            <span>🖥️</span>
            <span style={{ fontSize: 8, fontWeight: 700, color: "#38bdf8" }}>LIVE</span>
          </Link>

          <div
            title={`Trạng thái: ${wsStatus} (Admin)`}
            style={{
              position: "relative",
              width: 40,
              height: 40,
              borderRadius: 12,
              background: "#334155",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 13,
              color: "#f8fafc",
            }}
          >
            SY
            <span
              style={{
                position: "absolute",
                bottom: -2,
                right: -2,
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: wsStatus === "CONNECTED" ? "#10b981" : "#ef4444",
                border: "2px solid #080c14",
              }}
            />
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 2. CỘT DANH SÁCH HỘI THOẠI (CỘT 2 - CONVERSATION SIDEBAR)                 */}
      {/* ========================================================================= */}
      <div
        style={{
          width: 320,
          background: "#0d111a",
          borderRight: "1px solid #1e293b",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          height: "100%",
          boxSizing: "border-box",
        }}
      >
        {/* Header Hộp thư */}
        <div style={{ padding: "16px 18px 12px 18px", borderBottom: "1px solid #1e293b", flexShrink: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.08em", color: "#10b981", textTransform: "uppercase", marginBottom: 4 }}>
            HỘP THƯ ZALO
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#f8fafc" }}>Hội thoại</h2>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={fetchLiveConversations}
                title="Tải lại danh sách"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: "#1e293b",
                  border: "1px solid #334155",
                  color: "#94a3b8",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 14,
                }}
              >
                🔄
              </button>
              <button
                onClick={handleTriggerLiveSync}
                disabled={isFullSyncing}
                title="Đồng bộ toàn bộ hội thoại & media từ Zalo"
                style={{
                  padding: "6px 12px",
                  background: isFullSyncing ? "#334155" : "linear-gradient(135deg, #10b981, #059669)",
                  border: "none",
                  borderRadius: 8,
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#ffffff",
                  cursor: isFullSyncing ? "wait" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  boxShadow: "0 2px 8px rgba(16, 185, 129, 0.3)",
                }}
              >
                {isFullSyncing ? "⏳ Sync..." : "⚡ Sync"}
              </button>
            </div>
          </div>

          {/* Ô Tìm Kiếm */}
          <div style={{ position: "relative", marginBottom: 10 }}>
            <input
              type="text"
              placeholder="🔎 Tìm tên hoặc nội dung..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 12px 8px 32px",
                background: "#151c2c",
                border: "1px solid #243048",
                borderRadius: 8,
                outline: "none",
                fontSize: 12.5,
                color: "#f8fafc",
                boxSizing: "border-box",
              }}
            />
            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 12, opacity: 0.5 }}>
              🔍
            </span>
          </div>

          {/* Bộ Lọc Tabs (Tất cả / Cá nhân / Nhóm) */}
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={() => setFilterType("ALL")}
              style={{
                flex: 1,
                padding: "5px 8px",
                background: filterType === "ALL" ? "rgba(16, 185, 129, 0.2)" : "#151c2c",
                color: filterType === "ALL" ? "#10b981" : "#94a3b8",
                border: filterType === "ALL" ? "1px solid #10b981" : "1px solid #243048",
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
                textAlign: "center",
              }}
            >
              Tất cả {allCount > 0 && <span style={{ opacity: 0.8 }}>({allCount})</span>}
            </button>
            <button
              onClick={() => setFilterType("DIRECT")}
              style={{
                flex: 1,
                padding: "5px 8px",
                background: filterType === "DIRECT" ? "rgba(16, 185, 129, 0.2)" : "#151c2c",
                color: filterType === "DIRECT" ? "#10b981" : "#94a3b8",
                border: filterType === "DIRECT" ? "1px solid #10b981" : "1px solid #243048",
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
                textAlign: "center",
              }}
            >
              Cá nhân {directCount > 0 && <span style={{ opacity: 0.8 }}>({directCount})</span>}
            </button>
            <button
              onClick={() => setFilterType("GROUP")}
              style={{
                flex: 1,
                padding: "5px 8px",
                background: filterType === "GROUP" ? "rgba(16, 185, 129, 0.2)" : "#151c2c",
                color: filterType === "GROUP" ? "#10b981" : "#94a3b8",
                border: filterType === "GROUP" ? "1px solid #10b981" : "1px solid #243048",
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
                textAlign: "center",
              }}
            >
              Nhóm {groupCount > 0 && <span style={{ opacity: 0.8 }}>({groupCount})</span>}
            </button>
          </div>
        </div>

        {/* Danh Sách Hội Thoại */}
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "6px 8px" }}>
          {isLoadingConversations ? (
            <div style={{ textAlign: "center", padding: "40px 16px", color: "#64748b", fontSize: 13 }}>
              <div style={{ fontSize: 24, marginBottom: 8 }}>⏳</div>
              <div>Đang tải toàn bộ hội thoại...</div>
            </div>
          ) : filteredConversations.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 16px", color: "#64748b", fontSize: 13 }}>
              <div style={{ fontSize: 32, marginBottom: 10 }}>💬</div>
              <div style={{ fontWeight: 700, color: "#cbd5e1", marginBottom: 6 }}>Chưa có hội thoại nào</div>
              <p style={{ fontSize: 11.5, color: "#64748b", margin: "0 0 16px 0" }}>
                Bấm nút bên dưới để trích xuất 100% dữ liệu từ Zalo Web!
              </p>
              <button
                onClick={handleTriggerLiveSync}
                style={{
                  padding: "8px 16px",
                  background: "linear-gradient(135deg, #10b981, #059669)",
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                ⚡ Đồng bộ Hội thoại Zalo
              </button>
            </div>
          ) : (
            filteredConversations.map((conv) => {
              const isSelected = conv.id === activeConvId;
              const isGroup = conv.type === "GROUP";
              return (
                <div
                  key={conv.id}
                  onClick={() => handleSelectConversation(conv)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "10px 12px",
                    gap: 12,
                    cursor: "pointer",
                    background: isSelected ? "rgba(16, 185, 129, 0.12)" : "transparent",
                    borderRadius: 10,
                    marginBottom: 4,
                    border: isSelected ? "1px solid rgba(16, 185, 129, 0.3)" : "1px solid transparent",
                    transition: "all 0.15s ease",
                  }}
                >
                  <div style={{ position: "relative" }}>
                    <AvatarWithFallback name={conv.name} src={conv.avatar} size={42} />
                    <span
                      style={{
                        position: "absolute",
                        bottom: 0,
                        right: 0,
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: "#10b981",
                        border: "2px solid #0d111a",
                      }}
                    />
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                        <span style={{ fontSize: 13, fontWeight: isSelected ? 800 : 700, color: isSelected ? "#10b981" : "#f1f5f9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {conv.name}
                        </span>
                        {isGroup && (
                          <span style={{ fontSize: 9, background: "#1e293b", color: "#94a3b8", padding: "1px 4px", borderRadius: 4, fontWeight: 700, flexShrink: 0 }}>
                            NHÓM
                          </span>
                        )}
                      </div>
                      <span style={{ fontSize: 10, color: "#64748b", flexShrink: 0 }}>
                        {new Date(conv.lastTimestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontSize: 11.5, color: isSelected ? "#cbd5e1" : "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                        {conv.lastMessage}
                      </div>
                      {conv.unreadCount > 0 && (
                        <span style={{ background: "#10b981", color: "#064e3b", fontSize: 10, fontWeight: 800, padding: "1px 6px", borderRadius: 10, flexShrink: 0, marginLeft: 6 }}>
                          {conv.unreadCount > 99 ? "99+" : conv.unreadCount}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 3. KHUNG CHAT CHÍNH (CỘT 3 - MAIN CHAT AREA & GRID PATTERN)               */}
      {/* ========================================================================= */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          background: "#0b0f19",
          height: "100%",
          minWidth: 0,
          boxSizing: "border-box",
          position: "relative",
        }}
      >
        {/* Chat Header */}
        <div
          style={{
            height: 60,
            padding: "0 20px",
            borderBottom: "1px solid #1e293b",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            background: "#0d111a",
            flexShrink: 0,
          }}
        >
          {currentActiveConv ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <AvatarWithFallback name={currentActiveConv.name} src={currentActiveConv.avatar} size={38} />
              <div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#f8fafc", display: "flex", alignItems: "center", gap: 8 }}>
                  <span>{currentActiveConv.name}</span>
                  <span style={{ fontSize: 10, background: "rgba(0, 104, 255, 0.2)", color: "#38bdf8", border: "1px solid rgba(56, 189, 248, 0.3)", padding: "1px 6px", borderRadius: 6, fontWeight: 700 }}>
                    ZALO
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "#64748b" }}>
                  Tin nhắn được đồng bộ từ Listener (Zero-Loss Pipeline)
                </div>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 14, fontWeight: 700, color: "#64748b" }}>Chọn một hội thoại để bắt đầu</div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={() => currentActiveConv && fetchServerMessages(activeConvId, currentActiveConv.name, true)}
              style={{
                padding: "6px 12px",
                background: "#151c2c",
                color: "#10b981",
                border: "1px solid #243048",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              🔄 Tải lại
            </button>
            <Link
              href="/session"
              style={{
                padding: "6px 12px",
                background: "rgba(56, 189, 248, 0.15)",
                color: "#38bdf8",
                textDecoration: "none",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 700,
                border: "1px solid rgba(56, 189, 248, 0.3)",
              }}
            >
              🖥️ Master View
            </Link>
          </div>
        </div>

        {/* Warning / Status Notification Banner */}
        <div
          style={{
            background: "rgba(245, 158, 11, 0.1)",
            borderBottom: "1px solid rgba(245, 158, 11, 0.2)",
            padding: "6px 20px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 11.5,
            color: "#fbbf24",
            flexShrink: 0,
          }}
        >
          <span>
            ⚠️ Trực tuyến qua Gateway Hub – Lịch sử tin nhắn và media luôn được lưu an toàn tại Server Volume.
          </span>
          <button
            onClick={handleTriggerLiveSync}
            style={{
              background: "rgba(245, 158, 11, 0.2)",
              border: "1px solid #f59e0b",
              color: "#fbbf24",
              borderRadius: 6,
              padding: "2px 8px",
              fontSize: 10.5,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Đồng bộ sâu
          </button>
        </div>

        {/* Message Stream Area với Họa Tiết Grid Kỹ Thuật (Dark Grid Pattern) */}
        <div
          style={{
            flex: 1,
            padding: "16px 24px",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            minHeight: 0,
            backgroundImage: `
              linear-gradient(rgba(255, 255, 255, 0.02) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255, 255, 255, 0.02) 1px, transparent 1px)
            `,
            backgroundSize: "24px 24px",
            backgroundPosition: "-1px -1px",
          }}
        >
          {activeMessages.length > visibleMessageCount && (
            <button
              onClick={() => setVisibleMessageCount((prev) => prev + 60)}
              style={{
                alignSelf: "center",
                padding: "6px 18px",
                background: "#1e293b",
                color: "#38bdf8",
                border: "1px solid #334155",
                borderRadius: 12,
                fontSize: 11.5,
                fontWeight: 700,
                cursor: "pointer",
                marginBottom: 6,
              }}
            >
              ⬆️ Tải thêm 60 tin nhắn cũ ({activeMessages.length - visibleMessageCount} tin còn lại)
            </button>
          )}

          {windowedMessages.length === 0 ? (
            <div style={{ margin: "auto", textAlign: "center", color: "#64748b" }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>💬</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#cbd5e1" }}>
                Chưa có tin nhắn lưu trong event log
              </div>
              <div style={{ fontSize: 12, marginTop: 4, color: "#64748b" }}>
                Tin nhắn mới sẽ xuất hiện tự động khi Listener nhận được hoặc bấm <b>"⚡ Sync"</b>!
              </div>
            </div>
          ) : (
            windowedMessages.map((m) => {
              const isMe = m.sender === "ME";
              const mediaProxyUrl = m.mediaUrl && m.mediaUrl.startsWith("http") && !m.mediaUrl.startsWith(window.location.origin)
                ? `/api/media/proxy?url=${encodeURIComponent(m.mediaUrl)}`
                : m.mediaUrl;

              return (
                <div
                  key={m.msgId}
                  style={{
                    alignSelf: isMe ? "flex-end" : "flex-start",
                    maxWidth: "70%",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: isMe ? "flex-end" : "flex-start",
                  }}
                >
                  <div
                    style={{
                      background: isMe ? "linear-gradient(135deg, #0068ff, #0052cc)" : "#161f30",
                      color: "#ffffff",
                      padding: "10px 16px",
                      borderRadius: 16,
                      borderBottomRightRadius: isMe ? 2 : 16,
                      borderBottomLeftRadius: isMe ? 16 : 2,
                      boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
                      border: isMe ? "1px solid rgba(255,255,255,0.15)" : "1px solid #243048",
                      position: "relative",
                    }}
                  >
                    {/* Media: Hình ảnh */}
                    {mediaProxyUrl && m.type === "IMAGE" && (
                      <img
                        src={mediaProxyUrl}
                        alt="Media Attachment"
                        onClick={() => setPreviewImage(mediaProxyUrl)}
                        style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 8, marginBottom: 6, display: "block", objectFit: "contain", cursor: "pointer" }}
                      />
                    )}

                    {/* Media: Video */}
                    {mediaProxyUrl && m.type === "VIDEO" && (
                      <video
                        controls
                        src={mediaProxyUrl}
                        style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 8, marginBottom: 6, display: "block" }}
                      />
                    )}

                    {/* Media: Tin Nhắn Thoại Audio Voice Player */}
                    {mediaProxyUrl && m.type === "VOICE" && (
                      <AudioVoicePlayer src={mediaProxyUrl} isMe={isMe} />
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

                    <div style={{ fontSize: 10, color: isMe ? "rgba(255,255,255,0.7)" : "#64748b", marginTop: 4, textAlign: "right" }}>
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
                            background: "#1e293b",
                            border: "1px solid #334155",
                            borderRadius: 12,
                            padding: "2px 6px",
                            fontSize: 11,
                            display: "flex",
                            alignItems: "center",
                            gap: 3,
                            boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
                          }}
                        >
                          <span>{r.emoji}</span>
                          {r.count > 1 && <span style={{ fontWeight: 700, color: "#10b981" }}>{r.count}</span>}
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

        {/* Realtime Status Footer Line */}
        <div style={{ padding: "4px 20px", background: "#080c14", borderTop: "1px solid #1e293b", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 10.5, color: "#64748b" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10b981" }}></span>
            Realtime qua WebSocket Gateway Hub – gửi qua Job Queue bảo vệ an toàn
          </span>
          <span>{activeMessages.length} tin nhắn trong phiên</span>
        </div>

        {/* Thanh Trả Lời Nhanh (Quick Replies Bar) */}
        <div style={{ padding: "8px 20px", background: "#0d111a", borderTop: "1px solid #1e293b", display: "flex", alignItems: "center", gap: 8, overflowX: "auto" }}>
          <span style={{ fontSize: 10.5, fontWeight: 800, color: "#10b981", textTransform: "uppercase", whiteSpace: "nowrap" }}>
            TRẢ LỜI NHANH:
          </span>
          {[
            "Mình kiểm tra ngay",
            "Cảm ơn bạn đã chờ",
            "Sẽ phản hồi sớm",
            "Đang xử lý yêu cầu",
          ].map((quickText, qIdx) => (
            <button
              key={qIdx}
              type="button"
              onClick={() => setInputText(quickText)}
              style={{
                padding: "4px 10px",
                background: "#151c2c",
                border: "1px solid #243048",
                borderRadius: 14,
                color: "#cbd5e1",
                fontSize: 11,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {quickText}
            </button>
          ))}
        </div>

        {/* Khung Nhập Tin Nhắn (Composer) */}
        <form
          onSubmit={handleSendMessage}
          style={{
            padding: "12px 20px",
            background: "#0d111a",
            borderTop: "1px solid #1e293b",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexShrink: 0,
          }}
        >
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept="image/*,video/*,audio/*,.pdf,.doc,.docx"
            style={{ display: "none" }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Đính kèm tệp / hình ảnh / âm thanh"
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: "#151c2c",
              border: "1px solid #243048",
              color: "#94a3b8",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 16,
            }}
          >
            {uploading ? "⏳" : "➕"}
          </button>
          <button
            type="button"
            title="Emoji & Biểu cảm"
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: "#151c2c",
              border: "1px solid #243048",
              color: "#94a3b8",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 16,
            }}
          >
            😊
          </button>

          <div style={{ flex: 1, position: "relative" }}>
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={`Nhập tin nhắn gửi tới ${currentActiveConv ? currentActiveConv.name : "Zalo"}...`}
              style={{
                width: "100%",
                padding: "10px 48px 10px 16px",
                background: "#151c2c",
                border: "1px solid #243048",
                borderRadius: 20,
                outline: "none",
                fontSize: 13,
                color: "#f8fafc",
                boxSizing: "border-box",
              }}
            />
            <span style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", fontSize: 10, color: "#64748b" }}>
              {inputText.length}/4000
            </span>
          </div>

          <button
            type="submit"
            style={{
              padding: "10px 20px",
              background: "linear-gradient(135deg, #10b981, #059669)",
              color: "#ffffff",
              border: "none",
              borderRadius: 20,
              fontWeight: 800,
              fontSize: 13,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              boxShadow: "0 2px 10px rgba(16, 185, 129, 0.35)",
            }}
          >
            <span>Gửi</span>
            <span>↗️</span>
          </button>
        </form>
      </div>

      {/* ========================================================================= */}
      {/* 4. BẢNG CHI TIẾT METADATA & AN TOÀN (CỘT 4 - RIGHT METADATA INSPECTOR)   */}
      {/* ========================================================================= */}
      <div
        style={{
          width: 280,
          background: "#080c14",
          borderLeft: "1px solid #1e293b",
          display: "flex",
          flexDirection: "column",
          padding: "20px 16px",
          flexShrink: 0,
          height: "100%",
          boxSizing: "border-box",
          overflowY: "auto",
        }}
      >
        {/* Profile Card */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", paddingBottom: 20, borderBottom: "1px solid #1e293b" }}>
          <div style={{ marginBottom: 12 }}>
            <AvatarWithFallback name={currentActiveConv?.name || "Zalo"} src={currentActiveConv?.avatar} size={64} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#f8fafc", marginBottom: 2 }}>
            {currentActiveConv?.name || "Chưa chọn hội thoại"}
          </div>
          <div style={{ fontSize: 11.5, color: "#10b981", fontWeight: 700 }}>
            {currentActiveConv?.type === "GROUP" ? "Nhóm Zalo" : "Hội thoại cá nhân"}
          </div>
        </div>

        {/* Section: THÔNG TIN KẾT NỐI */}
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>
            THÔNG TIN KẾT NỐI
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "#94a3b8" }}>Tài khoản:</span>
              <span style={{ fontWeight: 700, color: "#f8fafc" }}>Admin (Master)</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "#94a3b8" }}>Thread ID:</span>
              <span style={{ fontWeight: 600, color: "#38bdf8", fontFamily: "monospace", fontSize: 11 }}>
                {currentActiveConv?.id || "N/A"}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "#94a3b8" }}>Loại:</span>
              <span style={{ fontWeight: 700, color: "#f8fafc" }}>
                {currentActiveConv?.type === "GROUP" ? "Nhóm" : "Cá nhân"}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "#94a3b8" }}>Listener:</span>
              <span style={{ color: "#10b981", fontWeight: 700 }}>🟢 Sẵn sàng</span>
            </div>
          </div>
        </div>

        {/* Section: TRẠNG THÁI HỘP THƯ */}
        <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid #1e293b" }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>
            TRẠNG THÁI HỘP THƯ
          </div>
          <div style={{ background: "rgba(16, 185, 129, 0.1)", border: "1px solid rgba(16, 185, 129, 0.3)", borderRadius: 8, padding: "8px 10px", fontSize: 11.5 }}>
            <div style={{ color: "#10b981", fontWeight: 700, marginBottom: 2 }}>🟢 Sẵn sàng gửi tin</div>
            <div style={{ color: "#94a3b8", fontSize: 10.5 }}>
              Tài khoản và Listener đang hoạt động bình thường trên Server Linux.
            </div>
          </div>
        </div>

        {/* Section: AN TOÀN GỬI TIN */}
        <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid #1e293b" }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
            AN TOÀN GỬI TIN
          </div>
          <p style={{ fontSize: 11, color: "#64748b", lineHeight: 1.4, margin: 0 }}>
            Tin nhắn được xếp hàng qua Token Bucket Limiter để đảm bảo an toàn tài khoản và tránh bị khóa do gửi quá nhanh.
          </p>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 5. CỬA SỔ THEO DÕI ĐỒNG BỘ TRỰC TIẾP (LIVE SYNC TERMINAL MODAL)           */}
      {/* ========================================================================= */}
      {showSyncModal && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(3, 7, 18, 0.85)", backdropFilter: "blur(6px)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ width: "100%", maxWidth: 660, background: "#0d111a", border: "1px solid #1e293b", borderRadius: 16, overflow: "hidden", boxShadow: "0 24px 48px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "16px 20px", background: "#080c14", borderBottom: "1px solid #1e293b", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 20 }}>⚡</span>
                <span style={{ fontWeight: 800, fontSize: 15, color: "#f8fafc" }}>Tiến trình Đồng bộ Toàn diện Unbounded Engine</span>
              </div>
              <button
                onClick={() => setShowSyncModal(false)}
                disabled={isFullSyncing}
                style={{ background: "transparent", border: "none", color: "#94a3b8", fontSize: 18, cursor: isFullSyncing ? "not-allowed" : "pointer" }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: "18px 20px", borderBottom: "1px solid #1e293b", background: "#0d111a" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, fontSize: 13, color: "#cbd5e1" }}>
                <span>{isFullSyncing ? `Đang xử lý: ${syncCurrentName || "Zalo Master"}` : "✅ Đồng bộ thành công!"}</span>
                <span style={{ fontWeight: 800, color: "#10b981" }}>{syncPercent}%</span>
              </div>
              <div style={{ width: "100%", height: 8, background: "#1e293b", borderRadius: 4, overflow: "hidden" }}>
                <div
                  style={{
                    width: `${syncPercent}%`,
                    height: "100%",
                    background: "linear-gradient(90deg, #10b981, #38bdf8)",
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
            </div>

            <div style={{ height: 260, background: "#05080f", padding: "14px 18px", overflowY: "auto", fontFamily: "monospace", fontSize: 12, color: "#10b981", display: "flex", flexDirection: "column", gap: 6 }}>
              {syncLogs.map((line, idx) => (
                <div key={idx} style={{ lineHeight: 1.4, wordBreak: "break-word" }}>
                  {line}
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>

            <div style={{ padding: "14px 20px", background: "#080c14", borderTop: "1px solid #1e293b", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 11.5, color: "#64748b" }}>
                {isFullSyncing ? "⚡ Đang trích xuất toàn bộ hội thoại & media..." : "100% dữ liệu đã được lưu vào Server Volume."}
              </span>
              <button
                onClick={() => setShowSyncModal(false)}
                disabled={isFullSyncing}
                style={{
                  padding: "8px 20px",
                  background: isFullSyncing ? "#334155" : "linear-gradient(135deg, #10b981, #059669)",
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: isFullSyncing ? "wait" : "pointer",
                }}
              >
                {isFullSyncing ? "⏳ Đang chạy..." : "Đóng & Trải nghiệm Chat"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Xem ảnh phóng to */}
      {previewImage && (
        <div
          onClick={() => setPreviewImage(null)}
          style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.9)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
        >
          <img src={previewImage} alt="Large preview" style={{ maxWidth: "90%", maxHeight: "90%", borderRadius: 10, boxShadow: "0 20px 40px rgba(0,0,0,0.8)" }} />
        </div>
      )}
    </div>
  );
}
