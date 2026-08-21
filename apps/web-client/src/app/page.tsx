"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  db,
  LocalMessage,
  Conversation,
  Contact,
  deduplicateById,
  MessageReaction,
  MentionToken,
} from "@/lib/dexie_db";
import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { nanoid } from "nanoid";

// ==========================================
// 1. HELPER COMPONENTS & RENDERERS
// ==========================================

function AvatarWithFallback({
  name,
  src,
  size = 40,
  isGroup = false,
  contactId,
}: {
  name: string;
  src?: string;
  size?: number;
  isGroup?: boolean;
  contactId?: string;
}) {
  const [hasError, setHasError] = useState(false);
  const cleanName = (name || "Zalo").trim();
  const initial = cleanName.charAt(0).toUpperCase() || "Z";

  // Proxy avatar thông qua Gateway Hub để tránh lỗi 403 CDN Hotlink & hết hạn Token
  const effectiveSrc = useMemo(() => {
    if (contactId && !hasError) {
      return `/api/media/avatar?id=${encodeURIComponent(contactId)}&name=${encodeURIComponent(cleanName)}`;
    }
    if (src && !hasError && !src.includes("dicebear")) {
      if (src.startsWith("http") && !src.startsWith(window.location.origin)) {
        return `/api/media/proxy?url=${encodeURIComponent(src)}&name=${encodeURIComponent(cleanName)}`;
      }
      return src;
    }
    return null;
  }, [src, hasError, cleanName, contactId]);

  if (effectiveSrc && !hasError) {
    return (
      <img
        src={effectiveSrc}
        alt={cleanName}
        onError={() => setHasError(true)}
        style={{
          width: size,
          height: size,
          borderRadius: isGroup ? 12 : "50%",
          objectFit: "cover",
          flexShrink: 0,
          border: "1px solid rgba(255,255,255,0.1)",
        }}
      />
    );
  }

  const colors = ["#0068ff", "#10b981", "#8b5cf6", "#f59e0b", "#ec4899", "#3b82f6", "#06b6d4"];
  let hash = 0;
  for (let i = 0; i < cleanName.length; i++) {
    hash = cleanName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const bg = colors[Math.abs(hash) % colors.length];

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: isGroup ? 12 : "50%",
        background: bg,
        color: "#ffffff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 800,
        fontSize: size * 0.42,
        flexShrink: 0,
        border: "1px solid rgba(255,255,255,0.15)",
        boxShadow: "0 2px 6px rgba(0,0,0,0.2)",
      }}
    >
      {initial}
    </div>
  );
}

