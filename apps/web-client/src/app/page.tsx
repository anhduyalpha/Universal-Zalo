"use client";

import React, { useState, useEffect, useRef } from "react";
import { db, seedInitialConversations, LocalMessage, Conversation, MessageType } from "../lib/dexie_db";
import { useLiveQuery } from "dexie-react-hooks";
import { nanoid } from "nanoid";
import { ConversationSidebar } from "../components/ConversationSidebar";
import { ChatHeader } from "../components/ChatHeader";
import { ChatInput } from "../components/ChatInput";
import { MessageItem } from "../components/MessageItem";
import { MediaViewer } from "../components/MediaViewer";
import { SettingsModal } from "../components/SettingsModal";
import { soundFX } from "../lib/sound_effects";
import { registerServiceWorker, showLocalNotification } from "../lib/push_manager";
import { MessageSquare, ArrowLeft, WifiOff, AlertTriangle } from "lucide-react";

export default function UniversalZaloPWA() {
  const [activeConvId, setActiveConvId] = useState<string>("general");
  const [wsStatus, setWsStatus] = useState<"CONNECTED" | "DISCONNECTED" | "CONNECTING">("CONNECTING");
  const [showMobileSidebar, setShowMobileSidebar] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [activeMedia, setActiveMedia] = useState<{ type: "IMAGE" | "VIDEO"; src: string; name?: string } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Live queries from Dexie.js (Offline First)
  const conversations = useLiveQuery(() => db.conversations.orderBy("lastTimestamp").reverse().toArray(), []) || [];
  const activeConversation = conversations.find((c) => c.id === activeConvId);

  const messages = useLiveQuery(
    () => db.messages.where("conversationId").equals(activeConvId).sortBy("timestamp"),
    [activeConvId]
  ) || [];

  // Handle Mobile Resize
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Initialize DB & Service Worker
  useEffect(() => {
    seedInitialConversations();
    registerServiceWorker();
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Mark unread messages as read when opening conversation
  useEffect(() => {
    if (activeConvId) {
      db.conversations.update(activeConvId, { unreadCount: 0 });
    }
  }, [activeConvId]);

  // WebSocket Connection with Auto-reconnect
  useEffect(() => {
    let isSubscribed = true;

    const connectWS = () => {
      if (!isSubscribed) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.hostname || "127.0.0.1";
      const wsUrl = process.env.NEXT_PUBLIC_WS_URL || `${protocol}//${host}:8080`;

      setWsStatus("CONNECTING");
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isSubscribed) return;
        setWsStatus("CONNECTED");
      };

      ws.onclose = () => {
        if (!isSubscribed) return;
        setWsStatus("DISCONNECTED");
        // Reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(connectWS, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.event === "MESSAGE_FANOUT") {
            const targetConvId = data.conversationId || "general";
            const now = data.hlc?.physicalTime || Date.now();

            // 1. Add to local messages
            await db.messages.add({
              msgId: data.msgId,
              conversationId: targetConvId,
              textContent: data.textContent || "",
              sender: "OTHER",
              senderName: data.senderName || "Người gửi Zalo",
              status: "DELIVERED",
              timestamp: now,
              type: data.type || "TEXT",
              mediaUrl: data.mediaUrl,
              mediaName: data.mediaName,
              mediaSize: data.mediaSize,
              mediaDuration: data.mediaDuration,
              stickerUrl: data.stickerUrl,
            });

            // 2. Update conversation snippet
            const snippet = data.type === "STICKER" ? "[Sticker]" : data.type === "IMAGE" ? "[Hình ảnh]" : data.type === "VOICE" ? "[Tin nhắn thoại]" : data.type === "FILE" ? `[Tệp] ${data.mediaName || ""}` : (data.textContent || "Tin nhắn mới");

            const conv = await db.conversations.get(targetConvId);
            if (conv) {
              await db.conversations.update(targetConvId, {
                lastMessage: snippet,
                lastTimestamp: now,
                unreadCount: activeConvId === targetConvId ? 0 : (conv.unreadCount || 0) + 1,
              });
            } else {
              await db.conversations.add({
                id: targetConvId,
                name: data.senderName || `Người dùng ${targetConvId.slice(0, 6)}`,
                avatar: `https://api.dicebear.com/7.x/adventurer/svg?seed=${targetConvId}`,
                type: "DIRECT",
                lastMessage: snippet,
                lastTimestamp: now,
                unreadCount: activeConvId === targetConvId ? 0 : 1,
                isOnline: true,
              });
            }

            // 3. Audio & Notification Feedback
            soundFX.playReceive();
            showLocalNotification(data.senderName || "Universal Zalo", snippet, undefined, targetConvId);
          }
        } catch (e) {
          console.error("Failed to parse websocket frame:", e);
        }
      };
    };

    connectWS();

    return () => {
      isSubscribed = false;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [activeConvId]);

  // Handle Send Message
  const handleSendMessage = async (payload: {
    type: MessageType;
    textContent?: string;
    mediaUrl?: string;
    mediaName?: string;
    mediaSize?: number;
    mediaDuration?: number;
    stickerUrl?: string;
  }) => {
    const tempMsgId = nanoid();
    const now = Date.now();

    // 1. Optimistic insert to Dexie IndexedDB
    await db.messages.add({
      msgId: tempMsgId,
      conversationId: activeConvId,
      textContent: payload.textContent || "",
      sender: "ME",
      status: "SENDING",
      timestamp: now,
      type: payload.type,
      mediaUrl: payload.mediaUrl,
      mediaName: payload.mediaName,
      mediaSize: payload.mediaSize,
      mediaDuration: payload.mediaDuration,
      stickerUrl: payload.stickerUrl,
    });

    // 2. Update conversation preview
    const snippet = payload.type === "STICKER" ? "[Sticker]" : payload.type === "IMAGE" ? "[Hình ảnh]" : payload.type === "VOICE" ? "[Tin nhắn thoại]" : payload.type === "FILE" ? `[Tệp] ${payload.mediaName || ""}` : (payload.textContent || "");

    await db.conversations.update(activeConvId, {
      lastMessage: `Bạn: ${snippet}`,
      lastTimestamp: now,
    });

    // 3. Play pop sound
    soundFX.playSend();

    // 4. Send through WebSocket to Gateway Hub
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "SEND_MESSAGE",
          conversationId: activeConvId,
          textContent: payload.textContent,
          messageType: payload.type,
          mediaUrl: payload.mediaUrl,
          mediaName: payload.mediaName,
          mediaSize: payload.mediaSize,
          mediaDuration: payload.mediaDuration,
          stickerUrl: payload.stickerUrl,
          idempotencyKey: tempMsgId,
        })
      );
    }
  };

  return (
    <div
      style={{
        display: "flex",
        height: "100dvh",
        width: "100vw",
        backgroundColor: "#f0f2f5",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* Lightbox Media Viewer */}
      {activeMedia && (
        <MediaViewer
          type={activeMedia.type}
          src={activeMedia.src}
          name={activeMedia.name}
          onClose={() => setActiveMedia(null)}
        />
      )}

      {/* Settings Modal */}
      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} wsStatus={wsStatus} />
      )}

      {/* Conversation Sidebar (Desktop & Mobile Drawer) */}
      <ConversationSidebar
        conversations={conversations}
        activeId={activeConvId}
        onSelect={(id) => {
          setActiveConvId(id);
          setShowMobileSidebar(false);
        }}
        onToggleSettings={() => setShowSettings(true)}
        isMobile={isMobile}
        isOpen={!isMobile || showMobileSidebar}
        onCloseMobile={() => setShowMobileSidebar(false)}
      />

      {/* Main Chat Area */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          height: "100%",
          backgroundColor: "#f8fafc",
          position: "relative",
          minWidth: 0,
        }}
      >
        {/* Offline / Reconnecting Banner */}
        {wsStatus !== "CONNECTED" && (
          <div
            style={{
              padding: "6px 16px",
              backgroundColor: wsStatus === "CONNECTING" ? "#fef3c7" : "#fee2e2",
              color: wsStatus === "CONNECTING" ? "#92400e" : "#991b1b",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              fontWeight: 500,
              zIndex: 20,
            }}
          >
            {wsStatus === "CONNECTING" ? (
              <>
                <AlertTriangle size={14} /> Đang kết nối lại với Gateway Hub...
              </>
            ) : (
              <>
                <WifiOff size={14} /> Mất kết nối Gateway Hub. Tin nhắn sẽ tự động gửi khi online trở lại.
              </>
            )}
          </div>
        )}

        {/* Chat Header */}
        <ChatHeader
          conversation={activeConversation}
          wsStatus={wsStatus}
          onToggleSidebar={() => setShowMobileSidebar(!showMobileSidebar)}
          onOpenInfo={() => setShowSettings(true)}
          isMobile={isMobile}
        />

        {/* Messages Scroll Area */}
        <div
          style={{
            flex: 1,
            padding: "16px 20px",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {messages.length === 0 ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                color: "#94a3b8",
                gap: 12,
              }}
            >
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: "50%",
                  backgroundColor: "#e0f2fe",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#0068ff",
                }}
              >
                <MessageSquare size={32} />
              </div>
              <div style={{ fontWeight: 600, fontSize: 15, color: "#475569" }}>
                Chưa có tin nhắn trong cuộc trò chuyện này
              </div>
              <div style={{ fontSize: 13, maxWidth: 300, textAlign: "center" }}>
                Hãy gửi tin nhắn, hình ảnh hoặc sticker đầu tiên để bắt đầu!
              </div>
            </div>
          ) : (
            messages.map((m) => (
              <MessageItem
                key={m.msgId || m.id}
                message={m}
                onOpenMedia={(type, src, name) => setActiveMedia({ type, src, name })}
              />
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Bar */}
        <ChatInput onSendMessage={handleSendMessage} disabled={false} />
      </div>
    </div>
  );
}