function AudioVoicePlayer({ src, isMe }: { src: string; isMe: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration || 0);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (audioRef.current) {
      audioRef.current.currentTime = val;
      setCurrentTime(val);
    }
  };

  const formatTime = (secs: number) => {
    if (isNaN(secs) || secs < 0) return "0:00";
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        background: isMe ? "rgba(255,255,255,0.15)" : "rgba(15, 23, 42, 0.6)",
        borderRadius: 14,
        minWidth: 220,
        maxWidth: 280,
        marginBottom: 4,
        border: "1px solid rgba(255,255,255,0.1)",
      }}
    >
      <audio
        ref={audioRef}
        src={src}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={() => setIsPlaying(false)}
        preload="metadata"
      />
      <button
        type="button"
        onClick={togglePlay}
        style={{
          width: 34,
          height: 34,
          borderRadius: "50%",
          background: isMe ? "#ffffff" : "#10b981",
          color: isMe ? "#0068ff" : "#ffffff",
          border: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          fontSize: 14,
          fontWeight: "bold",
          flexShrink: 0,
          boxShadow: "0 2px 6px rgba(0,0,0,0.2)",
        }}
      >
        {isPlaying ? "⏸" : "▶"}
      </button>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
        <input
          type="range"
          min={0}
          max={duration || 100}
          value={currentTime}
          onChange={handleSeek}
          style={{
            width: "100%",
            accentColor: isMe ? "#ffffff" : "#10b981",
            cursor: "pointer",
            height: 4,
          }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, opacity: 0.8, color: isMe ? "#ffffff" : "#94a3b8" }}>
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>
    </div>
  );
}

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

  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = text.split(urlRegex);

  return (
    <div style={{ wordBreak: "break-word", lineHeight: 1.5, fontSize: 13.5 }}>
      {parts.map((part, i) => {
        if (part.match(urlRegex)) {
          return (
            <a
              key={i}
              href={part}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: isMe ? "#ffffff" : "#38bdf8",
                textDecoration: "underline",
                fontWeight: 600,
              }}
            >
              {part}
            </a>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </div>
  );
}

function FileAttachmentCard({
  name,
  size,
  url,
  isMe,
}: {
  name?: string;
  size?: number;
  url: string;
  isMe: boolean;
}) {
  const formatSize = (bytes?: number) => {
    if (!bytes) return "Tệp đính kèm";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <a
      href={url}
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

// ==========================================
// 2. MAIN APPLICATION COMPONENT
// ==========================================

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

  // Hydration Gatekeeper State
  const [hydrationState, setHydrationState] = useState<{
    state: "COLD_START" | "STAGING_INGESTION" | "INTEGRITY_CHECK" | "HYDRATED";
    progress: number;
    message: string;
  }>({ state: "HYDRATED", progress: 100, message: "" });

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

  // Lấy dữ liệu từ IndexedDB (Dexie 3NF Model)
  const rawConversations = useLiveQuery(() => db.conversations.toArray(), []) || [];
  const localConversations = deduplicateById(rawConversations);

  const rawContacts = useLiveQuery(() => db.contacts.toArray(), []) || [];
  const contactMap = useMemo(() => new Map(rawContacts.map((c) => [c.id, c])), [rawContacts]);

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

      const resContacts = await fetch("/api/contacts");
      if (resContacts.ok) {
        const liveContacts: Contact[] = await resContacts.json();
        if (Array.isArray(liveContacts) && liveContacts.length > 0) {
          for (const ct of liveContacts) {
            try { await db.contacts.put(ct); } catch {}
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
                senderId: msg.senderId || (msg.sender === "ME" ? "ME" : convId),
                senderName: msg.senderName,
                senderAvatar: msg.senderAvatar,
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

  // Kích hoạt SSE Hydration Status Listener
  useEffect(() => {
    let evtSource: EventSource | null = null;
    try {
      evtSource = new EventSource("/api/sync/status");
      evtSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data && data.state) {
            setHydrationState(data);
          }
        } catch (err) {}
      };
    } catch (err) {}

    return () => {
      evtSource?.close();
    };
  }, []);

  // WebSocket Connection & Real-time Listeners
  useEffect(() => {
    fetchLiveConversations();
    const timer = setTimeout(() => {
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
          setSyncLogs((prev) => [...prev, "🎉 Đã hoàn tất đối soát và tráo đổi Staging sang Production!"]);
          if (data.dumpResult?.conversations && data.dumpResult?.messagesByConversation) {
            await db.reconcileFullState(
              data.dumpResult.conversations,
              data.dumpResult.messagesByConversation,
              data.dumpResult.contacts || []
            );
          }
          setIsLoadingConversations(false);
          setTimeout(() => {
            setIsFullSyncing(false);
          }, 1500);
        }

        if (data.event === "OUTBOUND_STATUS_UPDATE") {
          if (data.clientMsgId) {
            const msg = await db.messages.get(data.clientMsgId);
            if (msg) {
              await db.messages.update(data.clientMsgId, {
                status: data.status === "SENT" ? "DELIVERED" : "FAILED",
              });
            }
          }
        }

        if (data.event === "CDC_EVENT") {
          if (data.table === "messages" && data.data) {
            const msg = data.data;
            try {
              await db.messages.put({
                msgId: msg.msgId,
                conversationId: msg.conversationId,
                senderId: msg.senderId || (msg.sender === "ME" ? "ME" : msg.conversationId),
                senderName: msg.senderName,
                senderAvatar: msg.senderAvatar,
                textContent: msg.textContent,
                sender: msg.sender,
                status: msg.status || "DELIVERED",
                timestamp: msg.timestamp || Date.now(),
                type: msg.type || "TEXT",
                mediaUrl: msg.mediaUrl,
                mediaName: msg.mediaName,
                mediaSize: msg.mediaSize,
                reactions: msg.reactions,
                mentions: msg.mentions,
              });
              await db.conversations.update(msg.conversationId, {
                lastMessage: msg.textContent || `[${msg.type || "Media"}]`,
                lastTimestamp: msg.timestamp || Date.now(),
              });
            } catch {}
          } else if (data.table === "conversations" && data.data) {
            try {
              await db.conversations.put(data.data);
            } catch {}
          } else if (data.table === "contacts" && data.data) {
            try {
              await db.contacts.put(data.data);
            } catch {}
          }
        }

        if (data.event === "MESSAGE_FANOUT") {
          const convId = data.conversationId || activeConvId || "general";
          try {
            await db.messages.put({
              msgId: data.msgId,
              conversationId: convId,
              senderId: data.senderId || (data.sender === "ME" ? "ME" : convId),
              senderName: data.senderName,
              senderAvatar: data.senderAvatar,
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

    const intervalTimer = setInterval(fetchLiveConversations, 10000);

    return () => {
      clearTimeout(timer);
      clearInterval(intervalTimer);
      ws.close();
    };
  }, []);

  const handleSendMessage = async (retryText?: string, retryMsgId?: string) => {
    const textToSend = retryText || inputText;
    if (!textToSend.trim()) return;

    const clientMsgId = retryMsgId || nanoid();
    const targetId = activeConvId || "general";

    // 1. Optimistic Local Insert (SENDING)
    await db.messages.put({
      msgId: clientMsgId,
      conversationId: targetId,
      senderId: "ME",
      textContent: textToSend,
      sender: "ME",
      status: "SENDING",
      timestamp: Date.now(),
      type: "TEXT",
    });

    if (!retryText) {
      setInputText("");
    }

    // 2. Dispatch qua Headless WebSocket/API
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "SEND_MESSAGE",
          targetId: targetId,
          conversationId: targetId,
          clientMsgId,
          textContent: textToSend,
        })
      );
    } else {
      // Fallback sang REST API
      fetch("/api/outbound/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId, content: textToSend, clientMsgId }),
      }).catch(() => {});
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result as string;
        const res = await fetch("/api/outbound/media", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetId: activeConvId,
            conversationId: activeConvId,
            filename: file.name,
            data: base64,
          }),
        });

        if (res.ok) {
          const json = await res.json();
          await db.messages.put({
            msgId: json.msgId || nanoid(),
            conversationId: activeConvId,
            senderId: "ME",
            textContent: "",
            sender: "ME",
            status: "DELIVERED",
            timestamp: Date.now(),
            type: "IMAGE",
            mediaUrl: json.url,
            mediaName: file.name,
            mediaSize: file.size,
          });
        }
        setUploading(false);
      };
      reader.readAsDataURL(file);
    } catch (e) {
      setUploading(false);
    }
  };

  const handleTriggerLiveSync = () => {
    setIsFullSyncing(true);
    setShowSyncModal(true);
    setSyncPercent(5);
    setSyncLogs(["🚀 Đang mở phiên Blue/Green Staging & trích xuất toàn bộ dữ liệu..."]);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "START_LIVE_SYNC" }));
    } else {
      fetch("/api/sync/full-resync", { method: "POST" })
        .then((res) => res.json())
        .then((dumpResult) => {
          if (dumpResult?.conversations && dumpResult?.messagesByConversation) {
            db.reconcileFullState(
              dumpResult.conversations,
              dumpResult.messagesByConversation,
              dumpResult.contacts || []
            );
          }
          setSyncPercent(100);
          setSyncLogs((prev) => [...prev, "🎉 Hoàn tất đồng bộ toàn diện!"]);
          setTimeout(() => setIsFullSyncing(false), 1500);
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
        width: "100vw",
        height: viewportHeight,
        background: "#080c14",
        color: "#f8fafc",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        overflow: "hidden",
        position: "fixed",
        top: 0,
        left: 0,
      }}
    >
      {/* ========================================================================= */}
      {/* 0. HYDRATION GATEKEEPER MODAL (Phase 2 Offline-First Pre-Fetch Screen)     */}
      {/* ========================================================================= */}
      {hydrationState.state !== "HYDRATED" && localConversations.length === 0 && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(8, 12, 20, 0.95)",
            backdropFilter: "blur(12px)",
            zIndex: 9999,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            textAlign: "center",
          }}
        >
          <div
            style={{
              width: 480,
              maxWidth: "90%",
              background: "#0d111a",
              border: "1px solid #1e293b",
              borderRadius: 20,
              padding: 32,
              boxShadow: "0 20px 50px rgba(0,0,0,0.6)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
            }}
          >
            <div style={{ fontSize: 44 }}>⚡</div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#f8fafc" }}>
              Đang Chuẩn Bị Dữ Liệu Offline-First
            </h2>
            <p style={{ margin: 0, fontSize: 13, color: "#94a3b8", lineHeight: 1.6 }}>
              {hydrationState.message || "Đang trích xuất toàn bộ dữ liệu vào Staging Partition & kiểm tra toàn vẹn quan hệ..."}
            </p>

            <div style={{ width: "100%", height: 8, background: "#1e293b", borderRadius: 4, overflow: "hidden", marginTop: 8 }}>
              <div
                style={{
                  width: `${hydrationState.progress || 30}%`,
                  height: "100%",
                  background: "linear-gradient(90deg, #0068ff, #10b981)",
                  transition: "width 0.3s ease",
                }}
              />
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#10b981" }}>
              TIẾN TRÌNH: {hydrationState.progress || 30}% ({hydrationState.state})
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 1. THANH ĐIỀU HƯỚNG DỌC (CỘT 1 - NAVIGATION SIDEBAR)                       */}
      {/* ========================================================================= */}
      <div
        style={{
          width: 68,
          background: "#06090e",
          borderRight: "1px solid #1e293b",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "16px 0",
          gap: 20,
          flexShrink: 0,
          boxSizing: "border-box",
        }}
      >
        {/* Brand Logo */}
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 14,
            background: "linear-gradient(135deg, #10b981, #059669)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 900,
            fontSize: 22,
            color: "#ffffff",
            boxShadow: "0 4px 14px rgba(16, 185, 129, 0.4)",
            cursor: "pointer",
          }}
        >
          Z
        </div>

        {/* Tab Icons */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", alignItems: "center" }}>
          <button
            onClick={() => setNavTab("MESSAGES")}
            title="Tin nhắn"
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: navTab === "MESSAGES" ? "rgba(16, 185, 129, 0.15)" : "transparent",
              color: navTab === "MESSAGES" ? "#10b981" : "#64748b",
              border: navTab === "MESSAGES" ? "1px solid rgba(16, 185, 129, 0.3)" : "none",
              fontSize: 20,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "all 0.2s",
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
              background: navTab === "CONTACTS" ? "rgba(16, 185, 129, 0.15)" : "transparent",
              color: navTab === "CONTACTS" ? "#10b981" : "#64748b",
              border: navTab === "CONTACTS" ? "1px solid rgba(16, 185, 129, 0.3)" : "none",
              fontSize: 20,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "all 0.2s",
            }}
          >
            👥
          </button>
          <button
            onClick={() => setNavTab("AUTOMATION")}
            title="Tự động hóa"
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: navTab === "AUTOMATION" ? "rgba(16, 185, 129, 0.15)" : "transparent",
              color: navTab === "AUTOMATION" ? "#10b981" : "#64748b",
              border: navTab === "AUTOMATION" ? "1px solid rgba(16, 185, 129, 0.3)" : "none",
              fontSize: 20,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "all 0.2s",
            }}
          >
            ⚡
          </button>
        </div>

        {/* Bottom Status & Avatar */}
        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
          <Link
            href="/session"
            title="Master Chromium Live View"
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              background: "rgba(56, 189, 248, 0.1)",
              border: "1px solid rgba(56, 189, 248, 0.3)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              textDecoration: "none",
              color: "#38bdf8",
            }}
          >
            🖥️
          </Link>
          <div
            title={`Trạng thái: ${wsStatus}`}
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
            HỘP THƯ ZALO (3NF)
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

        {/* Danh Sách Hội Thoại Scrollable */}
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {isLoadingConversations ? (
            <div style={{ padding: "30px 20px", textAlign: "center", color: "#94a3b8" }}>
              <div style={{ fontSize: 24, marginBottom: 8 }}>⏳</div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Đang tải danh sách hội thoại từ Server...</div>
            </div>
          ) : filteredConversations.length === 0 ? (
            <div style={{ padding: "30px 20px", textAlign: "center", color: "#64748b" }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📭</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8" }}>Không tìm thấy hội thoại</div>
              <button
                onClick={handleTriggerLiveSync}
                style={{
                  marginTop: 12,
                  padding: "6px 14px",
                  background: "#10b981",
                  border: "none",
                  borderRadius: 8,
                  color: "#ffffff",
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
                    gap: 12,
                    padding: "12px 18px",
                    background: isSelected ? "rgba(16, 185, 129, 0.12)" : "transparent",
                    borderLeft: isSelected ? "3px solid #10b981" : "3px solid transparent",
                    borderBottom: "1px solid rgba(30, 41, 59, 0.6)",
                    cursor: "pointer",
                    transition: "background 0.15s ease",
                  }}
                >
                  <div style={{ position: "relative" }}>
                    <AvatarWithFallback name={conv.name} src={conv.avatar} size={42} isGroup={isGroup} contactId={!isGroup ? conv.id : undefined} />
                    {conv.isOnline && (
                      <span
                        style={{
                          position: "absolute",
                          bottom: 0,
                          right: 0,
                          width: 10,
                          height: 10,
                          borderRadius: "50%",
                          background: "#10b981",
                          border: "2px solid #0d111a",
                        }}
                      />
                    )}
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3 }}>
                      <div
                        style={{
                          fontSize: 13.5,
                          fontWeight: isSelected ? 800 : 600,
                          color: isSelected ? "#ffffff" : "#f1f5f9",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <span>{conv.name}</span>
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
              <AvatarWithFallback name={currentActiveConv.name} src={currentActiveConv.avatar} size={38} isGroup={currentActiveConv.type === "GROUP"} contactId={currentActiveConv.type === "DIRECT" ? currentActiveConv.id : undefined} />
              <div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#f8fafc", display: "flex", alignItems: "center", gap: 8 }}>
                  <span>{currentActiveConv.name}</span>
                  <span style={{ fontSize: 10, background: "rgba(0, 104, 255, 0.2)", color: "#38bdf8", border: "1px solid rgba(56, 189, 248, 0.3)", padding: "1px 6px", borderRadius: 6, fontWeight: 700 }}>
                    ZALO 3NF
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "#64748b" }}>
                  ID: <span style={{ fontFamily: "monospace", color: "#94a3b8" }}>{currentActiveConv.id}</span> • Phân định chuẩn Author/Container
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

        {/* Message Stream Area với Họa Tiết Grid Kỹ Thuật (Dark Grid Pattern) */}
        <div
          style={{
            flex: 1,
            padding: "16px 24px",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 14,
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
                Chưa có tin nhắn lưu trong database
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

              // 3NF SENDER RESOLUTION: Giải mã thông tin tác giả thực sự từ contacts table
              const senderContact = m.senderId ? contactMap.get(m.senderId) : undefined;
              const authorName = senderContact?.displayName || m.senderName || (currentActiveConv?.type === "DIRECT" ? currentActiveConv.name : `Thành viên ${m.senderId ? m.senderId.slice(-4) : "Zalo"}`);
              const isGroup = currentActiveConv?.type === "GROUP";

              return (
                <div
                  key={m.msgId}
                  style={{
                    alignSelf: isMe ? "flex-end" : "flex-start",
                    maxWidth: "72%",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    flexDirection: isMe ? "row-reverse" : "row",
                  }}
                >
                  {/* Author Avatar (3NF Strict Resolution) */}
                  {!isMe && (
                    <AvatarWithFallback
                      name={authorName}
                      src={senderContact?.avatarUrl || m.senderAvatar}
                      contactId={m.senderId}
                      size={32}
                    />
                  )}

                  <div style={{ display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start" }}>
                    {/* Tên người gửi trong Group Chat */}
                    {!isMe && isGroup && (
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#38bdf8", marginBottom: 3, paddingLeft: 4 }}>
                        {authorName}
                      </span>
                    )}

                    <div
                      style={{
                        background: isMe
                          ? m.status === "FAILED"
                            ? "linear-gradient(135deg, #7f1d1d, #991b1b)"
                            : "linear-gradient(135deg, #0068ff, #0052cc)"
                          : "#161f30",
                        color: "#ffffff",
                        padding: "10px 16px",
                        borderRadius: 16,
                        borderBottomRightRadius: isMe ? 2 : 16,
                        borderBottomLeftRadius: isMe ? 16 : 2,
                        boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
                        border: isMe
                          ? m.status === "FAILED"
                            ? "1px solid #ef4444"
                            : "1px solid rgba(255,255,255,0.15)"
                          : "1px solid #243048",
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

                      {/* Timestamp & Outbound Status */}
                      <div style={{ fontSize: 10, color: isMe ? "rgba(255,255,255,0.7)" : "#64748b", marginTop: 4, textAlign: "right", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 4 }}>
                        <span>{new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                        {isMe && (
                          <span>
                            {m.status === "SENDING" ? "⏳" : m.status === "FAILED" ? "⚠️ Lỗi" : "✓✓"}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Nút Retry nếu tin nhắn gửi thất bại */}
                    {isMe && m.status === "FAILED" && (
                      <button
                        onClick={() => handleSendMessage(m.textContent, m.msgId)}
                        style={{
                          marginTop: 4,
                          background: "#ef4444",
                          border: "none",
                          borderRadius: 6,
                          color: "#ffffff",
                          fontSize: 10.5,
                          fontWeight: 700,
                          padding: "2px 8px",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          gap: 3,
                        }}
                      >
                        🔄 Thử lại
                      </button>
                    )}

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
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Thanh Trả Lời Nhanh (Quick Replies Toolbar) */}
        <div
          style={{
            padding: "8px 20px",
            background: "#0d111a",
            borderTop: "1px solid #1e293b",
            display: "flex",
            gap: 8,
            overflowX: "auto",
            flexShrink: 0,
          }}
        >
          {["[Mình kiểm tra ngay]", "[Cảm ơn bạn đã chờ]", "[Sẽ phản hồi sớm]", "[Đang xử lý yêu cầu]"].map((qr, idx) => (
            <button
              key={idx}
              onClick={() => setInputText((prev) => (prev ? `${prev} ${qr}` : qr))}
              style={{
                padding: "4px 10px",
                background: "#151c2c",
                border: "1px solid #243048",
                borderRadius: 8,
                fontSize: 11,
                fontWeight: 600,
                color: "#cbd5e1",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {qr}
            </button>
          ))}
        </div>

        {/* Khung Soạn Thảo Tin Nhắn (Composer Input Area) */}
        <div
          style={{
            padding: "12px 20px 16px 20px",
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
            onChange={handleFileUpload}
            style={{ display: "none" }}
            accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.zip"
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: "#151c2c",
              border: "1px solid #243048",
              color: "#94a3b8",
              fontSize: 18,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            {uploading ? "⏳" : "➕"}
          </button>

          <div style={{ flex: 1, position: "relative" }}>
            <input
              type="text"
              placeholder={`Nhập tin nhắn gửi tới ${currentActiveConv?.name || "Zalo"}...`}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSendMessage();
                }
              }}
              style={{
                width: "100%",
                padding: "10px 14px",
                background: "#151c2c",
                border: "1px solid #243048",
                borderRadius: 10,
                outline: "none",
                fontSize: 13.5,
                color: "#f8fafc",
                boxSizing: "border-box",
              }}
            />
          </div>

          <button
            onClick={() => handleSendMessage()}
            style={{
              padding: "10px 18px",
              background: "linear-gradient(135deg, #10b981, #059669)",
              border: "none",
              borderRadius: 10,
              color: "#ffffff",
              fontSize: 13,
              fontWeight: 800,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              boxShadow: "0 2px 8px rgba(16, 185, 129, 0.3)",
              flexShrink: 0,
            }}
          >
            Gửi ↗️
          </button>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 4. CỘT METADATA INSPECTOR (CỘT 4 - THÔNG TIN CHI TIẾT)                    */}
      {/* ========================================================================= */}
      <div
        style={{
          width: 280,
          background: "#080c14",
          borderLeft: "1px solid #1e293b",
          display: "flex",
          flexDirection: "column",
          padding: "20px 16px",
          gap: 16,
          flexShrink: 0,
          overflowY: "auto",
          boxSizing: "border-box",
        }}
      >
        {currentActiveConv ? (
          <>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 8, paddingBottom: 16, borderBottom: "1px solid #1e293b" }}>
              <AvatarWithFallback name={currentActiveConv.name} src={currentActiveConv.avatar} size={64} isGroup={currentActiveConv.type === "GROUP"} contactId={currentActiveConv.type === "DIRECT" ? currentActiveConv.id : undefined} />
              <div style={{ fontSize: 15, fontWeight: 800, color: "#f8fafc" }}>{currentActiveConv.name}</div>
              <div style={{ fontSize: 11, color: "#64748b" }}>Zalo {currentActiveConv.type === "GROUP" ? "Nhóm" : "Cá nhân"}</div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", color: "#10b981", textTransform: "uppercase" }}>
                THÔNG TIN KẾT NỐI (3NF)
              </div>
              <div style={{ background: "#0d111a", padding: "10px 12px", borderRadius: 10, border: "1px solid #1e293b", display: "flex", flexDirection: "column", gap: 6, fontSize: 11.5 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#64748b" }}>Thread ID:</span>
                  <span style={{ fontFamily: "monospace", color: "#94a3b8" }}>{currentActiveConv.id}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#64748b" }}>Loại:</span>
                  <span style={{ fontWeight: 700, color: "#f8fafc" }}>{currentActiveConv.type}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#64748b" }}>Tin nhắn:</span>
                  <span style={{ fontWeight: 700, color: "#10b981" }}>{activeMessages.length} tin</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#64748b" }}>Outbound:</span>
                  <span style={{ color: "#10b981", fontWeight: 700 }}>🟢 Headless Dispatch</span>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div style={{ color: "#64748b", fontSize: 12, textAlign: "center", marginTop: 40 }}>
            Chọn một hội thoại để xem thông tin chi tiết
          </div>
        )}
      </div>

      {/* Sync Modal Overlay */}
      {showSyncModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(6px)",
            zIndex: 999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
        >
          <div
            style={{
              width: 520,
              maxWidth: "95%",
              background: "#0d111a",
              border: "1px solid #1e293b",
              borderRadius: 18,
              padding: 24,
              boxShadow: "0 20px 50px rgba(0,0,0,0.6)",
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#f8fafc", display: "flex", alignItems: "center", gap: 8 }}>
                <span>⚡ Tiến Trình Đồng Bộ Blue/Green Staging</span>
              </div>
              {!isFullSyncing && (
                <button
                  onClick={() => setShowSyncModal(false)}
                  style={{ background: "transparent", border: "none", color: "#94a3b8", fontSize: 18, cursor: "pointer" }}
                >
                  ✕
                </button>
              )}
            </div>

            <div style={{ width: "100%", height: 8, background: "#1e293b", borderRadius: 4, overflow: "hidden" }}>
              <div
                style={{
                  width: `${syncPercent}%`,
                  height: "100%",
                  background: "linear-gradient(90deg, #0068ff, #10b981)",
                  transition: "width 0.3s ease",
                }}
              />
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#10b981" }}>
              {syncPercent}% {syncCurrentName && `- ${syncCurrentName}`}
            </div>

            <div
              style={{
                height: 180,
                background: "#080c14",
                borderRadius: 10,
                border: "1px solid #1e293b",
                padding: "10px 14px",
                overflowY: "auto",
                fontFamily: "monospace",
                fontSize: 11,
                color: "#cbd5e1",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {syncLogs.map((log, idx) => (
                <div key={idx}>{log}</div>
              ))}
              <div ref={logsEndRef} />
            </div>

            {!isFullSyncing && (
              <button
                onClick={() => setShowSyncModal(false)}
                style={{
                  padding: "10px",
                  background: "#10b981",
                  border: "none",
                  borderRadius: 10,
                  color: "#ffffff",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Đóng
              </button>
            )}
          </div>
        </div>
      )}

      {/* Image Preview Lightbox Modal */}
      {previewImage && (
        <div
          onClick={() => setPreviewImage(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.88)",
            backdropFilter: "blur(8px)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            cursor: "zoom-out",
          }}
        >
          <img
            src={previewImage}
            alt="Preview"
            style={{ maxWidth: "90%", maxHeight: "90%", borderRadius: 12, boxShadow: "0 10px 40px rgba(0,0,0,0.8)" }}
          />
        </div>
      )}
    </div>
  );
}
